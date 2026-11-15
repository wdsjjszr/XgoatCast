import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../src/modules/database/database.service';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { AgoraAccountsService } from '../src/modules/agora/agora-accounts.service';
import { AgoraUsageService } from '../src/modules/agora/agora-usage.service';
import { AgoraService } from '../src/modules/agora/agora.service';
import { EventBusService } from '../src/modules/events/events.service';
import { SessionService } from '../src/modules/session/session.service';
import { calibrateUsage, calibrationRange, DAY_MS, monthBounds, parseOfficialUsage, segmentSeconds, utcDate } from '../src/modules/agora/agora-usage.math';

const appId = 'a'.repeat(32), certificate = 'b'.repeat(32);
const fields = ['durationAudioAll', 'durationVideoHd', 'durationVideo1080P', 'durationVideo2K', 'durationVideo4K', 'durationVideoHdp'];
function official(from: string, to: string, values: Record<string, Partial<Record<string, number>>> = {}) {
  const usages = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += DAY_MS) {
    usages.push({ date: new Date(at).toISOString(), usage: { ...Object.fromEntries(fields.map(f => [f, 0])), ...values[utcDate(at)] } });
  }
  return { meta: Object.fromEntries(fields.map(f => [f, { unit: 'second' }])), usages };
}
function fixture() {
  const previousCwd = process.cwd(), realNow = Date.now, realFetch = global.fetch;
  const root = mkdtempSync(join(tmpdir(), 'xgoat-usage-'));
  process.chdir(root);
  let now = Date.parse('2026-11-15T02:00:00Z'); Date.now = () => now;
  global.fetch = (async (url: any) => {
    const parsed = new URL(String(url));
    const body = parsed.pathname.endsWith('/projects') ? { projects: [{ id: 'project-one', vendor_key: appId, status: 1 }] }
      : official(parsed.searchParams.get('from_date')!, parsed.searchParams.get('to_date')!);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any;
  const db = new DatabaseService(), analytics = new AnalyticsService(db), accounts = new AgoraAccountsService(db);
  let usage = new AgoraUsageService(db, accounts, analytics);
  let sessions = new SessionService(db, new AgoraService(db), new EventBusService(), analytics, usage);
  const space = db.createSpace({ platform: 'heychat', externalId: 'usage-room', displayName: 'Usage room', ownerId: 'owner' });
  db.updateServer(space.serverId, { bound: 1, agoraAppId: appId, agoraAppCertificate: certificate });
  const create = () => sessions.createSession({ platform: 'heychat', spaceId: space.serverId, externalSpaceId: space.externalId, externalChannelId: 'channel', sharerUserId: 'owner', sharerUsername: 'Owner' });
  const publisher = '00000000-0000-4000-8000-000000000001';
  const viewer = (n: number) => `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}`;
  const report = (id: string, n: number, sequence: number, online: boolean, video = false) => usage.report(id, {
    clientId: n === 0 ? publisher : viewer(n), presenceId: n === 0 ? publisher : viewer(n),
    sequence, online, video, uid: n === 0 ? 1 : 100 + n, role: n === 0 ? 'publisher' : 'subscriber',
  });
  return {
    db, analytics, accounts, create, publisher, viewer, report, space, root,
    get usage() { return usage; }, get sessions() { return sessions; },
    advance(ms: number) { now += ms; }, now: () => now,
    async account(baseline = true) { return accounts.save(undefined, { label: '公开账号 A', enabled: true, appId, appCertificate: certificate, customerId: 'test-customer', customerSecret: 'test-secret', ...(baseline ? { baseline: { at: monthBounds('2026-11')[0], remainingStandardMinutes: 10_000 } } : {}) }); },
    restart() { usage = new AgoraUsageService(db, accounts, analytics); sessions = new SessionService(db, new AgoraService(db), new EventBusService(), analytics, usage); },
    close() { db.onModuleDestroy(); global.fetch = realFetch; Date.now = realNow; process.chdir(previousCwd); },
  };
}

test('official buckets are independent, weighted by local mode, and reject incomplete or changed schemas', () => {
  const body = official('2026-11-10', '2026-11-10', { '2026-11-10': { durationAudioAll: 100, durationVideo1080P: 100, durationVideoHdp: 100 } });
  const buckets = parseOfficialUsage(body, '2026-11-10', '2026-11-10').get('2026-11-10')!;
  const estimate = calibrateUsage(buckets, { 'audio/publisher': 60, 'audio/live': 40, 'fullHd/live': 50, 'fullHd/rtc': 50 });
  assert.ok(Math.abs(estimate.seconds - (82.8 + 678.5)) < 1e-8);
  assert.equal(estimate.unknownMode, false);
  assert.equal(calibrateUsage(buckets, {}).seconds, 1000);
  assert.equal(calibrateUsage(buckets, {}).unknownMode, true);
  body.meta.durationAudioAll.unit = 'minute';
  assert.throws(() => parseOfficialUsage(body, '2026-11-10', '2026-11-10'));
  assert.throws(() => parseOfficialUsage(official('2026-11-10', '2026-11-10'), '2026-11-10', '2026-11-11'));
  assert.throws(() => parseOfficialUsage(official('2026-11-10', '2026-11-10', { '2026-11-10': { durationVideoHdp: 10 } }), '2026-11-10', '2026-11-10'));
});

test('Hong Kong month boundaries and partial baseline segments do not double-charge', () => {
  const [start, end] = monthBounds('2026-11');
  assert.equal(new Date(start).toISOString(), '2026-10-31T16:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-11-30T16:00:00.000Z');
  assert.deepEqual(calibrationRange('2026-11', { at: Date.parse('2026-11-01T09:00Z'), remainingStandardMinutes: 5000, source: 'manual' }, Date.parse('2026-11-15T10:00Z')), ['2026-11-02', '2026-11-13']);
  assert.equal(segmentSeconds({ from: start - 1000, to: start + 1000, buckets: { 'audio/publisher': 2 } }, start, end), 1);
});

test('one long viewer and two short viewers accrue intervals, not peak multiplied by the whole session', async () => {
  const f = fixture();
  try {
    const account = await f.account(); const session = f.create();
    f.sessions.startSharing(session.token, f.publisher, false);
    f.report(session.id, 0, 1, true); f.report(session.id, 1, 1, true, true); f.sessions.viewerConnected(session.id, f.viewer(1));
    f.advance(30_000); f.usage.checkpoint();
    f.report(session.id, 0, 2, true); f.report(session.id, 1, 2, true, true);
    for (const n of [2, 3]) { f.report(session.id, n, 1, true, true); f.sessions.viewerConnected(session.id, f.viewer(n)); }
    f.advance(5000);
    for (const n of [2, 3]) f.sessions.viewerDisconnected(session.id, f.viewer(n));
    f.advance(25_000); f.report(session.id, 0, 3, false); f.report(session.id, 1, 3, false);
    f.sessions.stopSharing(session.token); f.advance(60_000); f.sessions.endSession(session.id, 'manual');
    const row = f.db.getSessionById(session.id)!;
    assert.equal(row.viewerDurationMs, 70_000); assert.equal(row.peakViewers, 3);
    assert.ok(Math.abs(row.rtcStandardSeconds! - (60 + 70 * 4.57)) < 1e-7);
    assert.equal(row.agoraAccountId, account.id);
    const info = f.sessions.toInfo(f.sessions.getById(session.id)!);
    const record = f.analytics.getRecords({ type: 'share', range: 'all' }).items[0] as any;
    assert.equal(info.standardMinutes, row.rtcStandardSeconds! / 60);
    assert.equal(record.standardMinutes, info.standardMinutes); assert.equal(record.viewerDurationMs, 70_000);
    assert.equal(record.usageModel, 'segmented_estimate');
    assert.equal(record.viewerDurationEstimated, false);
  } finally { f.close(); }
});

test('sequence order, restart and abandoned RTC leases cannot resurrect old consumption', async () => {
  const f = fixture();
  try {
    await f.account(); const s = f.create(); f.sessions.startSharing(s.token, f.publisher); f.report(s.id, 0, 1, true);
    f.advance(10_000); f.usage.checkpoint(); const before = f.db.getSessionById(s.id)!.rtcStandardSeconds!;
    f.advance(3600_000); f.restart(); f.report(s.id, 0, 2, true);
    f.advance(10_000); f.report(s.id, 0, 3, false); f.report(s.id, 0, 2, true);
    f.advance(10_000); f.usage.checkpoint(); assert.equal(f.db.getSessionById(s.id)!.rtcStandardSeconds, before + 10);
    f.report(s.id, 0, 4, true); f.advance(120_000); f.usage.checkpoint();
    assert.equal(f.db.getSessionById(s.id)!.rtcStandardSeconds, before + 55);
  } finally { f.close(); }
});

test('quality, latency and video-to-audio changes settle the old rate across UTC midnight', async () => {
  const f = fixture();
  try {
    const account = await f.account(); f.advance(Date.parse('2026-11-15T23:59:50Z') - f.now());
    const s = f.create(); f.sessions.startSharing(s.token, f.publisher, false);
    f.report(s.id, 0, 1, true); f.report(s.id, 1, 1, true, true);
    f.advance(10_000); f.sessions.updateQuality(s.id, '720p30'); f.sessions.startSharing(s.token, f.publisher, true);
    f.advance(20_000); f.report(s.id, 1, 2, true, false);
    f.advance(10_000); f.sessions.endSession(s.id, 'manual');
    assert.ok(Math.abs(f.db.getSessionById(s.id)!.rtcStandardSeconds! - 175.7) < 1e-8);
    const rows = f.db.integrationDatabase.prepare('SELECT utc_date,local_standard_seconds FROM agora_usage_daily WHERE account_id=? ORDER BY utc_date').all(account.id) as any[];
    assert.equal(rows.length, 2); assert.equal(rows[0].utc_date, '2026-11-15'); assert.equal(rows[1].utc_date, '2026-11-16');
    assert.ok(Math.abs(rows[0].local_standard_seconds - 55.7) < 1e-8); assert.ok(Math.abs(rows[1].local_standard_seconds - 120) < 1e-8);
  } finally { f.close(); }
});

test('429 respects Retry-After within the persisted automatic retry budget', async () => {
  const f = fixture();
  try {
    const account = await f.account(); let requests = 0;
    global.fetch = (async () => { requests++; return new Response('', { status: 429, headers: { 'Retry-After': '600' } }); }) as any;
    await f.usage.runDue(); assert.equal(f.accounts.get(account.id).next_sync_at, f.now() + 600_000);
    f.advance(61_000); await f.usage.runDue(); assert.equal(requests, 1);
    f.advance(540_000); await f.usage.runDue(); assert.equal(requests, 2); assert.equal(f.accounts.get(account.id).sync_attempts, 2);
  } finally { f.close(); }
});

test('calibration replaces a complete UTC day and preserves the local ledger and mode-unknown marker', async () => {
  const f = fixture();
  try {
    const account = await f.account();
    const local = { buckets: { 'audio/publisher': 10, 'fullHd/live': 10 }, segments: [{ from: Date.parse('2026-11-10T00:00Z'), to: Date.parse('2026-11-10T00:00:10Z'), buckets: { 'audio/publisher': 10, 'fullHd/live': 10 } }] };
    f.db.integrationDatabase.prepare('INSERT INTO agora_usage_daily(account_id,utc_date,local_json,local_standard_seconds) VALUES(?,?,?,?)').run(account.id, '2026-11-10', JSON.stringify(local), 55.7);
    global.fetch = (async (url: any) => { const u = new URL(String(url)); assert.equal(u.searchParams.get('from_date'), '2026-11-01'); assert.equal(u.searchParams.get('to_date'), '2026-11-13'); return new Response(JSON.stringify(official('2026-11-01', '2026-11-13', { '2026-11-10': { durationAudioAll: 100, durationVideo1080P: 100, durationVideoHdp: 100 }, '2026-11-11': { durationVideoHd: 10 } }))); }) as any;
    await f.usage.sync(account.id); const first = f.usage.balance(f.accounts.get(account.id));
    await f.usage.sync(account.id); const second = f.usage.balance(f.accounts.get(account.id));
    assert.ok(Math.abs(first.usedStandardSeconds! - 597) < 1e-8); assert.equal(second.usedStandardSeconds, first.usedStandardSeconds);
    assert.equal(second.estimateStatus, 'unknown_mode_estimate');
    assert.equal((f.db.integrationDatabase.prepare('SELECT local_json FROM agora_usage_daily WHERE account_id=? AND utc_date=?').get(account.id, '2026-11-10') as any).local_json, JSON.stringify(local));
  } finally { f.close(); }
});

test('three automatic attempts persist across restart; failure never resets the balance or successful snapshot', async () => {
  const f = fixture();
  try {
    const account = await f.account(); await f.usage.sync(account.id); const successAt = f.accounts.get(account.id).last_sync_at;
    f.advance(DAY_MS); let requests = 0;
    global.fetch = (async () => { requests++; return new Response('', { status: 503 }); }) as any;
    await f.usage.runDue(); f.advance(61_000); f.restart(); await f.usage.runDue(); f.advance(301_000); await f.usage.runDue();
    f.advance(3600_000); f.restart(); await f.usage.runDue();
    const after = f.accounts.get(account.id);
    assert.equal(requests, 3); assert.equal(after.sync_attempts, 3); assert.equal(after.next_sync_at, 0); assert.equal(after.last_sync_at, successAt);
    assert.equal(f.usage.balance(after).safeRemainingStandardMinutes, 9700);
    f.advance(DAY_MS); requests = 0; global.fetch = (async () => { requests++; return new Response('', { status: 401 }); }) as any;
    await f.usage.runDue(); f.advance(600_000); await f.usage.runDue(); assert.equal(requests, 1);
  } finally { f.close(); }
});

test('account secrets stay masked; unknown baselines, live credential locks and historical months remain intact', async () => {
  const f = fixture();
  try {
    let account = await f.account(false);
    assert.equal(f.usage.balance(account).safeRemainingStandardMinutes, null);
    f.db.integrationDatabase.prepare("UPDATE agora_accounts SET sync_day='2026-11-14',sync_attempts=3 WHERE id=?").run(account.id);
    await f.usage.runDue(); assert.equal(f.accounts.get(account.id).sync_attempts, 0);
    const s = f.create(); f.sessions.startSharing(s.token, f.publisher); f.report(s.id, 0, 1, true);
    const update = { label: '更新备注', enabled: false, appId, appCertificate: '', customerId: 'test-customer', customerSecret: '' };
    account = await f.accounts.save(account.id, { ...update, baseline: { at: f.now(), remainingStandardMinutes: 5000 } });
    assert.equal(account.app_certificate, certificate); assert.equal(account.customer_secret, 'test-secret');
    assert.doesNotMatch(JSON.stringify(f.usage.list()), /test-secret|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    await assert.rejects(f.accounts.save(account.id, { ...update, appCertificate: 'c'.repeat(32) }));
    assert.throws(() => f.accounts.remove(account.id));
    f.advance(20 * DAY_MS); const baselines = f.accounts.baselines(account);
    assert.equal(baselines['2026-11'].remainingStandardMinutes, 5000); assert.equal(baselines['2026-12'].remainingStandardMinutes, 10000);
  } finally { f.close(); }
});

test('incremental migration retains old history and creates a restorable pre-usage backup', () => {
  const cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'xgoat-migration-')); process.chdir(root);
  let db: DatabaseService | undefined;
  try {
    db = new DatabaseService(); db.createServer('legacy', 'Legacy', 'owner', 'Owner'); db.onModuleDestroy(); db = undefined;
    const path = join(root, 'data', 'xgoatcast.db'), old = new Database(path);
    old.exec('ALTER TABLE sessions DROP COLUMN rtc_standard_seconds'); old.close();
    db = new DatabaseService(); assert.equal(db.getServer('legacy')!.guildName, 'Legacy');
    const backup = readdirSync(join(root, 'data')).find(file => file.startsWith('xgoatcast-pre-usage-'));
    assert.ok(backup);
    const saved = new Database(join(root, 'data', backup), { readonly: true });
    assert.equal((saved.prepare('SELECT guild_name FROM servers WHERE server_id=?').get('legacy') as any).guild_name, 'Legacy');
    assert.equal((saved.prepare('PRAGMA table_info(sessions)').all() as any[]).some(c => c.name === 'rtc_standard_seconds'), false); saved.close();
  } finally { db?.onModuleDestroy(); process.chdir(cwd); }
});

test('analytics uses the shared segmented total and never backfills awaiting-media zeros as peak estimates', () => {
  const f = fixture();
  try {
    const s = f.create(); f.sessions.startSharing(s.token, f.publisher);
    f.advance(61_000); f.db.integrationDatabase.prepare('UPDATE analytics_share_records SET duration_ms=61000 WHERE share_id=?').run(s.id);
    const restarted = new AnalyticsService(f.db);
    assert.equal((restarted.getRecords({ type: 'share', range: 'all' }).items[0] as any).standardMinutes, 0);
    f.db.integrationDatabase.prepare('UPDATE analytics_share_records SET standard_minutes=2 WHERE share_id=?').run(s.id);
    f.db.updateSession(s.id, { rtcStandardSeconds: 61, usageEstimateStatus: 'legacy_and_local_estimate' });
    restarted.recordShareMetrics(f.db.getSessionById(s.id)!);
    const record = restarted.getRecords({ type: 'share', range: 'all' }).items[0] as any;
    assert.equal(record.standardMinutes, 61 / 60); assert.equal(record.viewerDurationEstimated, true);
  } finally { f.close(); }
});

test('different REST keys and App IDs from one vendor do not create duplicate free quotas', async () => {
  const f = fixture();
  try {
    await f.account();
    global.fetch = (async () => new Response(JSON.stringify({ projects: [{ id: 'project-one', vendor_key: appId, status: 1 }, { id: 'project-two', vendor_key: 'c'.repeat(32), status: 1 }] }))) as any;
    await assert.rejects(f.accounts.save(undefined, { label: 'Same vendor', enabled: true, appId: 'c'.repeat(32), appCertificate: 'd'.repeat(32), customerId: 'another-key', customerSecret: 'another-secret' }), /account_already_configured/);
    assert.equal(f.accounts.all().length, 1);
  } finally { f.close(); }
});
