/**
 * Tests for patch-agent-host-gate.js
 *
 * 覆盖:
 *   - 锚点存在 → 强制 `this._agentHostEnabled=false` + marker, 幂等
 *   - 无锚点 (pre-3.23) → 静默跳过
 *   - patch 后仍可被 acorn 解析 (语法未破坏)
 *   - inspect / check 报告正确
 *   - 真实 3.23.12 workbench 副本可选验证 (env BYOK_REAL_BUNDLE=1)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acorn from 'acorn';

import {
  AGENT_HOST_GATE_MARKER,
  checkAgentHostGatePatch,
  inspectAgentHostGatePatch,
  isAgentHostGateFullyPatched,
  isAgentHostGatePatched,
  needsAgentHostGatePatch,
  patchAgentHostGate,
} from '../src/patch-agent-host-gate.js';

/** 模拟 3.23.12 压缩产物中的 enablement service 片段 */
const FIXTURE_WITH_ANCHOR = '/*header*/'
  + 'var yc={localMode:!1};'
  + 'class CursorAgentHostEnablementService{'
  + 'constructor(e,t,i){var r=!1;'
  + 'if(!yc.localMode)try{r=e.checkFeatureGate("cursor_agent_host",{disableExposureLog:i})}'
  + 'catch(s){t.error("x")}'
  + 'this._agentHostEnabled=r||i,t.info(`[CursorAgentHostEnablementService] cursor_agent_host gate is ${r?"enabled":"disabled"}`)}'
  + 'isCursorAgentHostEnabled(){return this._agentHostEnabled}}'
  + '/*tail*/';

const FIXTURE_NO_ANCHOR = '/*old*/var a=1;function f(){return a+1}/*end*/';

function makePaths(desktopSource, glassSource) {
  const dir = mkdtempSync(join(tmpdir(), 'byok-gate-'));
  const workbenchJs = join(dir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  const glassJs = join(dir, 'out', 'vs', 'workbench', 'workbench.glass.main.js');
  const productJson = join(dir, 'product.json');
  mkdirSync(join(dir, 'out', 'vs', 'workbench'), { recursive: true });
  writeFileSync(workbenchJs, desktopSource);
  if (glassSource !== null) writeFileSync(glassJs, glassSource);
  writeFileSync(productJson, JSON.stringify({ checksums: {} }));
  return { dir, paths: { appRoot: dir, workbenchJs, glassJs, productJson } };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('forces the gate off and is idempotent', () => {
  const { dir, paths } = makePaths(FIXTURE_WITH_ANCHOR, FIXTURE_WITH_ANCHOR);
  try {
    assert.equal(needsAgentHostGatePatch(paths), true);
    assert.equal(isAgentHostGateFullyPatched(paths), false);

    const changed = patchAgentHostGate(paths);
    assert.equal(changed, 2, 'both renderer bundles patched');

    const out = readFileSync(paths.workbenchJs, 'utf-8');
    assert.ok(out.includes(AGENT_HOST_GATE_MARKER), 'marker present');
    assert.ok(out.includes('this._agentHostEnabled=false'), 'flag forced to false');
    assert.ok(!out.includes('this._agentHostEnabled=r||i'), 'original RHS replaced');
    // 关键: 赋值语句后面的日志调用必须原样保留 (不能被当成 RHS 吞掉)
    assert.ok(
      out.includes(',t.info(`[CursorAgentHostEnablementService] cursor_agent_host gate is ${r?"enabled":"disabled"}`)'),
      'following log call preserved',
    );
    // 未破坏其余代码
    assert.ok(out.includes('isCursorAgentHostEnabled(){return this._agentHostEnabled}}'));
    assert.ok(out.includes('/*header*/') && out.includes('/*tail*/'));

    assert.equal(isAgentHostGatePatched(out), true);
    assert.equal(needsAgentHostGatePatch(paths), false);
    assert.equal(isAgentHostGateFullyPatched(paths), true);

    // 幂等: 第二次不再改动
    assert.equal(patchAgentHostGate(paths), 0);
    assert.equal(readFileSync(paths.workbenchJs, 'utf-8'), out);
  }
  finally { cleanup(dir); }
});

test('patched output is still valid JavaScript', () => {
  const { dir, paths } = makePaths(FIXTURE_WITH_ANCHOR, null);
  try {
    patchAgentHostGate(paths);
    const out = readFileSync(paths.workbenchJs, 'utf-8');
    // 整段 fixture 可解析
    assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }));
    // 赋值点右侧仍是合法表达式: 第一个元素为 false, 后面的日志调用继续存在
    const rhsStart = out.indexOf('this._agentHostEnabled=') + 'this._agentHostEnabled='.length;
    let node = acorn.parseExpressionAt(out, rhsStart, { ecmaVersion: 'latest', sourceType: 'module' });
    const seqLen = node.type === 'SequenceExpression' ? node.expressions.length : 1;
    if (node.type === 'SequenceExpression') node = node.expressions[0];
    assert.equal(node.type, 'Literal');
    assert.equal(node.value, false);
    assert.ok(seqLen >= 2, 'log call still part of the statement');
  }
  finally { cleanup(dir); }
});

test('skips builds without the anchor (pre-3.23)', () => {
  const { dir, paths } = makePaths(FIXTURE_NO_ANCHOR, null);
  try {
    assert.equal(needsAgentHostGatePatch(paths), false);
    assert.equal(isAgentHostGateFullyPatched(paths), true);
    assert.equal(patchAgentHostGate(paths), 0);
    assert.equal(readFileSync(paths.workbenchJs, 'utf-8'), FIXTURE_NO_ANCHOR);
  }
  finally { cleanup(dir); }
});

test('inspect + check report per-target state', () => {
  const { dir, paths } = makePaths(FIXTURE_WITH_ANCHOR, FIXTURE_NO_ANCHOR);
  try {
    let report = inspectAgentHostGatePatch(paths);
    assert.equal(report.find(r => r.label === 'desktop').hasAnchor, true);
    assert.equal(report.find(r => r.label === 'desktop').patched, false);
    assert.equal(report.find(r => r.label === 'glass').hasAnchor, false);

    assert.equal(checkAgentHostGatePatch(paths), true, 'dry-run matchable');

    patchAgentHostGate(paths);
    report = inspectAgentHostGatePatch(paths);
    assert.equal(report.find(r => r.label === 'desktop').patched, true);
  }
  finally { cleanup(dir); }
});

test('optional: real 3.23.12 renderer bundle', { skip: process.env.BYOK_REAL_BUNDLE !== '1' }, () => {
  const real = process.env.BYOK_REAL_BUNDLE_PATH
    || '/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js';
  if (!existsSync(real)) return;
  const { dir, paths } = makePaths(readFileSync(real, 'utf-8'), null);
  try {
    if (isAgentHostGatePatched(readFileSync(paths.workbenchJs, 'utf-8'))) {
      // 真机已打过补丁 (例如本地已应用) → 幂等跳过
      assert.equal(patchAgentHostGate(paths), 0);
      assert.equal(isAgentHostGateFullyPatched(paths), true);
      return;
    }
    assert.equal(needsAgentHostGatePatch(paths), true);
    const changed = patchAgentHostGate(paths);
    assert.equal(changed, 1);
    const out = readFileSync(paths.workbenchJs, 'utf-8');
    assert.ok(out.includes('this._agentHostEnabled=false'));
    assert.ok(out.includes(AGENT_HOST_GATE_MARKER));
  }
  finally { cleanup(dir); }
});
