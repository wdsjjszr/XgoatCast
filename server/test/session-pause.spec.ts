import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../src/modules/database/database.service';
import { SessionService } from '../src/modules/session/session.service';
import { AgoraService } from '../src/modules/agora/agora.service';
import { AgoraAccountsService } from '../src/modules/agora/agora-accounts.service';
import { AgoraUsageService } from '../src/modules/agora/agora-usage.service';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { EventBusService } from '../src/modules/events/events.service';
import { ShareTokenGuard } from '../src/modules/auth/guards/share-token.guard';
import { AuthService } from '../src/modules/auth/auth.service';
import { PanelAccessService } from '../src/modules/panels/panel-access.service';
import { ShareController } from '../src/modules/share/share.controller';

const publisher = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'xgoat-pause-')), clock = Date.now;
  let now = clock(); Date.now = () => now; process.chdir(root);
  const db = new DatabaseService(), bus = new EventBusService(), analytics = new AnalyticsService(db), agora = new AgoraService(db);
  const usage = new AgoraUsageService(db, new AgoraAccountsService(db), analytics, bus);
  const make = () => new SessionService(db, agora, bus, analytics, usage);
  const sessions = make(), space = db.createSpace({ platform: 'heychat', externalId: 'room', displayName: 'Room', ownerId: 'owner' });
  const create = () => sessions.createSession({ platform: 'heychat', spaceId: space.serverId, externalSpaceId: space.externalId, externalChannelId: 'channel', sharerUserId: 'owner', sharerUsername: 'Owner' });
  const report = (id: string, sequence: number, online: boolean) => usage.report(id, { clientId: publisher, presenceId: publisher, uid: 1, role: 'publisher', sequence, online, video: false });
  return { db, root, bus, sessions, space, create, report, usage, make, agora, analytics,
    advance: (ms: number) => { now += ms; },
    close() { db.onModuleDestroy(); process.chdir(cwd); Date.now = clock; } };
}

test('empty share pauses without ending, wakes only after publish confirmation and keeps one card lifecycle', async () => {
  const f = fixture();
  try {
    let starts = 0, ends = 0; f.bus.onSessionStarted(() => starts++); f.bus.onSessionEnded(() => ends++);
    const s = f.create(); f.sessions.startSharing(s.token, publisher); f.report(s.id, 1, true);
    f.advance(30001); f.sessions.heartbeat(s.token); await f.sessions.watchdog();
    assert.equal(f.sessions.getById(s.id)!.status, 'auto_paused');
    f.report(s.id, 2, false);
    const used = f.db.getSessionById(s.id)!.rtcStandardSeconds;
    f.advance(60000); f.sessions.heartbeat(s.token); f.usage.checkpoint(); await f.sessions.watchdog();
    assert.equal(f.db.getSessionById(s.id)!.rtcStandardSeconds, used);
    assert.equal(f.sessions.getById(s.id)!.status, 'auto_paused');
    assert.equal(f.sessions.toInfo(f.sessions.getById(s.id)!).noViewerRemainingSec, undefined);
    assert.equal(f.sessions.startSharing(s.token, publisher, false, true), undefined);
    f.sessions.viewerConnected(s.id, 'viewer');
    assert.equal(f.sessions.getById(s.id)!.status, 'auto_paused');
    assert.equal(f.sessions.startSharing(s.token, 'foreign', false, true), undefined);
    assert.equal(f.sessions.startSharing(s.token), undefined);
    f.report(s.id, 3, true);
    assert.equal(f.sessions.startSharing(s.token, publisher, false, true)!.status, 'active');
    assert.equal(f.sessions.startSharing(s.token, publisher, false, true)!.status, 'active');
    f.advance(1000); f.report(s.id, 4, false); f.sessions.endSession(s.id, 'publisher_ended');
    f.sessions.endSession(s.id, 'publisher_ended');
    assert.equal(starts, 1); assert.equal(ends, 1);
    assert.ok(Math.abs(f.db.getSessionById(s.id)!.rtcStandardSeconds! - used! - 1) < 1e-8);
  } finally { f.close(); }
});

