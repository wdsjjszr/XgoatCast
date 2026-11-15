import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../src/modules/database/database.service';
import { AgoraAccountsService } from '../src/modules/agora/agora-accounts.service';
import { AgoraUsageService } from '../src/modules/agora/agora-usage.service';
import { AgoraService } from '../src/modules/agora/agora.service';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { SessionService } from '../src/modules/session/session.service';
import { EventBusService } from '../src/modules/events/events.service';
import { ServerAdminController } from '../src/modules/server-admin/server-admin.controller';
import { ShareController } from '../src/modules/share/share.controller';
import { SessionSseController } from '../src/modules/session/session-sse.controller';
import { DAY_MS, monthBounds, monthKey, utcDate } from '../src/modules/agora/agora-usage.math';

Logger.overrideLogger(false);
const publisher = '00000000-0000-4000-8000-000000000001';
const credentials = (key = 'a') => ({ label: `账号 ${key}`, enabled: true, appId: key.repeat(32), appCertificate: 'b'.repeat(32), customerId: `customer-${key}`, customerSecret: `secret-${key}` });
function fixture() {
  const cwd = process.cwd(), realFetch = global.fetch, realNow = Date.now;
  const root = mkdtempSync(join(tmpdir(), 'xgoat-spaces-')); process.chdir(root);
  let now = realNow(); Date.now = () => now;
  global.fetch = (async (input: any, options: any) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.agora.io') return realFetch(input, options);
    const [customer, secret] = Buffer.from(options.headers.Authorization.slice(6), 'base64').toString().split(':');
    const key = customer.slice(-1);
    if (secret !== `secret-${key}`) return new Response('', { status: 401 });
    if (url.pathname.endsWith('/projects')) return new Response(JSON.stringify({ projects: [{ id: `project-${key}`, vendor_key: key.repeat(32), status: 1 }] }));
    const fields = ['durationAudioAll', 'durationVideoHd', 'durationVideo1080P', 'durationVideo2K', 'durationVideo4K', 'durationVideoHdp'];
    const usages = [];
    for (let at = Date.parse(url.searchParams.get('from_date')!); at <= Date.parse(url.searchParams.get('to_date')!); at += DAY_MS) usages.push({ date: utcDate(at), usage: Object.fromEntries(fields.map(field => [field, 0])) });
    return new Response(JSON.stringify({ meta: Object.fromEntries(fields.map(field => [field, { unit: 'second' }])), usages }));
  }) as any;
  const db = new DatabaseService(), analytics = new AnalyticsService(db), accounts = new AgoraAccountsService(db), bus = new EventBusService(), usage = new AgoraUsageService(db, accounts, analytics, bus);
  const agora = new AgoraService(db), sessions = new SessionService(db, agora, bus, analytics, usage);
  const share = new ShareController(agora, sessions, db, analytics, usage);
  const controller = new ServerAdminController(db, analytics, accounts, usage);
  const a = db.createSpace({ platform: 'heychat', externalId: 'a', displayName: '空间 A', ownerId: 'owner-a' });
  const b = db.createSpace({ platform: 'heychat', externalId: 'b', displayName: '空间 B', ownerId: 'owner-b' });
  for (const space of [a, b]) db.updateServer(space.serverId, { bound: 1, passwordHash: bcrypt.hashSync('test-password', 4) });
  const params = (space = a) => ({ platform: 'heychat', externalId: space.externalId });
  const create = (space = a) => sessions.createSession({ platform: 'heychat', spaceId: space.serverId, externalSpaceId: space.externalId, externalChannelId: 'channel', sharerUserId: 'owner', sharerUsername: '测试共享者' });
  return { db, accounts, usage, sessions, share, bus, controller, a, b, params, create, root, realFetch, apiFetch: global.fetch,
    now: () => now, advance: (ms: number) => { now += ms; },
    baseline: () => ({ at: monthBounds(monthKey(now))[0], remainingStandardMinutes: 5000 }),
    close() { db.onModuleDestroy(); process.chdir(cwd); global.fetch = realFetch; Date.now = realNow; },
  };
}

