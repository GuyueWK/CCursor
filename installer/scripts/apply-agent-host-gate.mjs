/**
 * apply-agent-host-gate.mjs — 只应用「cursor_agent_host 门闩强制关闭」这一个补丁。
 *
 * 用途: 不想重跑整条 installer 流程时, 单独把方案 1 应用到已安装的 Cursor。
 * 影响面最小: 只改 2 个 renderer bundle (desktop/glass) + product.json checksum,
 * 且都会先按 tag `agent-host-gate` 备份 —— 可用 `ccursor uninstall` 或手工回滚。
 *
 * 前置: 需要 `installer/node_modules` 里能解析到 acorn (即先 `npm install`,
 *       或在仓库里建一个指向含 acorn 的 node_modules 的软链)。
 *
 * 运行:
 *   cd installer
 *   node scripts/apply-agent-host-gate.mjs
 *
 * 注意 (macOS): 写入 /Applications/<某 App>.app 需要「系统设置 → 隐私与安全性 →
 * App 管理」权限。若报 EPERM: operation not permitted, 请给你的终端/调用方授予
 * App 管理权限后重试。普通用户身份下, 由 Cursor 自身写自己的 bundle 是允许的,
 * 因此插件的 npx installer 才可成功。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  inspectAgentHostGatePatch,
  needsAgentHostGatePatch,
  patchAgentHostGate,
} from '../src/patch-agent-host-gate.js';
import { findCursorPathsDetailed, formatDiagnostic } from '../src/detect.js';

const here = dirname(fileURLToPath(import.meta.url));

function main() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.error('[X] Cursor installation not found');
    console.error(formatDiagnostic(diagnostic));
    process.exit(1);
  }

  console.log(`Cursor: ${paths.appRoot}`);
  console.log('--- BEFORE ---');
  console.log(JSON.stringify(inspectAgentHostGatePatch(paths), null, 2));

  if (!needsAgentHostGatePatch(paths)) {
    console.log('[agent-gate] nothing to do (already off, or this build has no cursor_agent_host topology)');
    return;
  }

  const log = m => console.log(m);
  let changed;
  try {
    changed = patchAgentHostGate(paths, log);
  }
  catch (e) {
    console.error(`\n[X] ${e.message}`);
    if (String(e.message).includes('EPERM') || String(e.cause?.message || '').includes('EPERM')) {
      console.error('[X] macOS App Management permission missing — grant it to your terminal and retry.');
    }
    process.exit(1);
  }

  console.log('--- AFTER ---');
  console.log(`changed files: ${changed}`);
  console.log(JSON.stringify(inspectAgentHostGatePatch(paths), null, 2));
  console.log('\n[OK] Restart Cursor for the change to take effect.');
}

// 保留 here 供将来相对路径扩展使用 (避免未使用告警)
void here;
void existsSync;
void join;

main();
