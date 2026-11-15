import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(raw: string | null = null, blocked = false) {
  const module = { exports: {} as any };
  const source = readFileSync(join(__dirname, '../../web/src/lib/viewPreferences.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const storage = new Map<string, string>(raw === null ? [] : [['xgoat_view_preferences', raw]]);
  vm.runInNewContext(code, { module, exports: module.exports, localStorage: {
    getItem(key: string) { if (blocked) throw new Error('storage blocked'); return storage.get(key) ?? null; },
    setItem(key: string, value: string) { if (blocked) throw new Error('storage blocked'); storage.set(key, value); },
  } });
  return module.exports;
}

test('view preferences keep one validated, same-origin record across viewing links', () => {
  const f = fixture();
  assert.equal(JSON.stringify(f.readViewPreferences()), JSON.stringify({ theme: 'light', volume: 100, muted: false, pageFullscreen: false }));
  const saved = { theme: 'dark', volume: 31, muted: true, pageFullscreen: true };
  f.saveViewPreferences(saved);
  assert.equal(JSON.stringify(f.readViewPreferences()), JSON.stringify(saved));
});

test('malformed and unavailable storage leave viewing usable; volume stays in range', () => {
  for (const raw of ['{', 'null', '[]', '{"theme":"system","volume":"50","muted":"true"}']) {
    assert.equal(fixture(raw).readViewPreferences().volume, 100);
    assert.equal(fixture(raw).readViewPreferences().theme, 'light');
    assert.equal(fixture(raw).readViewPreferences().muted, false);
  }
  assert.equal(fixture('{"volume":999}').readViewPreferences().volume, 100);
  assert.equal(fixture('{"volume":-1}').readViewPreferences().volume, 0);
  const f = fixture(null, true);
  assert.doesNotThrow(() => f.saveViewPreferences(f.readViewPreferences()));
});