test('legacy credentials migrate by private proof, stay usable without REST, and spare accounts never replace them', async () => {
  const f = fixture();
  try {
    const global = await f.accounts.save(undefined, { ...credentials(), baseline: f.baseline() });
    f.db.updateServer(f.a.serverId, { agoraAppId: global.app_id, agoraAppCertificate: global.app_certificate });
    f.db.updateServer(f.b.serverId, { agoraAppId: global.app_id, agoraAppCertificate: 'c'.repeat(32) });
    f.accounts.onModuleInit();
    assert.equal(f.accounts.forSpace(f.a.serverId)[0].id, global.id);
    assert.equal(f.accounts.forSpace(f.b.serverId).length, 0);
    assert.throws(() => f.accounts.updateLegacy(f.b.serverId, { agoraAppCertificate: 'd'.repeat(32) }));
    assert.equal(f.accounts.get(global.id).app_certificate, global.app_certificate);
    f.accounts.updateLegacy(f.b.serverId, { agoraAppId: 'e'.repeat(32), agoraAppCertificate: 'f'.repeat(32) });
    const legacy = f.usage.list(f.b.serverId)[0];
    assert.equal(legacy.projectId, ''); assert.equal(legacy.safeRemainingStandardMinutes, null);
    assert.equal(f.db.getServer(f.b.serverId)!.agoraAccountPoolEnabled, 0);
    await f.usage.runDue();
    assert.equal(f.accounts.get(legacy.id).sync_attempts, 0);
    await f.accounts.save(legacy.id, { label: '原账号备注', enabled: false, appId: legacy.appId, appCertificate: '******', customerId: '', customerSecret: '' }, f.b.serverId);
    assert.equal(f.accounts.get(legacy.id).app_certificate, 'f'.repeat(32));
    const token = new AgoraService(f.db).generateToken('legacy-channel', 1, 'publisher', f.b.serverId);
    assert.equal(token.appId, 'e'.repeat(32)); assert.ok(token.token);
    await f.controller.createAgoraAccount(f.params(f.b), credentials('d'));
    assert.equal(f.db.getServer(f.b.serverId)!.agoraAppId, 'e'.repeat(32));
    const s = f.create(f.b); f.sessions.startSharing(s.token, publisher);
    assert.throws(() => f.accounts.updateLegacy(f.b.serverId, { agoraAppCertificate: 'a'.repeat(32) }));
    assert.throws(() => f.controller.setAgoraAccountPool(f.params(f.b), true));
    assert.equal(f.db.getServer(f.b.serverId)!.agoraAccountPoolEnabled, 0);
  } finally { f.close(); }
});

test('space membership is checked for every operation and linking requires full valid credentials', async () => {
  const f = fixture();
  try {
    const account = await f.controller.createAgoraAccount(f.params(), { ...credentials(), baseline: f.baseline() });
    assert.deepEqual(f.controller.listAgoraAccounts(f.params(f.b)), []);
    await assert.rejects(f.controller.saveAgoraAccount(f.params(f.b), account.id, credentials()));
    await assert.rejects(f.controller.syncAgoraAccount(f.params(f.b), account.id));
    assert.throws(() => f.controller.unlinkAgoraAccount(f.params(f.b), account.id));
    for (const body of [{ accountId: account.id }, { ...credentials(), appCertificate: '******' }, { ...credentials(), customerSecret: 'wrong' }]) await assert.rejects(f.controller.createAgoraAccount(f.params(f.b), body));
    assert.deepEqual(f.controller.listAgoraAccounts(f.params(f.b)), []);
    const shared = await f.controller.createAgoraAccount(f.params(f.b), { ...credentials(), label: 'B 的公开备注', spaceId: f.a.serverId });
    assert.equal(shared.id, account.id); assert.equal(f.accounts.all().length, 1);
    await f.accounts.save(account.id, { ...credentials(), label: 'A 停用', enabled: false, appCertificate: '', customerSecret: '******' }, f.a.serverId);
    assert.equal(f.accounts.spaceAccount(f.b.serverId, account.id).enabled, 1);
    assert.equal(f.accounts.spaceAccount(f.b.serverId, account.id).label, 'B 的公开备注');
    assert.doesNotMatch(JSON.stringify(f.controller.listAgoraAccounts(f.params())), /secret-a|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|owner-b/);
    await assert.rejects(f.accounts.save(account.id, { ...credentials('c') }, f.a.serverId));
  } finally { f.close(); }
});

