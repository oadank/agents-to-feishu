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
