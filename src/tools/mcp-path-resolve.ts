/**
 * MCP stdio 参数路径解析（2026-09-05，"别人下载即用"配套）。
 *
 * config-store 里 MCP 的 command/args 可能带着当初配置那台机器的安装路径（如
 * win-desktop-helper 的 exe 安装目录）。别人装了同一个 exe 但安装目录不同时，
 * 按已知安装锚点自动重定位：
 *   1. Inno Setup 注册表 InstallLocation（AppId 固定）；
 *   2. 厂商标准安装位（%LOCALAPPDATA%\Programs\<name>）。
 * 规则：只对"配置里不存在于本机的绝对路径参数"按文件名重定位；找不到原样返回
 * ——让下游报明确的 ENOENT，而不是静默换错文件。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 已知安装锚点：MCP id → 候选安装目录解析器（返回候选目录列表） */
const INSTALL_ANCHORS: Record<string, () => string[]> = {
  // win-desktop-helper：Inno Setup AppId 固定（setup.iss AppId={FE6F68E9-...}）
  'win-desktop-helper': (): string[] => {
    const out: string[] = [];
    try {
      const reg = execSync(
        'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{FE6F68E9-0CEB-450B-B438-49BFDF5FFB15}_is1" /v InstallLocation',
        { encoding: 'utf-8', timeout: 8000 },
      );
      const m = reg.match(/InstallLocation\s+REG_SZ\s+(.+)/);
      if (m) out.push(m[1].trim());
    } catch { /* 未安装/无注册表项 */ }
    out.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'win-desktop-helper'));
    return out;
  },
};

const resolveCache = new Map<string, string>(); // 原路径 → 解析后路径（进程级缓存，避免重复查注册表）

/** 解析 MCP stdio 的 args：参数里不存在于本机的绝对路径 → 按锚点重定位 */
export function resolveMcpArgPaths(mcpId: string, args: string[]): string[] {
  return args.map((a) => {
    if (!a || !path.isAbsolute(a)) return a;
    if (fs.existsSync(a)) return a; // 本机存在：原样
    const cacheKey = `${mcpId}:${a}`;
    if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey)!;
    const anchor = INSTALL_ANCHORS[mcpId];
    if (!anchor) return a;
    const base = path.basename(a);
    for (const dir of anchor()) {
      const cand = path.join(dir, base);
      try {
        if (fs.existsSync(cand)) {
          console.log(`[mcp-resolve] ${mcpId}: ${a} → ${cand}`);
          resolveCache.set(cacheKey, cand);
          return cand;
        }
      } catch { /* 忽略 */ }
    }
    resolveCache.set(cacheKey, a);
    return a;
  });
}