test('issued single-account tokens lock credentials; switching an idle space does not interrupt another space', async () => {
  const f = fixture();
  try {
    for (const space of [f.a, f.b]) f.accounts.updateLegacy(space.serverId, { agoraAppId: 'a'.repeat(32), agoraAppCertificate: 'b'.repeat(32) });
    const account = f.accounts.forSpace(f.a.serverId)[0], session = f.create(f.b);
    f.usage.recordTokenIdentity(session.id, account.app_id);
    assert.equal(f.db.getSessionById(session.id)!.agoraAccountId, account.id);
    assert.throws(() => f.accounts.updateLegacy(f.b.serverId, { agoraAppCertificate: 'c'.repeat(32) }));
    f.accounts.updateLegacy(f.a.serverId, { agoraAppId: 'd'.repeat(32), agoraAppCertificate: 'e'.repeat(32) });
    f.accounts.unlink(f.a.serverId, account.id);
    assert.equal(f.accounts.spaceAccount(f.b.serverId, account.id).id, account.id);
    assert.equal(f.db.getSessionById(session.id)!.agoraAppId, 'a'.repeat(32));
    assert.equal(f.db.getServer(f.b.serverId)!.agoraAppCertificate, 'b'.repeat(32));
    f.sessions.endSession(session.id, 'manual');
    f.accounts.updateLegacy(f.b.serverId, { agoraAppId: 'A'.repeat(32), agoraAppCertificate: 'B'.repeat(32) });
    const pending = f.create(f.b); f.usage.recordTokenIdentity(pending.id, 'A'.repeat(32));
    f.accounts.updateLegacy(f.b.serverId, { idleTimeoutSec: 120, agoraAppCertificate: '   ' });
    assert.equal(f.db.getServer(f.b.serverId)!.agoraAppId, 'A'.repeat(32));
    assert.equal(f.db.getServer(f.b.serverId)!.agoraAppCertificate, 'B'.repeat(32));
    f.sessions.endSession(pending.id, 'manual');
    await f.accounts.save(account.id, { ...credentials(), customerId: '', customerSecret: '', appCertificate: 'f'.repeat(32) }, f.b.serverId);
    assert.equal(f.db.getServer(f.b.serverId)!.agoraAppCertificate, 'f'.repeat(32));
    assert.equal(f.db.getServer(f.a.serverId)!.agoraAppCertificate, 'e'.repeat(32));
  } finally { f.close(); }
});

test('shared accounts use one ledger and retry budget; unlinking one space keeps the other live session', async () => {
  const f = fixture();
  try {
    f.advance(Date.parse('2026-11-15T04:00:00Z') - f.now());
    const account = await f.accounts.save(undefined, { ...credentials(), baseline: f.baseline() }, f.a.serverId);
    await f.accounts.save(undefined, { ...credentials(), label: 'B 的账号' }, f.b.serverId);
    const sessions = [f.create(), f.create(f.b)];
    for (const [index, s] of sessions.entries()) {
      f.db.updateSession(s.id, { agoraAccountId: account.id, agoraAppId: account.app_id });
      f.sessions.startSharing(s.token, publisher);
      f.usage.report(s.id, { role: 'publisher', clientId: `00000000-0000-4000-8000-00000000000${index + 1}`, presenceId: publisher, uid: 1, sequence: 1, online: true, video: false });
    }
    f.advance(10_000); f.usage.flush();
    const daily = f.db.integrationDatabase.prepare('SELECT * FROM agora_usage_daily WHERE account_id=?').all(account.id) as any[];
    assert.equal(daily.length, 1); assert.equal(daily[0].local_standard_seconds, 20);
    assert.throws(() => f.accounts.unlink(f.a.serverId, account.id));
    await assert.rejects(f.accounts.save(account.id, { ...credentials(), appCertificate: 'c'.repeat(32) }, f.a.serverId));
    f.sessions.endSession(sessions[0].id, 'manual');
    assert.equal(f.usage.list(f.a.serverId)[0].canUnlink, true);
    f.accounts.unlink(f.a.serverId, account.id);
    assert.equal(f.accounts.spaceAccount(f.b.serverId, account.id).id, account.id);
    assert.equal(f.db.getSessionById(sessions[1].id)!.status, 'active');
    const now = Date.parse(utcDate(f.now()) + 'T12:00:00+08:00');
    global.fetch = (async () => new Response('', { status: 503 })) as any;
    await f.usage.runDue(now); await f.usage.runDue(now + 61_000); await f.usage.runDue(now + 362_000);
    const restarted = new AgoraUsageService(f.db, f.accounts, {} as any);
    await restarted.runDue(now + 900_000);
    assert.equal(f.accounts.get(account.id).sync_attempts, 3);
    global.fetch = f.apiFetch;
    await f.accounts.save(undefined, { ...credentials(), label: 'A 重新关联' }, f.a.serverId);
    assert.equal(f.accounts.get(account.id).sync_attempts, 3);
    assert.equal(f.accounts.all().length, 1);
  } finally { f.close(); }
});

