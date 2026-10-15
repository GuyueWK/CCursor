/**
 * Agent Host Gate Off — Cursor 3.23+ (`cursor_agent_host` topology)
 *
 * ## 背景 (为什么需要这个补丁)
 *
 * Cursor 3.23 起 Statsig 门 `cursor_agent_host` 默认开启, Agent 轮次从
 * **legacy (进程内实现, Cursor++ 已经在本地拦截)** 切到 **Agent Host 实现**。
 *
 * 在 Remote-SSH 工作区里, Agent Host 跑在**远端** `~/.cursor-server` 的
 * `cursor-agent-host` 扩展进程里; 而 Cursor++ 的 installer 只修补本地
 * `/Applications/Cursor.app`, 够不到远端。于是用户选中的 BYOK 模型 id
 * (如 `model-rahmu1`) 被远端直发官方端点, 返回:
 *
 *   ERROR_BAD_MODEL_NAME / "AI Model Not Found / Model name is not valid: ..."
 *
 * ## 实测依据 (Cursor 3.23.12, renderer.log)
 *
 *   3.23.12: [CursorAgentHostEnablementService] cursor_agent_host gate is enabled,
 *            private inference is disabled, effective agent-host topology is enabled
 *            [AgentHostService] using extension-host implementation
 *            → Remote-SSH 下 Cursor++ 收到 0 次 RunSSE (请求绕过插件)
 *
 *   3.22.12: cursor_agent_host gate is disabled, effective agent-host topology is disabled
 *            [AgentHostService] using legacy implementation
 *            → Remote-SSH 下 RunSSE 由本地 Cursor++ 正常处理 (BYOK 可用)
 *
 * 即: 3.22 那条"能用"的路径就是 legacy; 3.23 把门闩打开后才坏。
 *
 * ## 修补
 *
 * 强制 `CursorAgentHostEnablementService.isCursorAgentHostEnabled()` 恒为 false —
 * 客户端随即退回 legacy 实现 (与 3.22 行为一致), Agent 回到**本地进程**执行,
 * 恢复 Cursor++ 对 RunSSE 的拦截。local 与 remote 工作区同时修复。
 *
 * 目标代码 (minified, desktop / glass 各一份):
 *
 *   }this._agentHostEnabled=r||i,t.info(`[CursorAgentHostEnablementService] ...`)
 *   ...
 *   n.info(`[AgentHostService] using ${t.isCursorAgentHostEnabled()?"extension-host":"legacy"} implementation`)
 *
 * 做法: 定位唯一赋值点 `this._agentHostEnabled=`, 用 acorn.parseExpressionAt
 * 框出右侧表达式的精确 end, 替换为 `false` + marker (不整文件 parse, 与
 * patch-inject 的 parseExpressionAt 策略一致)。
 *
 * 注意: 3.23 客户端**仍保留** legacy 实现分支 (三元表达式里可见), 所以强制
 * 门闩关闭是安全的回退, 而不是指向一个已被删除的路径。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as acorn from 'acorn';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

const TAG = 'agent-host-gate';

/** 幂等标记 —— 同时作为"已修补"的检测依据 */
export const AGENT_HOST_GATE_MARKER = '/*BYOK-AGENT-HOST-GATE-OFF*/';

/** 唯一赋值点 (读取点是 `this._agentHostEnabled?` / `this._agentHostEnabled}`, 不匹配 '=') */
const ASSIGN_NEEDLE = 'this._agentHostEnabled=';
/** 兜底: 任意 `_agentHostEnabled=` (理论上仅赋值点命中) */
const FIELD_NEEDLE = '_agentHostEnabled=';

/** renderer 目标 (desktop + glass 都可能承载 enablement service) */
export function getAgentHostGateTargets(paths) {
  return [
    { path: paths.workbenchJs, label: 'desktop' },
    { path: paths.glassJs, label: 'glass' },
  ];
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf-8') : null;
}

/** 该源码是否已打上本补丁 */
export function isAgentHostGatePatched(source) {
  return typeof source === 'string' && source.includes(AGENT_HOST_GATE_MARKER);
}

/** 该 Cursor 版本是否带 `cursor_agent_host` 拓扑 (pre-3.23 无此锚点) */
export function hasAgentHostGateAnchor(source) {
  return typeof source === 'string' && source.includes(FIELD_NEEDLE);
}

/** 是否至少有一个目标仍需修补 (存在锚点且未打) */
export function needsAgentHostGatePatch(paths) {
  return getAgentHostGateTargets(paths).some(({ path }) => {
    const code = readIfExists(path);
    return code !== null && hasAgentHostGateAnchor(code) && !isAgentHostGatePatched(code);
  });
}

/** 所有需要修补的目标都已完成 (无锚点/文件缺失视作"无需") */
export function isAgentHostGateFullyPatched(paths) {
  return getAgentHostGateTargets(paths).every(({ path }) => {
    const code = readIfExists(path);
    if (code === null) return true;
    if (!hasAgentHostGateAnchor(code)) return true;
    return isAgentHostGatePatched(code);
  });
}

