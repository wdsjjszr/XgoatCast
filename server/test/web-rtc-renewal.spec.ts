import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { ShareController } from '../src/modules/share/share.controller';
import { rtcDiagnostic } from '../src/modules/share/rtc-diagnostic';

const credentials = { appId: 'test-app', channel: 'test-channel', uid: 234, token: 'test-rtc-token', expireSec: 3600 };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const listeners = new Map<string, Set<() => void>>();
  const calls: any[] = [], logs: any[] = [], consoleLogs: any[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  class ApiError extends Error { constructor(public statusCode: number) { super('request failed'); } }
  const api = {
    async getShareToken(...args: any[]) { calls.push(['token', ...args]); return { ...credentials }; },
    async reportShareTelemetry(payload: any) { calls.push(['telemetry', payload]); return { ok: true }; },
  };
  const client = {
    mode: 'live',
    on(event: string, fn: () => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
    off(event: string, fn: () => void) { listeners.get(event)?.delete(fn); },
    async renewToken(token: string) { calls.push(['renew', token]); },
    async leave() { calls.push(['leave']); },
    async setClientRole(...args: any[]) { calls.push(['role', ...args]); },
    async join(...args: any[]) { calls.push(['join', ...args]); },
  };
  const source = readFileSync(join(__dirname, '../../web/src/lib/rtcLifecycle.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(code, {
    module, exports: module.exports, AbortController, TypeError,
    crypto: { randomUUID: () => '12345678-1234-4123-8123-123456789012' },
    console: { info: (...args: any[]) => consoleLogs.push(args) },
    setTimeout(fn: () => void, ms: number) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void, ms: number) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearInterval(id: number) { timers.delete(id); },
    require: () => ({ api, ApiError }),
  });
  const lifecycle = module.exports.installRtcTokenRenewal({
    client, token: 'test-share-token', role: 'subscriber', identity: credentials,
    isCurrent: () => true,
    log: (...args: any[]) => logs.push(args),
    beforeRejoin: () => calls.push(['reset']),
    afterRejoin: async () => { calls.push(['restore']); },
    onError: () => calls.push(['error']),
  });
  return {
    api, ApiError, client, calls, logs, consoleLogs, lifecycle, exports: module.exports,
    emit: (event: string) => { for (const fn of listeners.get(event) || []) fn(); },
    retry: () => {
      const timer = [...timers].find(([, value]) => value.ms < 10_000);
      assert.ok(timer); timers.delete(timer[0]); timer[1].fn();
    },
    timers,
  };
}

test('subscriber renewal preserves UID and permits only one request in flight', async () => {
  const f = fixture();
  let release!: (value: typeof credentials) => void;
  f.api.getShareToken = async (...args) => { f.calls.push(['token', ...args]); return new Promise<typeof credentials>(resolve => { release = resolve; }); };
  f.emit('token-privilege-will-expire'); f.emit('token-privilege-will-expire');
  assert.equal(f.calls.filter(c => c[0] === 'token').length, 1);
  assert.equal(f.calls[0][3], credentials.uid);
  release(credentials); await flush();
  assert.deepEqual(f.calls.find(c => c[0] === 'renew'), ['renew', credentials.token]);
  await f.lifecycle.dispose();
});

test('expiration during renewal recovers with the same identity and restores media once', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.client.renewToken = async () => new Promise<void>((_, fail) => { reject = fail; });
  f.emit('token-privilege-will-expire'); await flush();
  f.emit('token-privilege-did-expire');
  reject(new Error('already expired')); await flush();
  const joined = f.calls.find(c => c[0] === 'join');
  assert.deepEqual(joined, ['join', credentials.appId, credentials.channel, credentials.token, credentials.uid]);
  assert.equal(f.calls.filter(c => c[0] === 'restore').length, 1);
  assert.equal(f.calls.find(c => c[0] === 'role')?.[1], 'audience');
  assert.equal(f.calls.find(c => c[0] === 'role')?.[2].level, 1);
  assert.equal(f.logs.at(-1)[0], 'token_rejoin_success');
  await f.lifecycle.dispose();
});

test('dispose while credentials are pending cannot renew or rejoin', async () => {
  const f = fixture();
  let release!: (value: typeof credentials) => void;
  f.api.getShareToken = async () => new Promise<typeof credentials>(resolve => { release = resolve; });
  f.emit('token-privilege-did-expire');
  const disposed = f.lifecycle.dispose();
  release(credentials); await disposed;
  assert.equal(f.calls.length, 0);
  f.emit('token-privilege-did-expire');
  assert.equal(f.calls.length, 0);
});