test('stopped timeout is independent; viewers, heartbeats, repeat stop and stale auto-resume cannot restart it', async () => {
  const f = fixture();
  try {
    f.db.updateServer(f.space.serverId, { idleTimeoutSec: 10, noViewerTimeoutSec: 20, stoppedTimeoutSec: 90 });
    const s = f.create(); f.sessions.startSharing(s.token, publisher); f.sessions.stopSharing(s.token);
    const stoppedAt = f.sessions.getById(s.id)!.graceStartedAt;
    f.advance(31000); f.sessions.viewerConnected(s.id, 'viewer'); f.sessions.heartbeat(s.token); f.sessions.stopSharing(s.token);
    await f.sessions.watchdog();
    assert.equal(f.sessions.getById(s.id)!.status, 'grace');
    assert.equal(f.sessions.getById(s.id)!.graceStartedAt, stoppedAt);
    const info = f.sessions.toInfo(f.sessions.getById(s.id)!);
    assert.equal(info.stoppedRemainingSec, 59); assert.equal(info.idleRemainingSec, undefined); assert.equal(info.noViewerRemainingSec, undefined);
    assert.equal(f.sessions.startSharing(s.token, publisher, false, true), undefined);
    f.advance(59001); await f.sessions.watchdog(); assert.equal(f.sessions.getById(s.id)!.status, 'ended');
    assert.equal(f.sessions.startSharing(s.token, publisher, false, true), undefined);
  } finally { f.close(); }
});

test('manual restart keeps the link, resets empty timing, and pending / paused orphan cleanup remains bounded across restarts', async () => {
  const f = fixture();
  try {
    const pending = f.create();
    const s = f.create(); f.sessions.startSharing(s.token, publisher);
    f.advance(30001); f.sessions.heartbeat(s.token); await f.sessions.watchdog();
    f.sessions.stopSharing(s.token); f.sessions.startSharing(s.token, publisher);
    const info = f.sessions.toInfo(f.sessions.getById(s.id)!); assert.equal(info.noViewerRemainingSec, 30);
    const emptySince = (f.db.integrationDatabase.prepare('SELECT empty_since FROM session_recovery WHERE session_id=?').get(s.id) as any).empty_since;
    assert.equal(emptySince, Date.now());
    assert.equal(f.sessions.getById(s.id)!.channel, s.channel);
    f.advance(30001); f.sessions.heartbeat(s.token); await f.sessions.watchdog();
    assert.equal(f.sessions.getById(s.id)!.status, 'auto_paused');
    let restarted = f.make(); await restarted.onModuleInit();
    const saved = () => (f.db.integrationDatabase.prepare('SELECT until_at FROM session_recovery WHERE session_id=?').get(s.id) as any).until_at;
    const deadline = saved(); f.advance(10000); restarted = f.make(); await restarted.onModuleInit(); assert.equal(saved(), deadline);
    f.advance(60001); await restarted.watchdog();
    assert.equal(restarted.getById(s.id)!.status, 'ended'); assert.equal(restarted.getById(pending.id)!.status, 'ended');
  } finally { f.close(); }
});

test('new defaults and one-time stopped timer migration preserve saved no-viewer and idle values', () => {
  const f = fixture();
  try {
    assert.equal(f.db.getServer(f.space.serverId)!.noViewerTimeoutSec, 30);
    assert.equal(f.db.createServer('kook', 'Kook', 'owner', 'Owner').noViewerTimeoutSec, 180);
    f.db.updateServer(f.space.serverId, { idleTimeoutSec: 120, noViewerTimeoutSec: 95 }); f.db.onModuleDestroy();
    const sql = new Database(join(f.root, 'data/xgoatcast.db')); sql.exec('ALTER TABLE servers DROP COLUMN stopped_timeout_sec'); sql.close();
    const reopened = new DatabaseService();
    try {
      assert.equal(reopened.getServer(f.space.serverId)!.stoppedTimeoutSec, 120);
      assert.equal(reopened.getServer(f.space.serverId)!.noViewerTimeoutSec, 95);
      reopened.updateServer(f.space.serverId, { idleTimeoutSec: 10 });
      assert.equal(reopened.getServer(f.space.serverId)!.stoppedTimeoutSec, 120);
    } finally { reopened.onModuleDestroy(); }
  } finally { f.close(); }
});

test('end operation is publisher-locked, idempotent after ending and rejects panel viewer tokens', () => {
  const f = fixture();
  try {
    const s = f.create(); f.sessions.startSharing(s.token, publisher);
    const panels = new PanelAccessService(f.db), guard = new ShareTokenGuard(new AuthService(f.sessions), panels);
    const request = (path: string, clientId?: string, t = s.token) => ({ path, query: { t }, body: { clientId }, headers: {} });
    const check = (req: any) => guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as any);
    assert.throws(() => check(request('/api/share/end', 'foreign')));
    assert.throws(() => check(request('/api/share/stop')));
    assert.throws(() => check(request('/api/share/end', publisher, 'v_invalid')));
    const req: any = request('/API/SHARE/END', publisher); assert.equal(check(req), true);
    const controller = new ShareController(f.agora, f.sessions, f.db, f.analytics, f.usage);
    assert.deepEqual(controller.end(req), { ok: true }); assert.equal(check(req), true);
    assert.deepEqual(controller.end(req), { ok: true });
    assert.throws(() => check(request('/api/share/start', publisher)));
  } finally { f.close(); }
});