test('P2 schema upgrade preserves the single ledger and allows distinct unverified legacy accounts', () => {
  const cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'xgoat-account-migration-'));
  mkdirSync(join(root, 'data')); process.chdir(root);
  let db: DatabaseService | undefined;
  try {
    const old = new Database(join(root, 'data/xgoatcast.db'));
    old.exec(`CREATE TABLE agora_accounts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      app_id TEXT NOT NULL UNIQUE, app_certificate TEXT NOT NULL,
      customer_id TEXT NOT NULL UNIQUE, customer_secret TEXT NOT NULL, project_id TEXT NOT NULL UNIQUE,
      baselines_json TEXT NOT NULL DEFAULT '{}', sync_day TEXT NOT NULL DEFAULT '', sync_attempts INTEGER NOT NULL DEFAULT 0,
      next_sync_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER, last_sync_at INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'not_synced', sync_error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    );`);
    old.prepare('INSERT INTO agora_accounts(id,label,app_id,app_certificate,customer_id,customer_secret,project_id,sync_day,sync_attempts,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('existing', '旧账本', 'a'.repeat(32), 'b'.repeat(32), 'customer-a', 'secret-a', 'project-a', '2026-11-15', 3, 1);
    old.close(); db = new DatabaseService();
    let accounts = new AgoraAccountsService(db);
    for (const key of ['c', 'd']) {
      const space = db.createSpace({ platform: 'heychat', externalId: key, displayName: key, ownerId: 'owner' });
      db.updateServer(space.serverId, { agoraAppId: key.repeat(32), agoraAppCertificate: 'f'.repeat(32) });
    }
    accounts.onModuleInit(); assert.equal(accounts.all().length, 3);
    assert.equal(accounts.get('existing').sync_attempts, 3);
    assert.equal(accounts.all().filter(a => a.project_id == null && a.customer_id == null).length, 2);
    db.onModuleDestroy(); db = new DatabaseService(); accounts = new AgoraAccountsService(db); accounts.onModuleInit();
    assert.equal(accounts.all().length, 3); assert.equal(accounts.get('existing').sync_attempts, 3);
    assert.equal(accounts.forSpace('heychat:c').length, 1);
  } finally { db?.onModuleDestroy(); process.chdir(cwd); }
});