test('transient failures stop after two retries; authorization failures do not retry', async () => {
  for (const status of [503, 401]) {
    const f = fixture(); let requests = 0;
    f.api.getShareToken = async () => { requests++; throw new f.ApiError(status); };
    f.emit('token-privilege-will-expire'); await flush();
    if (status === 503) {
      f.retry(); await flush(); f.retry(); await flush();
    }
    assert.equal(requests, status === 503 ? 3 : 1);
    assert.equal(f.calls.filter(c => c[0] === 'error').length, 1);
    assert.equal(f.timers.size, 0);
    await f.lifecycle.dispose();
  }
});

test('changing App ID fails rather than moving the RTC identity', async () => {
  const f = fixture();
  f.api.getShareToken = async () => ({ ...credentials, appId: 'other-app' });
  f.emit('token-privilege-will-expire'); await flush();
  assert.equal(f.calls.some(c => c[0] === 'renew' || c[0] === 'join'), false);
  assert.equal(f.logs.at(-1)[1].errorCode, 'RTC_IDENTITY_CHANGED');
  await f.lifecycle.dispose();
});

test('direct expiration rejoins once, while disposal cancels a scheduled retry', async () => {
  const f = fixture();
  f.emit('token-privilege-did-expire'); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'join').length, 1);
  assert.equal(f.calls.some(c => c[0] === 'renew'), false);
  await f.lifecycle.dispose();
  const retrying = fixture(); let requests = 0;
  retrying.api.getShareToken = async () => { requests++; throw new retrying.ApiError(503); };
  retrying.emit('token-privilege-will-expire'); await flush();
  await retrying.lifecycle.dispose();
  assert.equal(retrying.timers.size, 0);
  assert.equal(requests, 1);
  assert.equal(retrying.calls.some(c => c[0] === 'error'), false);
});

test('token endpoint accepts the previous UID, keeps old initial requests, and rejects invalid identities', () => {
  const controller = new ShareController({ generateToken: (channel: string, uid: number) => ({ appId: 'app', channel, uid }) } as any, {} as any, {} as any, {} as any);
  const req = { session: { channel: 'channel' } };
  assert.equal(controller.token(req, 'publisher').uid, 1);
  assert.equal(controller.token(req, 'subscriber', '234').uid, 234);
  assert.notEqual(controller.token(req, 'subscriber').uid, 1);
  for (const uid of ['0', '1', '-1', '1.5', 'Infinity', '4294967296', ' 234', '']) {
    assert.throws(() => controller.token(req, 'subscriber', uid));
  }
  assert.throws(() => controller.token(req, 'publisher', '234'));
  assert.throws(() => controller.token(req, 'unknown'));
});

test('diagnostics exclude credentials and do not enter analytics counters', () => {
  const f = fixture();
  const log = f.exports.createRtcLog('private-share-token', 'subscriber', '4.24.0');
  log('subscribe_failed', { errorCode: f.exports.rtcErrorCode({ code: 'private-rtc-token', message: 'private-secret' }) });
  assert.doesNotMatch(JSON.stringify(f.consoleLogs), /private-/);
  const payload = { eventType: 'rtc_diagnostic', event: 'subscribe_failed', role: 'subscriber', errorCode: 'INVALID_TOKEN', token: 'private-token', message: 'private-secret', extra: { certificate: 'private-certificate' } };
  assert.doesNotMatch(JSON.stringify(rtcDiagnostic('session', payload)), /private-/);
  let analytics = 0;
  const controller = new ShareController({} as any, {} as any, {} as any, { recordClientTelemetry() { analytics++; } } as any);
  (controller as any).logger = { log() {} };
  controller.telemetry({ session: { id: 'session' } }, payload);
  assert.equal(analytics, 0);
  controller.telemetry({ session: { id: 'session' } }, { eventType: 'page_open' });
  assert.equal(analytics, 1);
});

test('RTC state snapshots advance sequence, retain presence identity and stop heartbeats after leave', () => {
  const f = fixture();
  const log = f.exports.createRtcLog('private-token', 'publisher', '4.24.0', '00000000-0000-4000-8000-000000000001');
  log('join_success', { uid: 1 });
  const first = f.calls.at(-1)[1];
  assert.equal(first.online, true); assert.equal(first.sequence, 1);
  const heartbeat = [...f.timers.values()].find(timer => timer.ms === 30000)!;
  heartbeat.fn(); const second = f.calls.at(-1)[1];
  assert.equal(second.eventType, 'rtc_state'); assert.equal(second.presenceId, first.presenceId); assert.equal(second.sequence, 2);
  assert.equal(f.consoleLogs.length, 1);
  log('rtc_leave'); assert.equal(f.calls.at(-1)[1].online, false); assert.equal(f.timers.size, 0);
});
