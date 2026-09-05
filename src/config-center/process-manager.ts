/**
 * 内置进程管理器 —— bot 子进程托管（2026-09-05，"别人下载即用"基建）。
 *
 * 背景：本机部署用 nssm 给每个 bot 建系统服务；别人的机器没有 nssm 也不会配。
 * 本模块让配置中心自己托管 bot 子进程：nssm 服务存在 → 生命周期归 nssm（不抢）；
 * 不存在 → 配置中心直接 spawn 守护（崩溃自动重启，指数退避）。别人只跑
 * `npm run config-center` 一个命令，所有 bot 的启停都在网页上。
 *
 * 环境继承：子进程 env = 配置中心进程自身 env + CTI_BOT=<agentId>（不写死任何机器路径，
 * CTI_HOME/CTI_USER_HOME 取配置中心自己的环境，缺省由各模块 os.homedir() 兜底）。
 * 平台：nssm 仅 Windows；非 Windows 一律走子进程托管（为跨平台预留）。
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function log(msg: string): void {
  console.log(`[proc-manager] ${msg}`);
}

export interface ProcInfo {
  agentId: string;
  /** nssm = 系统服务托管；child = 本管理器托管；none = 未运行 */
  mode: 'nssm' | 'child' | 'none';
  pid?: number;
  startedAt?: number;
  restarts: number;
  /** 子进程退出尾巴（排障用，最近 60 行） */
  lastLog: string[];
  lastExit?: { code: number | null; signal: string | null; at: number };
}

interface ManagedChild {
  agentId: string;
  child: ChildProcess | null;
  startedAt: number;
  restarts: number;
  /** 期望运行中（stop() 会置 false，阻止自动重启） */
  desired: boolean;
  lastLog: string[];
  lastExit?: { code: number | null; signal: string | null; at: number };
  restartTimer?: ReturnType<typeof setTimeout>;
}

const children = new Map<string, ManagedChild>();
/** 崩溃重启退避（毫秒序列），全失败后放弃等待人工 */
const RESTART_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
const LOG_TAIL_LINES = 60;

/** tsx 预检/加载器：优先从配置中心自己的 node_modules 解析（与运行时同源，无路径写死） */
function resolveTsx(): { preflight: string; loader: string } {
  const here = path.dirname(fileURLToPath(import.meta.url)); // src/config-center
  const root = path.resolve(here, '..', '..');
  const preflight = path.join(root, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
  const loader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  return { preflight, loader };
}

/** 该 agent 是否有同名 nssm 服务（Windows；其他平台一律 false → 子进程托管） */
export function hasNssmService(agentId: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('C:\\Windows\\System32\\nssm.exe', ['get', agentId, 'Application'], { timeout: 8000 }, (err) => {
      resolve(!err);
    });
  });
}

function nssmAsync(args: string[], timeout = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('C:\\Windows\\System32\\nssm.exe', args, { timeout }, (err) => resolve(!err));
  });
}

function pushTail(m: ManagedChild, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    const t = line.trim();
    if (t) m.lastLog.push(t.slice(0, 300));
  }
  if (m.lastLog.length > LOG_TAIL_LINES) m.lastLog.splice(0, m.lastLog.length - LOG_TAIL_LINES);
}

