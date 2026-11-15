import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

async function fixture(preferences = { volume: 100, muted: false }) {
  const effects: Array<() => (() => void) | void> = [];
  const listeners = new Map<string, (...args: any[]) => any>();
  let state: any;
  const client = {
    on(event: string, fn: (...args: any[]) => any) { listeners.set(event, fn); },
    removeAllListeners() { listeners.clear(); },
    async join() {}, async leave() {}, async subscribe() {}, async setClientRole() {},
  };
  const sdk: any = { setLogLevel() {}, createClient: () => client };
  const module = { exports: {} as any };
  const source = readFileSync(join(__dirname, '../../web/src/hooks/useAgoraView.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, window: { AgoraRTC: sdk }, AbortController,
    require(name: string) {
      if (name === 'react') return {
        useCallback: (fn: any) => fn, useEffect: (fn: any) => effects.push(fn),
        useRef: (value: any) => ({ current: value }),
        useState(value: any) { state = value; return [state, (next: any) => { state = typeof next === 'function' ? next(state) : next; }]; },
      };
      if (name.includes('rtcLifecycle')) return { createRtcLog: () => () => {}, rtcErrorCode: () => 'RTC_ERROR', installRtcTokenRenewal: () => ({ dispose: async () => {} }) };
      if (name.includes('/api')) return { api: { getShareToken: async () => ({ appId: 'app', channel: 'channel', uid: 234, token: 'test-token' }) } };
      throw new Error(name);
    },
  });
  const hook = module.exports.useAgoraView('test-share-token', true, true, preferences);
  const cleanups = effects.map(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  return { hook, sdk, state: () => state,
    emit: async (event: string, ...args: any[]) => { await listeners.get(event)?.(...args); },
    cleanup: () => { for (const fn of cleanups) if (typeof fn === 'function') fn(); },
  };
}

test('another RTC viewer leaving does not clear the publisher video', async () => {
  const f = await fixture(); let stops = 0;
  const publisher = { uid: 1, hasVideo: true, videoTrack: { play() {}, stop() { stops++; } } };
  await f.emit('user-published', publisher, 'video');
  await f.emit('user-left', { uid: 456 }, 'Quit');
  assert.equal(f.state().hasVideo, true);
  assert.equal(stops, 0);
  await f.emit('user-left', publisher, 'Quit');
  assert.equal(f.state().hasVideo, false);
  f.cleanup();
});

test('resubscribed audio uses the current volume and mute state', async () => {
  const f = await fixture(); const volumes: number[] = [];
  const audio = () => ({ play() {}, stop() {}, setVolume(value: number) { volumes.push(value); } });
  const publisher = { uid: 1, hasAudio: true, audioTrack: audio() };
  f.hook.setVolume(37); f.hook.setAudioMuted(true);
  await f.emit('user-published', publisher, 'audio');
  assert.equal(volumes.at(-1), 0);
  f.hook.setAudioMuted(false);
  assert.equal(volumes.at(-1), 37);
  await f.emit('user-unpublished', publisher, 'audio');
  publisher.audioTrack = audio();
  await f.emit('user-published', publisher, 'audio');
  assert.equal(volumes.at(-1), 37);
  f.cleanup();
});

test('stored audio preferences apply before the first playback and survive autoplay blocking', async () => {
  const f = await fixture({ volume: 28, muted: true });
  const volumes: number[] = [];
  const publisher = { uid: 1, hasAudio: true, audioTrack: {
    play() { assert.equal(volumes.at(-1), 0); }, stop() {}, setVolume(value: number) { volumes.push(value); },
  } };
  await f.emit('user-published', publisher, 'audio');
  assert.equal(volumes.at(-1), 0);
  f.sdk.onAutoplayFailed();
  assert.equal(f.state().audioBlocked, true);
  f.hook.setAudioMuted(false);
  assert.equal(volumes.at(-1), 28);
  assert.equal(f.state().audioBlocked, false);
  await f.emit('user-unpublished', publisher, 'audio');
  publisher.audioTrack.play = () => { assert.equal(volumes.at(-1), 28); };
  await f.emit('user-published', publisher, 'audio');
  f.cleanup();
});
