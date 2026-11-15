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
  const db = new DatabaseService(), analytics = new AnalyticsService(db), accounts = new AgoraAccountsService(db), usage = new AgoraUsageService(db, accounts, analytics);
  const sessions = new SessionService(db, new AgoraService(db), new EventBusService(), analytics, usage);
  const controller = new ServerAdminController(db, analytics, accounts, usage);
  const a = db.createSpace({ platform: 'heychat', externalId: 'a', displayName: '空间 A', ownerId: 'owner-a' });
  const b = db.createSpace({ platform: 'heychat', externalId: 'b', displayName: '空间 B', ownerId: 'owner-b' });
  for (const space of [a, b]) db.updateServer(space.serverId, { bound: 1, passwordHash: bcrypt.hashSync('test-password', 4) });
  const params = (space = a) => ({ platform: 'heychat', externalId: space.externalId });
  const create = (space = a) => sessions.createSession({ platform: 'heychat', spaceId: space.serverId, externalSpaceId: space.externalId, externalChannelId: 'channel', sharerUserId: 'owner', sharerUsername: '测试共享者' });
  return { db, accounts, usage, sessions, controller, a, b, params, create, root, realFetch, apiFetch: global.fetch,
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
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    f.close();
  }
});