/** 起一条 bot 子进程（内部；调用方保证无 nssm 服务） */
function spawnChild(agentId: string): void {
  const m: ManagedChild = children.get(agentId) ?? {
    agentId, child: null, startedAt: 0, restarts: 0, desired: true, lastLog: [],
  };
  children.set(agentId, m);
  if (m.child && m.child.exitCode === null) return; // 已在跑

  const { preflight, loader } = resolveTsx();
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
  const env: NodeJS.ProcessEnv = { ...process.env, CTI_BOT: agentId };
  // 兜底关键身份变量（配置中心进程缺省时按本机解析，不写死路径）
  if (!env.CTI_USER_HOME) env.CTI_USER_HOME = os.homedir();
  if (!env.CTI_HOME) env.CTI_HOME = path.join(os.homedir(), '.agents-to-feishu');
  // 桥接进程的 USERPROFILE/HOME 必须指向真实用户目录（index.ts 对 systemprofile 有兜底，这里直接给对）
  env.USERPROFILE = env.CTI_USER_HOME;
  env.HOME = env.CTI_USER_HOME;

  const child = spawn(process.execPath, [
    '--require', preflight,
    '--import', `file:///${loader.replace(/\\/g, '/')}`,
    entry,
  ], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  m.child = child;
  m.startedAt = Date.now();
  m.desired = true;
  log(`child spawned agent=${agentId} pid=${child.pid}`);
  child.stdout?.on('data', (c: Buffer) => pushTail(m, c.toString()));
  child.stderr?.on('data', (c: Buffer) => pushTail(m, c.toString()));
  child.on('error', (err) => {
    pushTail(m, `[spawn error] ${err.message}`);
  });
  child.on('close', (code, signal) => {
    m.lastExit = { code, signal, at: Date.now() };
    m.child = null;
    log(`child exited agent=${agentId} code=${code} signal=${signal} desired=${m.desired}`);
    if (m.desired) {
      // 守护重启：指数退避；上限后放弃（等 apply/手动 start 再拉起）
      const idx = Math.min(m.restarts, RESTART_BACKOFF_MS.length - 1);
      const delay = RESTART_BACKOFF_MS[idx];
      m.restarts += 1;
      if (m.restarts > RESTART_BACKOFF_MS.length * 2) {
        pushTail(m, `[proc-manager] 连续崩溃超过上限，停止自动重启（修完配置后在网页点「启动」）`);
        return;
      }
      pushTail(m, `[proc-manager] ${delay / 1000}s 后自动重启（第 ${m.restarts} 次）`);
      m.restartTimer = setTimeout(() => { if (m.desired) spawnChild(agentId); }, delay);
    }
  });
}

/** 启动一个 agent：有 nssm 服务用 nssm，否则子进程托管。返回实际模式。 */
export async function startAgent(agentId: string): Promise<{ mode: 'nssm' | 'child' }> {
  if (await hasNssmService(agentId)) {
    await nssmAsync(['start', agentId]);
    log(`nssm start ${agentId} ok`);
    return { mode: 'nssm' };
  }
  const m = children.get(agentId);
  if (m) m.restarts = 0; // 手动启动清零崩溃计数
  spawnChild(agentId);
  return { mode: 'child' };
}

/** 停止一个 agent */
export async function stopAgent(agentId: string): Promise<{ mode: 'nssm' | 'child' | 'none' }> {
  if (await hasNssmService(agentId)) {
    await nssmAsync(['stop', agentId]);
    log(`nssm stop ${agentId} ok`);
    return { mode: 'nssm' };
  }
  const m = children.get(agentId);
  if (!m || !m.child) return { mode: 'none' };
  m.desired = false;
  if (m.restartTimer) { clearTimeout(m.restartTimer); m.restartTimer = undefined; }
  try { m.child.kill('SIGTERM'); } catch { /* 已退出 */ }
  return { mode: 'child' };
}

/** 重启：apply 改配置后调用（nssm 优先，子进程杀掉让守护重建，读到新 env/配置） */
export async function restartAgent(agentId: string): Promise<{ mode: 'nssm' | 'child' | 'none' }> {
  if (await hasNssmService(agentId)) {
    await nssmAsync(['restart', agentId]);
    return { mode: 'nssm' };
  }
  const m = children.get(agentId);
  if (!m || !m.child) {
    await startAgent(agentId);
    return { mode: 'child' };
  }
  m.restarts = 0;
  try { m.child.kill('SIGTERM'); } catch { /* 已退出 */ }
  return { mode: 'child' };
}

/** 全量状态（网页进程面板用） */
export function statusAll(): ProcInfo[] {
  const ids = new Set<string>([...children.keys()]);
  return [...ids].map((agentId) => {
    const m = children.get(agentId)!;
    const running = !!m.child && m.child.exitCode === null;
    return {
      agentId,
      mode: running ? 'child' as const : 'none' as const,
      pid: running ? m.child?.pid : undefined,
      startedAt: running ? m.startedAt : undefined,
      restarts: m.restarts,
      lastLog: [...m.lastLog],
      lastExit: m.lastExit,
    };
  });
}

/** 启动时托管引导：对无 nssm 服务的启用 agent 自动拉起（nssm 机器行为不变） */
export async function autoStartEnabled(enabledAgentIds: string[]): Promise<string[]> {
  const started: string[] = [];
  for (const id of enabledAgentIds) {
    try {
      if (await hasNssmService(id)) continue; // nssm 机器：服务自启（SERVICE_AUTO_START），不抢
      const r = await startAgent(id);
      if (r.mode === 'child') started.push(id);
    } catch (e) {
      log(`autoStart ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (started.length) log(`auto-started (child mode): ${started.join(', ')}`);
  return started;
}

/** 配置中心退出时清场：kill 全部托管子进程，避免孤儿 */
export function killAll(): void {
  for (const [, m] of children) {
    m.desired = false;
    if (m.restartTimer) clearTimeout(m.restartTimer);
    try { m.child?.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

/** 保留：判断项目内 tsx 是否存在（缺失时 start 会失败并写进 lastLog） */
export function tsxAvailable(): boolean {
  const { preflight } = resolveTsx();
  try { return fs.existsSync(preflight); } catch { return false; }
}