test('real HTTP auth rejects anonymous, foreign-space and forged account operations, including mixed-case routes', async () => {
  const f = fixture(); let child: ReturnType<typeof spawn> | undefined;
  try {
    const account = await f.controller.createAgoraAccount(f.params(), credentials());
    const session = f.create();
    const tokenA = f.controller.login(f.params(), { password: 'test-password' }).token;
    const tokenB = f.controller.login(f.params(f.b), { password: 'test-password' }).token;
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as any).port; listener.close(); await once(listener, 'close');
    const envFile = join(f.root, 'empty.env'); writeFileSync(envFile, '');
    child = spawn(process.execPath, ['--require', require.resolve('ts-node/register'), join(__dirname, '../src/main.ts')], {
      cwd: f.root, windowsHide: true,
      env: { ...process.env, TS_NODE_PROJECT: join(__dirname, '../tsconfig.json'), XGOAT_ENV_FILE: envFile, HOST: '127.0.0.1', PORT: String(port), SUPER_ADMIN_PASSWORD: 'test-super-password', KOOK_BOT_TOKEN: '', KOOK_VERIFY_TOKEN: '', KOOK_ENCRYPT_KEY: '', HEYCHAT_BOT_ID: '', HEYCHAT_BOT_TOKEN: '', QQ_APP_ID: '', QQ_APP_SECRET: '' },
    });
    let logs = ''; child.stdout?.on('data', chunk => { logs += chunk; }); child.stderr?.on('data', chunk => { logs += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 150 && child.exitCode === null; i++) {
      try { ready = (await f.realFetch(base + '/api/meta/admin-migration')).ok; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
    const call = (path: string, token = '', method = 'GET', body?: any) => f.realFetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const path = '/api/spaces/heychat/a/agora-accounts';
    assert.equal((await call(path)).status, 401);
    assert.equal((await call('/API/SPACES/heychat/a/AGORA-ACCOUNTS')).status, 401);
    assert.equal((await call(path, tokenB)).status, 403);
    assert.equal((await call('/api/spaces/heychat/b/agora-accounts/' + account.id, tokenB, 'PUT', credentials())).status, 404);
    assert.equal((await call('/api/spaces/heychat/b/agora-accounts/' + account.id + '/sync', tokenB, 'POST', {})).status, 404);
    assert.equal((await call('/api/spaces/heychat/b/agora-accounts/' + account.id, tokenB, 'DELETE')).status, 404);
    const own = await call(path, tokenA); assert.equal(own.status, 200); assert.equal(own.headers.get('cache-control'), 'no-store');
    assert.equal((await own.json())[0].id, account.id);
    assert.equal((await call('/api/super/agora-accounts', tokenA)).status, 403);
    assert.equal((await call('/api/spaces/heychat/a/agora-account-pool', tokenA, 'PUT', { enabled: true })).status, 400);
    assert.equal((await call('/api/spaces/heychat/a/config', tokenA, 'PUT', { agoraAccountPoolEnabled: 1, idleTimeoutSec: 120 })).status, 200);
    assert.equal((await (await call('/api/spaces/heychat/a/config', tokenA)).json()).agoraAccountPoolEnabled, false);
    assert.equal((await call('/api/share/preview')).status, 401);
    assert.equal((await call(path + '/' + account.id, tokenA, 'PUT', { ...credentials(), baseline: f.baseline() })).status, 200);
    assert.equal((await call('/api/spaces/heychat/a/agora-account-pool', tokenA, 'PUT', { enabled: true })).status, 200);
    const sharePath = '/api/share/';
    assert.equal((await (await call(sharePath + 'preview?t=' + session.token)).json()).appId, credentials().appId);
    assert.equal(f.db.getSessionById(session.id)!.agoraAccountId, null);
    assert.equal((await call(sharePath + 'token?t=' + session.token + '&role=subscriber')).status, 409);
    const published = await call(sharePath + 'token?t=' + session.token + '&role=publisher');
    assert.equal(published.status, 200);
    assert.equal((await published.json()).appId, credentials().appId);
    assert.equal(f.db.getSessionById(session.id)!.agoraAccountId, account.id);
    const viewed = await (await call(sharePath + 'token?t=' + session.token + '&role=subscriber&uid=456')).json();
    assert.equal(viewed.appId, credentials().appId); assert.equal(viewed.uid, 456);
    assert.equal((await (await call(sharePath + 'info?t=' + session.token)).json()).agoraAccountLabel, credentials().label);
    assert.equal((await call('/api/spaces/heychat/a/config', tokenA, 'PUT', { stoppedTimeoutSec: 999 })).status, 200);
    assert.equal((await (await call('/api/spaces/heychat/a/config', tokenA)).json()).stoppedTimeoutSec, 600);
    const started = await call(sharePath + 'start?t=' + session.token, '', 'POST', { quality: '1080p_2', clientId: publisher });
    assert.equal((await started.json()).ok, true);
    assert.equal((await call(sharePath + 'end?t=' + session.token, '', 'POST', { clientId: 'foreign' })).status, 401);
    assert.equal((await call(sharePath + 'end?t=' + session.token + '&role=subscriber', '', 'POST', { clientId: publisher })).status, 401);
    for (let i = 0; i < 2; i++) {
      assert.equal((await (await call(sharePath + 'end?t=' + session.token, '', 'POST', { clientId: publisher })).json()).ok, true);
    }
    assert.equal((await call(sharePath + 'start?t=' + session.token, '', 'POST', { quality: '1080p_2', clientId: publisher })).status, 401);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    f.close();
  }
});

test('pool allocation stays in its space, starts after preview, and locks every token to one account', async () => {
  const f = fixture();
  try {
    const first = await f.accounts.save(undefined, { ...credentials('a'), baseline: f.baseline() }, f.a.serverId);
    const selected = await f.accounts.save(undefined, { ...credentials('c'), baseline: { ...f.baseline(), remainingStandardMinutes: 6000 } }, f.a.serverId);
    await f.accounts.save(undefined, { ...credentials('d'), baseline: { ...f.baseline(), remainingStandardMinutes: 9999 } }, f.b.serverId);
    f.controller.setAgoraAccountPool(f.params(), true);
    const session = f.create(), req = () => ({ session: f.sessions.getById(session.id) });
    assert.deepEqual(f.share.preview(req()), { appId: f.accounts.forSpace(f.a.serverId)[0].app_id });
    assert.equal(f.db.getSessionById(session.id)!.agoraAccountId, null);
    assert.equal(f.db.getSessionById(session.id)!.agoraAppId, '');
    assert.throws(() => f.share.token(req(), 'subscriber'));
    assert.throws(() => f.share.start(req(), '1080p_2', publisher));
    const token = f.share.token(req(), 'publisher');
    assert.equal(token.appId, selected.app_id); assert.equal(token.uid, 1); assert.ok(token.token);
    assert.equal(f.db.getSessionById(session.id)!.agoraAccountId, selected.id);
    assert.throws(() => f.accounts.updateLegacy(f.a.serverId, { agoraAppId: selected.app_id, agoraAppCertificate: 'f'.repeat(32) }));
    f.db.integrationDatabase.prepare('UPDATE agora_space_accounts SET enabled=0 WHERE account_id=?').run(selected.id);
    f.db.integrationDatabase.prepare('UPDATE agora_accounts SET baselines_json=? WHERE id=?').run(JSON.stringify({ [monthKey(f.now())]: { ...f.baseline(), remainingStandardMinutes: 0 } }), selected.id);
    f.sessions.startSharing(session.token, publisher); f.sessions.stopSharing(session.token);
    f.controller.setAgoraAccountPool(f.params(), false);
    for (const role of ['publisher', 'subscriber']) {
      const uid = role === 'publisher' ? '1' : '456';
      const renewed = f.share.token(req(), role, uid);
      assert.equal(renewed.appId, token.appId); assert.equal(renewed.channel, token.channel); assert.equal(renewed.uid, Number(uid));
    }
    f.sessions.startSharing(session.token, publisher);
    assert.equal(f.db.getSessionById(session.id)!.agoraAccountId, selected.id);
    f.sessions.endSession(session.id, 'manual');
    f.controller.setAgoraAccountPool(f.params(), true);
    const next = f.create(); assert.equal(f.share.token({ session: next }, 'publisher').appId, first.app_id);
    assert.throws(() => f.share.token(req(), 'publisher'));
  } finally { f.close(); }
});

test('allocation settles live usage before choosing and ties use stable account IDs', async () => {
  const f = fixture();
  try {
    const a = await f.accounts.save(undefined, { ...credentials('a'), baseline: f.baseline() }, f.a.serverId);
    const c = await f.accounts.save(undefined, { ...credentials('c'), baseline: f.baseline() }, f.a.serverId);
    f.controller.setAgoraAccountPool(f.params(), true);
    const sorted = [a, c].sort((a, b) => a.id.localeCompare(b.id));
    const first = f.create(); f.share.token({ session: first }, 'publisher');
    assert.equal(f.db.getSessionById(first.id)!.agoraAccountId, sorted[0].id);
    f.usage.report(first.id, { clientId: publisher, presenceId: publisher, role: 'publisher', uid: 1, sequence: 1, online: true, video: false });
    f.advance(30_000);
    const next = f.create(); f.share.token({ session: next }, 'publisher');
    assert.equal(f.db.getSessionById(next.id)!.agoraAccountId, sorted[1].id);
    assert.equal(f.db.getSessionById(first.id)!.rtcStandardSeconds, 30);
  } finally { f.close(); }
});

test('empty or ineligible enabled pools never fall back; disabled pools keep the legacy contract', async () => {
  const f = fixture();
  try {
    f.accounts.updateLegacy(f.a.serverId, { agoraAppId: 'a'.repeat(32), agoraAppCertificate: 'b'.repeat(32) });
    await f.accounts.save(undefined, { ...credentials('d'), baseline: f.baseline() }, f.b.serverId);
    const pending = f.create();
    assert.throws(() => f.controller.setAgoraAccountPool(f.params(), true));
    assert.throws(() => f.controller.setAgoraAccountPool(f.params(), 'true' as any));
    f.db.updateServer(f.a.serverId, { agoraAccountPoolEnabled: 1 });
    assert.throws(() => f.share.token({ session: pending }, 'publisher'), /本空间账号池无安全可用账号/);
    const ready = await f.accounts.save(undefined, { ...credentials('c'), baseline: { ...f.baseline(), remainingStandardMinutes: 300 } }, f.a.serverId);
    assert.throws(() => f.share.token({ session: pending }, 'publisher'));
    await f.accounts.save(ready.id, { ...credentials('c'), enabled: false, baseline: f.baseline() }, f.a.serverId);
    assert.throws(() => f.share.token({ session: pending }, 'publisher'));
    assert.equal(f.db.getSessionById(pending.id)!.agoraAccountId, null);
    f.controller.setAgoraAccountPool(f.params(), false);
    assert.equal(f.share.token({ session: pending }, 'publisher').appId, 'a'.repeat(32));
    assert.equal(f.sessions.toInfo(f.sessions.getById(pending.id)!).remainingStandardMinutes, null);
  } finally { f.close(); }
});

test('one cached budget uses actual video/audio load across authorized spaces and shares it via SSE and info', async () => {
  const f = fixture();
  try {
    const account = await f.accounts.save(undefined, { ...credentials(), label: 'A 公开备注', baseline: f.baseline() }, f.a.serverId);
    await f.accounts.save(undefined, { ...credentials(), label: 'B 公开备注' }, f.b.serverId);
    for (const space of [f.a, f.b]) f.controller.setAgoraAccountPool(f.params(space), true);
    const a = f.create(), b = f.create(f.b);
    for (const s of [a, b]) { f.share.token({ session: s }, 'publisher'); f.sessions.startSharing(s.token, publisher); }
    const report = (id: string, clientId: string, role: string, video: boolean, online = true, sequence = 1) => f.usage.report(id, { clientId, presenceId: publisher, role, uid: role === 'publisher' ? 1 : 456, video, online, sequence });
    const videoId = '00000000-0000-4000-8000-000000000002', audioId = '00000000-0000-4000-8000-000000000003';
    report(a.id, publisher, 'publisher', false); report(b.id, publisher, 'publisher', false);
    report(a.id, videoId, 'subscriber', true); report(b.id, audioId, 'subscriber', false);
    const before = f.usage.budget(a.id)!;
    assert.equal(before.rtcUsageRate, 1 + 1 + 4.57 + 0.57);
    assert.equal(before.estimatedRemainingSec, Math.floor(4700 * 60 / before.rtcUsageRate));
    assert.equal(f.usage.budget(b.id)!.agoraAccountLabel, 'B 公开备注');
    assert.equal(f.db.getSessionById(b.id)!.agoraAccountId, account.id);
    const info = f.share.info({ session: f.sessions.getById(a.id) });
    const sse = new SessionSseController(f.sessions, f.bus, {} as any) as any;
    const state = sse.buildState(a.id);
    for (const key of ['agoraAccountLabel', 'remainingStandardMinutes', 'estimatedRemainingSec', 'rtcUsageRate', 'budgetUpdatedAt', 'usageCalibratedAt', 'budgetEstimateStatus', 'usageEstimateStatus']) assert.equal(state[key], (info as any)[key]);
    assert.equal(info.usageEstimateStatus, 'local_estimate');
    assert.doesNotMatch(JSON.stringify(state), /secret-a|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|B 公开备注|owner-b/);
    f.advance(10_000);
    assert.equal(f.share.info({ session: f.sessions.getById(a.id) }).budgetUpdatedAt, before.budgetUpdatedAt);
    report(a.id, videoId, 'subscriber', true, false, 2);
    const fewer = f.usage.budget(a.id)!;
    assert.equal(fewer.rtcUsageRate, 2.57); assert.ok(fewer.estimatedRemainingSec! > before.estimatedRemainingSec!);
    assert.ok(fewer.remainingStandardMinutes! < before.remainingStandardMinutes!);
    assert.equal(f.usage.budget(b.id)!.estimatedRemainingSec, fewer.estimatedRemainingSec);
    f.advance(36_000); f.usage.checkpoint();
    assert.equal(f.usage.budget(a.id)!.rtcUsageRate, 0); assert.equal(f.usage.budget(a.id)!.estimatedRemainingSec, null);
    const restarted = new AgoraUsageService(f.db, f.accounts, new AnalyticsService(f.db)); restarted.refreshBudgets();
    assert.equal(restarted.prepareToken(a.id, true)!.id, account.id);
    assert.equal(restarted.budget(a.id)!.rtcUsageRate, 0);
    assert.ok(restarted.budget(a.id)!.remainingStandardMinutes! <= fewer.remainingStandardMinutes!);
  } finally { f.close(); }
});
