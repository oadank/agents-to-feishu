/**
 * DSH ACP 启动计划（诊断脚本共用）。
 *
 * 与 src/providers/dsh.ts 的 resolveDshCommand 保持同一形状：
 *   node apps/cli/lib/bin.js --profile acp --patch <bot>/acp.patch.yml   （产物在时）
 *   node --import tsx/esm apps/cli/src/bin.ts --profile acp --patch ...  （只有源码时）
 *
 * [2026-09-16] 旧入口 packages/examples/acp-demo/src/bin.ts 已不存在（examples 只剩
 * package.json 与陈旧 lib），各诊断脚本照旧路径 spawn 必然 ENOENT，故收敛到这里。
 * `--patch` 是 acp profile 的配置来源；没派生过 patch 时回落到 `--config <cordis.yml>`。
 *
 * 用法：const plan = dshAcpSpawnPlan(); spawn(plan.command, plan.args, { cwd: plan.cwd, env: dshAcpEnv() })
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Harness 根目录（与 CTI_DSH_HARNESS_PATH 同源）。 */
export function harnessRoot() {
  return process.env.CTI_DSH_HARNESS_PATH || 'C:\\D\\opt\\deepseek-harness\\deepseek-harness';
}

/** bot 的 ACP cordis.yml（决定 stats/patch 落点）。 */
export function acpConfigPath() {
  return process.env.CTI_DSH_ACP_CONFIG || path.join(os.homedir(), '.dsh', 'dsh-bot', 'cordis.yml');
}

/**
 * 组装 spawn 计划。
 * @param {{config?: string, harness?: string}} [overrides] - 显式指定配置/仓库根。
 * @returns {{command: string, args: string[], cwd: string, config: string, patch: string | null}}
 */
export function dshAcpSpawnPlan(overrides = {}) {
  const harness = overrides.harness || harnessRoot();
  const config = overrides.config || acpConfigPath();
  const builtEntry = path.join(harness, 'apps', 'cli', 'lib', 'bin.js');
  const sourceEntry = path.join(harness, 'apps', 'cli', 'src', 'bin.ts');
  const useBuilt = fs.existsSync(builtEntry);
  if (!useBuilt && !fs.existsSync(sourceEntry)) {
    throw new Error(`DSH harness entry not found under ${harness} (set CTI_DSH_HARNESS_PATH)`);
  }
  const args = useBuilt
    ? ['apps/cli/lib/bin.js', '--profile', 'acp']
    : ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp'];
  // patch 由配置中心/桥从 cordis.yml 派生，落在那个 bot 目录里；存在就优先用它，
  // 否则退回 --config（此时模型/provider 走 cordis.yml 原样，不含派生的 provider 段）。
  const patch = path.join(path.dirname(config), 'acp.patch.yml');
  const hasPatch = fs.existsSync(config) && fs.existsSync(patch);
  if (hasPatch) args.push('--patch', patch);
  else if (fs.existsSync(config)) args.push('--config', config);
  return { command: process.execPath, args, cwd: harness, config, patch: hasPatch ? patch : null };
}

/**
 * spawn 环境：剥掉继承的 DSH_*（harness 的 BOOTSTRAP_PREFIXES 禁 .env 带 DSH_*，
 * 父进程注入才是受信通道），补 DSH_HOME 与 Windows 必需系统变量。
 * @param {Record<string, string>} [extra] - 额外注入（如 DSH_HOME 覆盖）。
 * @returns {NodeJS.ProcessEnv}
 */
export function dshAcpEnv(extra = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_') || value === undefined) continue;
    clean[key] = value;
  }
  const base = { ...clean, DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), ...extra };
  if (process.platform !== 'win32') return base;
  return {
    ...base,
    ComSpec: base.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe',
    SystemRoot: base.SystemRoot || 'C:\\WINDOWS',
  };
}