/** status 用: 逐目标报告 present / hasAnchor / patched */
export function inspectAgentHostGatePatch(paths) {
  return getAgentHostGateTargets(paths).map(({ path, label }) => {
    const code = readIfExists(path);
    return {
      label,
      path,
      present: code !== null,
      hasAnchor: code !== null && hasAgentHostGateAnchor(code),
      patched: code !== null && isAgentHostGatePatched(code),
    };
  });
}

/** 定位赋值点右侧表达式的 [start, end) */
function locateRhs(code, label) {
  let at = code.indexOf(ASSIGN_NEEDLE);
  let rhsStart;
  if (at !== -1) {
    rhsStart = at + ASSIGN_NEEDLE.length;
  }
  else {
    at = code.indexOf(FIELD_NEEDLE);
    if (at === -1) return null;
    rhsStart = at + FIELD_NEEDLE.length;
  }

  let node;
  try {
    node = acorn.parseExpressionAt(code, rhsStart, { ecmaVersion: 'latest', sourceType: 'module' });
  }
  catch (e) {
    throw new Error(`[agent-gate] ${label}: cannot parse RHS at offset ${rhsStart}: ${e.message}`);
  }
  if (!node || typeof node.end !== 'number' || node.end <= rhsStart) {
    throw new Error(`[agent-gate] ${label}: invalid RHS expression at offset ${rhsStart}`);
  }
  // 赋值号右侧永远不会是顶层 SequenceExpression (逗号优先级低于赋值):
  // `this.X=RHS,rest` 会被解析为 Sequence(RHS, rest) —— 取第一个元素才能
  // 精确框住 RHS, 否则会把后面的 `,t.info(...)` 一起吞掉。
  if (node.type === 'SequenceExpression' && node.expressions.length > 0) {
    node = node.expressions[0];
  }
  if (node.end <= rhsStart) {
    throw new Error(`[agent-gate] ${label}: RHS expression is empty at offset ${rhsStart}`);
  }
  return { rhsStart, end: node.end, source: code.slice(rhsStart, node.end) };
}

/**
 * 应用补丁。返回被修改的文件数。
 * 无锚点 (pre-3.23) 时静默跳过; 有锚点但结构不符时抛出 (fail loud)。
 */
export function patchAgentHostGate(paths, log) {
  if (!needsAgentHostGatePatch(paths)) {
    if (isAgentHostGateFullyPatched(paths)) {
      log?.('[agent-gate] cursor_agent_host topology not present or already off');
    }
    return 0;
  }

  const modified = [];
  for (const { path, label } of getAgentHostGateTargets(paths)) {
    if (!existsSync(path)) {
      log?.(`[agent-gate] ${label}: not found, skipping`);
      continue;
    }
    const code = readFileSync(path, 'utf-8');
    if (isAgentHostGatePatched(code)) {
      log?.(`[agent-gate] ${label}: already patched`);
      continue;
    }
    if (!hasAgentHostGateAnchor(code)) {
      log?.(`[agent-gate] ${label}: no ${FIELD_NEEDLE} anchor, skipping`);
      continue;
    }

    const rhs = locateRhs(code, label);
    if (!rhs) {
      throw new Error(`[agent-gate] ${label}: assignment anchor not found`);
    }
    // 压缩产物里 RHS 必然很短且不含换行; 否则说明定位偏了, 宁可不改
    if (rhs.source.length > 200 || rhs.source.includes('\n')) {
      throw new Error(`[agent-gate] ${label}: RHS looks wrong ("${rhs.source.slice(0, 60)}")`);
    }

    const patched = code.slice(0, rhs.rhsStart) + 'false' + AGENT_HOST_GATE_MARKER + code.slice(rhs.end);
    if (patched === code || !isAgentHostGatePatched(patched)) {
      throw new Error(`[agent-gate] ${label}: patch produced no change`);
    }

    createBackup(path, TAG, log);
    writeFileSync(path, patched);
    modified.push(path);
    log?.(`[agent-gate] ${label}: cursor_agent_host forced off (was "${rhs.source}")`);
  }

  if (modified.length > 0) {
    updateChecksums(paths, modified, TAG, log);
    log?.('[agent-gate] Done');
  }
  return modified.length;
}

/** `ccursor check` 干跑: 验证锚点可匹配 */
export function checkAgentHostGatePatch(paths, log) {
  let ok = true;
  for (const { path, label } of getAgentHostGateTargets(paths)) {
    if (!existsSync(path)) {
      log?.(`[check] agent-gate ${label}: not found (skip)`);
      continue;
    }
    const code = readFileSync(path, 'utf-8');
    if (isAgentHostGatePatched(code)) {
      log?.(`[check] agent-gate ${label}: already patched`);
      continue;
    }
    if (!hasAgentHostGateAnchor(code)) {
      log?.(`[check] agent-gate ${label}: no anchor (pre-3.23, skip)`);
      continue;
    }
    try {
      const rhs = locateRhs(code, label);
      if (!rhs) throw new Error('assignment anchor not found');
      log?.(`[check] agent-gate ${label}: matchable (RHS "${rhs.source}")`);
    }
    catch (e) {
      log?.(`[check] agent-gate ${label}: FAILED — ${e.message}`);
      ok = false;
    }
  }
  return ok;
}
