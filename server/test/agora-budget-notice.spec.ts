import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(join(__dirname, '../../web/src/components/AgoraBudgetNotice.tsx'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const moduleObject = { exports: {} as any };
vm.runInNewContext(code, { module: moduleObject, exports: moduleObject.exports, require });
const render = (seconds: number | null, extra = {}) => renderToStaticMarkup(createElement(moduleObject.exports.default, { budget: {
  agoraAccountLabel: '<公开备注>', estimatedRemainingSec: seconds, remainingStandardMinutes: 400, budgetEstimateStatus: 'local_estimate', ...extra,
} }));

test('quota notice distinguishes 15/5 minute warnings, zero and unknown or idle estimates', () => {
  assert.doesNotMatch(render(900), /role="alert"|额度偏低/);
  assert.match(render(899), /role="alert".*账号：&lt;公开备注&gt;.*约 14 分钟.*额度偏低/);
  assert.match(render(299), /约 4 分钟.*额度即将耗尽/);
  assert.match(render(0), /约 0 分钟.*额度即将耗尽/);
  assert.match(render(null, { remainingStandardMinutes: null }), /余量未知/);
  assert.match(render(null), /暂无在线媒体记录/);
  assert.doesNotMatch(render(null), /Infinity|NaN|无限/);
  assert.equal(render(600, { agoraAccountLabel: '' }), '');
});
