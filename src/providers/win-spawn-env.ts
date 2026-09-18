/**
 * Windows 服务 spawn 的 PATH 补全（统一收口，2026-08-31）。
 *
 * 背景/坑：SCM 环境快照 —— nssm 服务进程的 PATH 是服务启动时的快照，系统 PATH 变更
 * （如新装 gh CLI）不重启系统就不生效。此前 mimo/dsh/openakita/openclaw/reasonix/opencode
 * 6 个 provider 各自维护一份补全列表（复制 6 份），新增目录要改 6 处，漏改就表现为
 * "agent 说命令不存在"。现在统一从这里出，新目录只改 BASE_PATH_ENTRIES。
 */
export const BASE_PATH_ENTRIES: readonly string[] = [
  'C:\\WINDOWS\\system32',
  'C:\\WINDOWS',
  'C:\\WINDOWS\\System32\\Wbem',
  'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0',
  'C:\\Program Files\\nodejs',
  'C:\\Users\\oadan\\AppData\\Roaming\\npm',
  'C:\\Program Files\\Git\\bin',
  'C:\\Program Files\\Git\\usr\\bin',
  'C:\\Program Files\\Git\\cmd',
  'C:\\Program Files\\GitHub CLI',
];

/** 拼完整 PATH：父进程 PATH 在前（优先匹配），基础目录兜底在后。非 Windows 原样返回 parentPath。 */
export function buildWindowsPath(parentPath?: string): string {
  const entries = (parentPath || '').split(';').filter(Boolean);
  return [...entries, ...BASE_PATH_ENTRIES].join(';');
}

/**
 * 从 env 对象里按**大小写不敏感**方式取 PATH。
 *
 * [2026-09-17 修复] Windows 上 `Object.entries(process.env)` 枚举出的键名是系统原始大小写
 * （通常是 `Path` 而不是 `PATH`）。各 provider 的 `buildSpawnEnv` 会把它拷进一个**普通 JS 对象**
 * （`const clean = {}`，大小写敏感）→ 随后读 `clean.PATH` 得到 `undefined` → **父进程 PATH 被整段丢弃**，
 * 最终 PATH 只剩 BASE_PATH_ENTRIES。
 *
 * 实测证据：reasonix 报告 `$env:PATH` 前 6 项与 BASE_PATH_ENTRIES 逐项对应，父 PATH 完全消失；
 * 而用 `buildWindowsPath(process.env.PATH)` 的 provider（Node 的 process.env 本身大小写不敏感）
 * 一切正常 —— 这一差异正是本 bug 的判定依据。
 *
 * @param env - 环境对象（普通对象或 process.env）。
 * @returns PATH 值；找不到返回 undefined。
 */
export function getEnvPath(env: NodeJS.ProcessEnv | Record<string, unknown>): string | undefined {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== 'path') continue;
    const value = (env as Record<string, unknown>)[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}