import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(status: string, viewers: number) {
  const slots: any[] = [], deps: any[][] = [], pending: Array<() => void> = [];
  let cursor = 0, stops = 0, resumes = 0, confirmations = 0;
  const socket: any = { status, graceReason: status === 'grace' ? 'stopped' : null, viewerCount: viewers, ended: false,
    connected: true, async startSharing(_quality: string, _clientId: string, _mode: boolean, automatic: boolean) {
      assert.equal(automatic, true); confirmations++; socket.status = 'active'; return { ok: true };
    }, async stopSharing() {}, async endSharing() {},
  };
  const screen: any = { isSharing: false, isPaused: false,
    async stop() { stops++; screen.isSharing = false; }, async resume() { resumes++; return true; }, async pause() {},
  };
  const hooks = {
    useCallback: (fn: any) => fn,
    useRef(value: any) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value: any) {
      const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value;
      return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useEffect(fn: () => void, next: any[]) {
      const i = cursor++; const before = deps[i];
      if (!before || next.some((value, index) => value !== before[index])) pending.push(fn);
      deps[i] = next;
    },
  };
  const source = readFileSync(join(__dirname, '../../web/src/pages/SharePage.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as any };
  const info = { platform: 'heychat', quality: '480p_2', allowedQualities: ['480p_2'] };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Date, document: { cookie: '' }, crypto: { randomUUID: () => 'publisher' },
    window: { addEventListener() {}, removeEventListener() {}, setInterval() { return 1; }, clearInterval() {} },
    sessionStorage: { getItem: () => null, removeItem() {} }, setInterval: () => 1, clearInterval() {},
    require(name: string) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx() { return {}; }, jsxs() { return {}; } };
      if (name === 'react-router-dom') return { useSearchParams: () => [{ get: () => 'test-token' }] };
      if (name.includes('useSessionSSE')) return { useSessionSSE: () => socket };
      if (name.includes('useScreenShare')) return { useScreenShare: () => screen, QUALITY_OPTIONS: [{ key: '480p_2', encoderConfig: {} }] };
      if (name.includes('/api')) return { api: { getShareInfo: async () => info }, ApiError: Error };
      if (name.includes('clientEnv')) return { markPageOpenOnce: () => false };
      if (name.includes('utils')) return { cn: () => '' };
      return {};
    },
  });
  const render = async () => { cursor = 0; module.exports.default(); for (const effect of pending.splice(0)) effect(); await flush(); };
  await render(); await render();
  return { socket, screen, render, counts: () => ({ stops, resumes, confirmations }) };
}

test('a viewer arriving before the pause operation cancels it and confirms the still-published capture', async () => {
  const f = await fixture('auto_paused', 1); f.screen.isSharing = true;
  await f.render(); await f.render();
  assert.deepEqual(f.counts(), { stops: 0, resumes: 0, confirmations: 1 });
  assert.equal(f.socket.status, 'active');
});

test('manual capture in stopped grace is allowed, but a later server stop transition cancels it', async () => {
  const f = await fixture('grace', 1); f.screen.isSharing = true;
  await f.render(); assert.equal(f.counts().stops, 0);
  f.socket.status = 'active'; f.socket.graceReason = null; await f.render();
  f.socket.status = 'grace'; f.socket.graceReason = 'stopped'; await f.render();
  assert.equal(f.counts().stops, 1);
});
