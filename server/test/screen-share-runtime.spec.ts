import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function load(sdk: any, api: any = {}, onTrackEnded?: () => void) {
  const module = { exports: {} as any };
  const errors: string[] = [];
  const source = readFileSync(join(__dirname, '../../web/src/hooks/useScreenShare.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
  } }).outputText;
  const context = { module, exports: module.exports, window: { AgoraRTC: sdk },
    location: { protocol: 'https:', hostname: 'test', host: 'test' },
    navigator: { mediaDevices: { getDisplayMedia() {} } }, console,
    require(name: string) {
      if (name === 'react') return { useCallback: (fn: any) => fn, useEffect() {},
        useRef: (value: any) => ({ current: value }),
        useState: (value: any) => [value, (next: any) => { if (typeof next === 'string') errors.push(next); }],
      };
      if (name.includes('screenAudioCapture')) return { installScreenAudioInterceptor() {} };
      if (name.includes('rtcLifecycle')) return {
        createRtcLog: () => () => {}, rtcErrorCode: () => 'RTC_ERROR',
        installRtcTokenRenewal: () => ({ dispose: async () => {} }),
      };
      if (name.includes('/api')) return { api };
      throw new Error(name);
    },
  };
  vm.runInNewContext(code, context);
  return { hook: module.exports.useScreenShare('test-token', onTrackEnded), errors };
}
function fixture() {
  let closed = 0;
  let left = 0;
  const events: Record<string, () => void> = {};
  const video = { stop() {}, close() { closed++; }, on(name: string, fn: () => void) { events[name] = fn; }, removeAllListeners() {} };
  const client = { on() {}, removeAllListeners() {}, async setClientRole() {}, async join() {}, async publish() {}, async unpublish() {}, async leave() { left++; } };
  const sdk = { setLogLevel() {}, createScreenVideoTrack: async () => video, createClient: () => client };
  const api = { getShareToken: async () => ({ appId: 'id', channel: 'channel', token: 'token', uid: 1 }) };
  return { sdk, api, client, events, counts: () => ({ closed, left }) };
}
test('missing SDK is a recoverable publish error, not a module crash', async () => {
  const { hook } = load(undefined);
  const result = await hook.publish({ lowLatency: false });
  assert.equal(result.success, false);
  assert.match(result.message, /SDK/);
});
test('video-only capture succeeds without an audio track', async () => {
  const f = fixture();
  const { hook } = load(f.sdk, f.api);
  assert.equal((await hook.publish({ lowLatency: false })).success, true);
  await hook.stop();
  assert.equal(f.counts().closed, 1);
});
test('failed RTC join releases capture and allows another attempt', async () => {
  const f = fixture();
  f.client.join = async () => { throw new Error('network failure'); };
  const { hook } = load(f.sdk, f.api);
  assert.equal((await hook.publish({ lowLatency: false })).success, false);
  assert.equal(f.counts().closed, 1);
  f.client.join = async () => {};
  assert.equal((await hook.publish({ lowLatency: false })).success, true);
  await hook.stop();
});
test('rapid duplicate clicks create only one capture', async () => {
  const f = fixture();
  let release!: () => void;
  let captures = 0;
  const original = f.sdk.createScreenVideoTrack;
  f.sdk.createScreenVideoTrack = async () => { captures++; await new Promise<void>(resolve => { release = resolve; }); return original(); };
  const { hook } = load(f.sdk, f.api);
  const first = hook.publish({ lowLatency: false });
  await new Promise(resolve => setImmediate(resolve));
  const second = hook.publish({ lowLatency: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captures, 1);
  release();
  assert.equal((await first).success, true);
  assert.equal((await second).success, false);
  await hook.stop();
});

test('capture begins before waiting for publisher credentials', async () => {
  const f = fixture();
  const order: string[] = [];
  const capture = f.sdk.createScreenVideoTrack;
  const credentials = f.api.getShareToken;
  f.sdk.createScreenVideoTrack = async () => { order.push('capture'); return capture(); };
  f.api.getShareToken = async () => { order.push('credentials'); return credentials(); };
  const { hook } = load(f.sdk, f.api);
  assert.equal((await hook.publish({ lowLatency: false })).success, true);
  assert.deepEqual(order, ['capture', 'credentials']);
  await hook.stop();
});

test('credential errors release the captured screen and preserve the server message', async () => {
  const f = fixture();
  f.api.getShareToken = async () => { throw new Error('房间尚未配置 Agora App ID'); };
  const { hook } = load(f.sdk, f.api);
  const result = await hook.publish({ lowLatency: false });
  assert.equal(result.success, false);
  assert.match(result.message, /Agora App ID/);
  assert.equal(f.counts().closed, 1);
});

test('auto-pause leaves RTC but retains capture, then resumes with the same UID without asking for a new screen', async () => {
  const f = fixture(); let captures = 0; const uids: unknown[] = [];
  const capture = f.sdk.createScreenVideoTrack; f.sdk.createScreenVideoTrack = async () => { captures++; return capture(); };
  const credentials = f.api.getShareToken; (f.api as any).getShareToken = async (_token: string, _role: string, uid: unknown) => { uids.push(uid); return credentials(); };
  const { hook } = load(f.sdk, f.api);
  await hook.publish({ lowLatency: false }); await hook.pause();
  assert.equal(f.counts().closed, 0); assert.equal(f.counts().left, 1);
  assert.equal(await hook.resume(), true); assert.equal(captures, 1); assert.deepEqual(uids, [undefined, 1]);
  await hook.stop(); assert.equal(f.counts().closed, 1);
});

test('stopping while auto-resume credentials are pending prevents rejoin and closes retained capture', async () => {
  const f = fixture(); let joins = 0; f.client.join = async () => { joins++; };
  const { hook } = load(f.sdk, f.api); await hook.publish({ lowLatency: false }); await hook.pause();
  let release!: (value: any) => void; const credentials = await f.api.getShareToken();
  f.api.getShareToken = () => new Promise(resolve => { release = resolve; });
  const resuming = hook.resume(); const stopped = hook.stop(); release(credentials);
  await assert.rejects(resuming, /cancelled/); await stopped;
  assert.equal(joins, 1); assert.equal(f.counts().closed, 1);
});

test('capture ending while paused closes the retained track and cannot auto-resume', async () => {
  const f = fixture(); let stopped = 0;
  const { hook } = load(f.sdk, f.api, () => stopped++);
  await hook.publish({ lowLatency: false }); await hook.pause();
  f.events['track-ended'](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1); assert.equal(f.counts().closed, 1); assert.equal(await hook.resume(), false);
});

for (const lowLatency of [false, true]) {
  for (const optimizationMode of ['detail', 'motion', undefined]) {
    test(`capture uses ${optimizationMode ?? 'default motion'} with lowLatency=${lowLatency}`, async () => {
      const f = fixture();
      let capturedMode: string | undefined;
      const capture = f.sdk.createScreenVideoTrack;
      (f.sdk as any).createScreenVideoTrack = async (config: any) => {
        capturedMode = config.optimizationMode;
        return capture();
      };
      const { hook } = load(f.sdk, f.api);
      assert.equal((await hook.publish({ lowLatency, optimizationMode })).success, true);
      assert.equal(capturedMode, optimizationMode ?? 'motion');
      await hook.stop();
    });
  }
}
