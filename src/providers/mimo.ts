/**
 * MiMo Provider — ACP 协议接入 `mimo acp` 进程。
 *
 * 由 agents-to-feishu 统一管理人设/记忆/模型/MCP：
 * - 人设：接收 params.systemPrompt（config-store 统一注入 + 独立注入），首条消息注入
 * - 记忆：会话由 SessionManager 管理，不依赖 openclaw 自有记忆
 * - 模型：走 mimo CLI 自带的网关/模型配置（provider/model 由 CLI 决定）
 *
 * 进程模型：单 ACP 进程 + 进程内多会话（对齐 dsh.ts 常驻模式）。
 * 协议：initialize → session/new → session/prompt → 流式事件（agent_message_chunk /
 * agent_thought_chunk / tool_call），JSON-RPC 2.0 over stdin/stdout。
 */

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeProvider, StreamChatParams, StreamEvent, UsageInfo } from './types.js';
import { readSessionMcpServers } from './shared/per-session-mcp.js';
import { buildWindowsPath, getEnvPath } from './win-spawn-env.js';

// MCP 穿透收编（2026-09-18）：已上收 src/providers/shared/per-session-mcp.ts，
// mimo 引擎行为 = 'stdioOnly'（首轮误判全拒实为 http 条目被拒，二轮 stdio 后真调 lark ✅，见模块注释矩阵）。

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

/** 解析 mimo ACP 启动命令 */
function resolveMiMoCommand(): { command: string; args: string[]; cwd: string } {
  const candidates = [
    'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@mimo-ai\\cli\\node_modules\\@mimo-ai\\mimocode-windows-x64\\bin\\mimo.exe',
    'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@mimo-ai\\cli\\node_modules\\@mimo-ai\\mimocode-windows-x64-baseline\\bin\\mimo.exe',
  ];
  let command = process.env.CTI_MIMO_EXEC || '';
  if (!command) {
    for (const exe of candidates) { if (fs.existsSync(exe)) { command = exe; break; } }
  }
  if (!command) command = 'mimo';
  const cwd = process.env.CTI_DEFAULT_WORKDIR || process.cwd();
  const configCwd = process.env.CTI_MIMO_ACP_CWD || cwd;
  return { command, args: ['acp', '--hostname', '127.0.0.1', '--cwd', configCwd], cwd: configCwd };
}

/**
 * [2026-09-25 老大令·失忆根治] 引擎会话 id 落盘（对齐 workbuddy sessions-wb-acp.json 先例）：
 * 桥侧重启/引擎换代后先用 session/load 赎回旧会话（实测 mimocode 跨进程 resume 记忆完好），
 * 不再一醒就 session/new 开空白会话失忆。
 */
function acpMapFile(): string {
  return path.join(
    process.env.CTI_USER_HOME || os.homedir(),
    '.agents-to-feishu', 'runtime', 'sessions-mimo-acp.json',
  );
}

/** 补齐 Windows 必需系统变量（NSSM 环境残缺） */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue;
    clean[key] = value;
  }
  if (process.platform !== 'win32') return { ...clean };
  const parentPath = (getEnvPath(clean) || '').split(';').filter(Boolean);
  return {
    ...clean,
    ComSpec: clean.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe',
    SystemRoot: clean.SystemRoot || 'C:\\WINDOWS',
    PATH: buildWindowsPath(getEnvPath(clean)),
  };
}

interface AcpSession {
  sessionId: string;
  cwd: string;
  lastUsed: number;
  personaInjected: boolean;
}

interface ActivePrompt {
  promptId: number;
  sessionId: string;
  onUpdate: (msg: any) => void;
  onDone: (err?: string) => void;
}

export class MiMoProvider implements RuntimeProvider {
  readonly name = 'mimo';

  private child: ChildProcess | null = null;
  private lineBuf = '';
  private nextId = 100;
  /** 按 request id 等待的响应 resolver —— 存 {resolve,reject} 两把手：进程没了要能 reject 掉等待方 */
  private pending = new Map<number, { resolve: (msg: any) => void; reject: (e: Error) => void }>();
  private activePrompt: ActivePrompt | null = null;
  private currentStreamEnd: Promise<void> | null = null;
  private interruptedSessionIds = new Set<string>();
  private sessions = new Map<string, AcpSession>();
  // [09-25] sessionKey → 引擎 sessionId 落盘账本（赎回通道，见 acpMapFile 注释）
  private diskSids: Record<string, string> = {};
  private diskLoaded = false;
  private spawnPromise: Promise<ChildProcess> | null = null;

  private static IDLE_TIMEOUT_MS = parseInt(process.env.CTI_MIMO_IDLE_TIMEOUT_MS || '0', 10); // 🔴 09-20 老大令：默认永不回收（不主动/new 不许断），env CTI_MIMO_IDLE_TIMEOUT_MS 可覆盖
  private static MAX_SESSIONS = parseInt(process.env.CTI_MIMO_MAX_SESSIONS || '20', 10);
  private static PROMPT_TIMEOUT_MS = parseInt(process.env.CTI_MIMO_TIMEOUT_MS || '300000', 10);
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async prepare(): Promise<void> {
    const { command } = resolveMiMoCommand();
    // Windows NSSM 下 --version 会挂死（openclaw.exe 有网络/配置初始化），跳过版本检查；
    // 但仍要预启动 ACP 进程（常驻长连接，避免每条首消息冷启动）。
    if (process.platform === 'win32') {
      try {
        await this.ensureProcess();
      } catch (e) {
        console.warn(`[mimo] prepare pre-spawn ACP failed (Windows):`, e);
      }
      return;
    }
    try {
      await this.ensureProcess();
    } catch (e) {
      console.warn(`[mimo] prepare pre-spawn ACP failed:`, e);
    }
  }

  async resetSession(sessionKey?: string): Promise<void> {
    if (sessionKey) {
      this.sessions.delete(sessionKey);
      this.diskDelete(sessionKey); // [09-25] 用户 /new 同步销掉落盘赎回记录，重启后不被"复活"（09-20 裁决：绝不复活）
      rtLog(`[mimo] resetSession key=${sessionKey.slice(0, 8)}`);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activePrompt || !this.child) return;
    try {
      this.child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', method: 'session/cancel',
        params: { sessionId: this.activePrompt.sessionId },
      }) + '\n');
      rtLog(`[mimo] interrupt session=${this.activePrompt.sessionId.slice(0, 8)}`);
    } catch {}
    this.interruptedSessionIds.add(this.activePrompt.sessionId);
    if (this.currentStreamEnd) {
      await this.currentStreamEnd;
      rtLog(`[mimo] interrupt: current turn fully ended`);
    }
  }

  async dispose(): Promise<void> {
    this.killProcess();
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, s] of this.sessions) {
        if (MiMoProvider.IDLE_TIMEOUT_MS > 0 && now - s.lastUsed > MiMoProvider.IDLE_TIMEOUT_MS) {
          this.sessions.delete(key);
          rtLog(`[mimo] idle cleanup session ${s.sessionId.slice(0, 8)}`);
        }
      }
    }, 60_000);
  }

  /**
   * 票 hand-3（老大 09-20 令"别靠监控垃圾维持稳定，把代码写对"）：引擎进程丢失的统一收口。
   * 复位常驻把手 ⇒ 下一条消息必然走 ensureProcess 真重建；与 killProcess()（"我要杀它"）区分开，
   * 这里是"它没了"。activePrompt 先唤醒再摘除：在途轮次当场收尾，不再干等看门狗。
   */
  private handleProcessLost(reason: string): void {
    rtLog(`[mimo] ⚠️ ${reason} —— 复位常驻把手 + 唤醒在途轮次，下一条消息重建引擎进程`);
    this.child = null;
    this.spawnPromise = null;
    this.sessions.clear();
    this.lineBuf = '';
    const stranded = this.activePrompt;
    this.activePrompt = null;
    if (stranded) { try { stranded.onDone(`MiMo 引擎进程已退出，本条消息请重发（已自动复位，下条消息走新进程）`); } catch { /* 单条唤醒失败不阻塞收口 */ } }
    // 票 hand-3 剩余（老大 09-20"别靠监控垃圾维持稳定，把代码写对"）：pending 过去只存
    // resolve，初始化/建会话阶段的等待方进程死了也不醒，只能干等各自兜底超时（prompt 更无超时=永生）。
    this.wakePending(`MiMo 引擎进程已退出`);
  }

  /**
   * 票 hand-3 剩余：把在途的所有请求等待方逐个唤醒（reject）并清账。
   * 与 handleProcessLost/killProcess/close 三处进程丢失路径绑定 —— 引擎没了，等的人必须当场知道，
   * 而不是把兜底超时当答案（initialize/session-new/resume 的兜底是 60s，prompt 那条根本没有超时）。
   */
  private wakePending(reason: string): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const w of waiters) {
      try { w.reject(new Error(`ACP 请求中止：${reason}`)); } catch { /* 单条唤醒失败不阻塞收口 */ }
    }
  }

  /**
   * 票 hand-3③：所有 stdin 写入一律走这里。裸 `stdin.write()` 有两个致命点：
   * ① 管道已销毁时 write() 同步抛 EPIPE，没人接就是桥进程级未捕获异常 —— 一崩全崩（13 家一起没）；
   * ② 异步写失败走 stream 的 'error' 事件。这里同步/异步都兜住，并顺手复位常驻把手。
   * @returns 是否已交给管道（false = 已丢弃，调用方无需再等响应）
   */
  private writeStdin(child: ChildProcess, payload: unknown, what: string): boolean {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed) {
      rtLog(`[mimo] ⚠️ stdin 不可写(${what}) —— 引擎进程已不在，丢弃本次发送`);
      if (this.child === child) this.handleProcessLost(`MiMo 引擎 stdin 已关闭（${what}）`);
      return false;
    }
    try {
      stdin.write(JSON.stringify(payload) + '\n', (err) => {
        if (!err) return;
        rtLog(`[mimo] ⚠️ stdin 异步写失败(${what}): ${err.message}`);
        if (this.child === child) this.handleProcessLost(`MiMo 引擎 stdin 写入失败（${what}: ${err.message}）`);
      });
      return true;
    } catch (e) {
      rtLog(`[mimo] ⚠️ stdin 同步写异常(${what}): ${e instanceof Error ? e.message : String(e)}`);
      if (this.child === child) this.handleProcessLost(`MiMo 引擎 stdin 写入异常（${what}）`);
      return false;
    }
  }

  private killProcess(): void {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) { try { this.child.kill('SIGTERM'); } catch {} }
    this.child = null;
    this.spawnPromise = null;
    this.sessions.clear();
    this.wakePending('引擎进程已关闭（主动杀，下条消息重建）');
    this.activePrompt = null;
    this.lineBuf = '';
  }

  private onStdout(chunk: Buffer): void {
    this.lineBuf += chunk.toString();
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop() || '';
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) continue;
      let msg: any;
      try { msg = JSON.parse(trimmed); } catch { continue; }

      const id = msg.id as number | undefined;
      const isResponse = !msg.method && (msg.result !== undefined || msg.error);
      if (isResponse && id != null && this.pending.has(id)) {
        const w = this.pending.get(id)!;
        this.pending.delete(id);
        w.resolve(msg);
        continue;
      }

      if (msg.method === 'session/update') { this.activePrompt?.onUpdate(msg); continue; }
      if (msg.method === 'session/request_permission') {
        const options = msg.params?.options as Array<{ optionId: string }> | undefined;
        const allow = options?.find((o) => /allow/i.test(o.optionId))?.optionId || options?.[0]?.optionId || 'allow-once';
        try {
          this.child?.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: allow } },
          }) + '\n');
        } catch {}
        continue;
      }
    }
  }

  private ensureProcess(): Promise<ChildProcess> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return Promise.resolve(this.child);
    if (this.spawnPromise) return this.spawnPromise;

    let rejectSpawn: (e: Error) => void = () => {};
    this.spawnPromise = new Promise<ChildProcess>((resolve, reject) => {
      rejectSpawn = reject;
      const { command, args, cwd } = resolveMiMoCommand();
      const env = buildSpawnEnv();
      let child: ChildProcess;
      try { child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env }); }
      catch (e) { this.spawnPromise = null; reject(e); return; }

      rtLog(`[mimo] ACP spawned pid=${child.pid}`);
      child.stderr?.on('data', (c: Buffer) => rtLog(`[mimo] ACP stderr: ${c.toString().trim().slice(0, 300)}`));
      // 票 hand-3③：stdin 上的 error 没有监听器 = Node 抛 uncaughtException，整个桥一起没。
      child.stdin?.on('error', (err) => {
        rtLog(`[mimo] ⚠️ ACP stdin error: ${err.message}`);
        if (this.child === child) this.handleProcessLost(`MiMo 引擎 stdin 异常（${err.message}）`);
      });
      child.on('error', (err) => {
        rtLog(`[mimo] SPAWN ERROR: ${err.message}`);
        if (this.child === child) { this.child = null; this.spawnPromise = null; }
        reject(err);
      });
      // 票 hand-3（老大 09-20 令"别靠监控垃圾维持稳定，把代码写对"）：判活兜底复位。
      // 'close' 要等所有 stdio 句柄关闭才发 —— 只要有一个孙进程占着管道，它就永远不来；
      // 于是「进程已死 + 把手还在」= 下一条消息继续投给死进程（claude 案同款残留）。
      // 'exit' 由进程本身触发、不等管道 ⇒ 这里就把常驻把手复位掉（随后的 close 因把手已空自动 no-op）。
      child.on('exit', (code, signal) => {
        if (this.child === child) {
          this.handleProcessLost(`MiMo 引擎进程已退出（exit code=${code} signal=${signal}）`);
        } else if (this.spawnPromise) {
          this.spawnPromise = null;
          rejectSpawn(new Error(`MiMo ACP exited before initialize (code=${code})`));
        }
      });
      child.on('close', (code) => {
        rtLog(`[mimo] ACP exited code=${code}`);
        if (this.child === child) {
          this.child = null; this.spawnPromise = null;
          this.sessions.clear(); this.wakePending(`引擎进程已 close（code=${code}）`); this.activePrompt = null; this.lineBuf = '';
        } else if (this.spawnPromise) {
          // 2026-09-01 修复（同 openclaw）：初始化完成前进程退出时清悬挂 spawnPromise
          this.spawnPromise = null;
          rejectSpawn(new Error(`MiMo ACP exited during init (code=${code})`));
        }
      });

      child.stdout!.on('data', (c: Buffer) => this.onStdout(c));

      const initId = this.nextId++;
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: initId, method: 'initialize', params: {
        protocolVersion: 1, capabilities: {},
        clientInfo: { name: 'agents-to-feishu', version: '0.1.0' },
      } }) + '\n');

      // mimo ACP 冷启动给足 60s（不涉及 tsx 编译，比 DSH 快）
      const timeout = setTimeout(() => {
        if (!this.child) { try { child.kill('SIGTERM'); } catch {} reject(new Error('MiMo ACP initialize timeout')); }
      }, 60_000);

      this.waitResponse(initId, 60_000).then(
        (msg) => {
          clearTimeout(timeout);
          if (msg.error) { reject(new Error('MiMo ACP initialize failed')); return; }
          rtLog(`[mimo] ACP initialized`);
          this.child = child;
          resolve(child);
        },
        (err) => { clearTimeout(timeout); reject(err); },
      );
    });

    return this.spawnPromise;
  }

  private waitResponse(id: number, timeoutMs?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`ACP request ${id} timeout`)); }
        }, timeoutMs);
      }
    });
  }

  private async createSession(cwd: string): Promise<AcpSession> {
    const child = await this.ensureProcess();
    const sessionNewId = this.nextId++;
    child.stdin!.write(JSON.stringify({
      jsonrpc: '2.0', id: sessionNewId, method: 'session/new',
      // 2026-09-18：穿透走共享模块（flag='stdioOnly'），二轮实测真调 lark_list_chats ✅。
      params: { cwd, mcpServers: readSessionMcpServers('mimo', 'stdioOnly') },
    }) + '\n');

    const msg = await this.waitResponse(sessionNewId, 60_000);
    if (!msg.result) throw new Error('MiMo ACP session/new failed');
    const sessionId = (msg.result as Record<string, unknown>).sessionId as string | undefined;
    if (!sessionId) throw new Error('MiMo ACP session/new: missing sessionId');

    rtLog(`[mimo] session/new OK: ${sessionId.slice(0, 8)}`);
    this.pruneOldSessions();
    return { sessionId, cwd, lastUsed: Date.now(), personaInjected: false };
  }

  /**
   * [2026-09-25 老大令·失忆根治] 赎回通道：对引擎发 session/load 复活旧会话。
   * 实测（09-25 探针）：mimocode 引擎 loadSession=true，杀进程后全新进程 load 旧 sid 记忆完好；
   * load 期间引擎回放的 session/update 广播此时 activePrompt 未挂，自然丢弃，不污染本轮。
   */
  private async resumeSession(sessionId: string, cwd: string): Promise<AcpSession> {
    const child = await this.ensureProcess();
    const loadId = this.nextId++;
    if (!this.writeStdin(child, {
      jsonrpc: '2.0', id: loadId, method: 'session/load',
      params: { sessionId, cwd, mcpServers: readSessionMcpServers('mimo', 'stdioOnly') },
    }, 'session/load')) throw new Error('session/load 写入失败（引擎管道已断）');
    const msg = await this.waitResponse(loadId, 60_000);
    if (!msg.result) throw new Error(msg.error?.message || 'MiMo ACP session/load 被引擎拒绝');
    return { sessionId: (msg.result.sessionId as string) || sessionId, cwd, lastUsed: Date.now(), personaInjected: true };
  }

  // ── [09-25] 引擎 sid 落盘账本（懒加载，写失败只留痕不阻塞消息） ──
  private loadDisk(): void {
    if (this.diskLoaded) return;
    this.diskLoaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(acpMapFile(), 'utf8')) as unknown;
      if (raw && typeof raw === 'object') this.diskSids = raw as Record<string, string>;
      rtLog(`[mimo] acp sid map loaded from disk (${Object.keys(this.diskSids).length})`);
    } catch { this.diskSids = {}; }
  }
  private saveDisk(): void {
    try {
      const f = acpMapFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(this.diskSids), 'utf8');
    } catch (e) { rtLog(`[mimo] acp sid map persist failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  private diskSid(k: string): string | undefined { this.loadDisk(); return this.diskSids[k]; }
  private diskSet(k: string, sid: string): void { this.loadDisk(); this.diskSids[k] = sid; this.saveDisk(); }
  private diskDelete(k: string): void { this.loadDisk(); if (this.diskSids[k]) { delete this.diskSids[k]; this.saveDisk(); } }

  private pruneOldSessions(): void {
    try {
      const root = path.join(os.homedir(), '.mimocode', 'sessions');
      // 仅做提示级清理；openclaw 由 CLI 自身管理会话目录
      if (!fs.existsSync(root)) return;
      rtLog(`[mimo] session root exists: ${root}`);
    } catch {}
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    const { sessionKey } = params;
    let session = this.sessions.get(sessionKey);
    const cwd = process.env.CTI_DEFAULT_WORKDIR || process.cwd();

    if (this.sessions.size >= MiMoProvider.MAX_SESSIONS && !this.sessions.has(sessionKey)) {
      let oldestKey: string | null = null, oldestAt = Infinity;
      for (const [k, s] of this.sessions) { if (s.lastUsed < oldestAt) { oldestAt = s.lastUsed; oldestKey = k; } }
      if (oldestKey) { this.sessions.delete(oldestKey); this.diskDelete(oldestKey); rtLog(`[mimo] LRU evict ${oldestKey.slice(0, 8)}`); }
    }

    // [2026-09-25 老大令·失忆根治①] 打断≠换会话：实测 mimocode session/cancel 后同一会话
    // 照常可用且记忆完好（09-25 探针），旧家法"打断必弃会话重开"正是本次失忆三连的直接元凶，废除。
    if (session && this.interruptedSessionIds.has(session.sessionId)) {
      this.interruptedSessionIds.delete(session.sessionId);
      rtLog(`[mimo] post-cancel: reusing session ${session.sessionId.slice(0, 8)}`);
    }

    // [2026-09-25 老大令·失忆根治②] 桥侧重启/引擎换代：优先 session/load 赎回旧会话（记忆引擎自持，
    // 无损续聊）。唯一例外 freshReason='user-new'——用户显式 /new 及等效自动 /new 绝不复活（09-20 裁决）。
    let resumeTried = false;
    if (!session && params.freshReason !== 'user-new') {
      const oldSid = this.diskSid(sessionKey);
      if (oldSid) {
        resumeTried = true;
        try {
          session = await this.resumeSession(oldSid, cwd);
          this.sessions.set(sessionKey, session);
          this.startCleanupTimer();
          rtLog(`[mimo] ✅ resumed ${oldSid.slice(0, 8)} via session/load（引擎侧记忆延续）`);
        } catch (e) {
          rtLog(`[mimo] resume ${oldSid.slice(0, 8)} failed: ${e instanceof Error ? e.message : String(e)} → 退化为新建`);
        }
      }
    }

    let isNewSession = false;
    const mustNew = !session || (params.freshSession === true && params.freshReason !== 'restore');
    if (mustNew) {
      if (session) this.sessions.delete(sessionKey); // 用户 /new：覆盖任何残留
      try {
        session = await this.createSession(cwd);
        this.sessions.set(sessionKey, session);
        this.diskSet(sessionKey, session.sessionId); // [09-25] 新 sid 立即落盘，下次换代就靠它赎回
        this.startCleanupTimer();
        isNewSession = true;
      } catch (e) {
        yield { type: 'error', message: `MiMo ACP 会话创建失败: ${e instanceof Error ? e.message : String(e)}` };
        yield { type: 'done' };
        return;
      }
    }
    if (!session) { // 理论不可达（resume/mustNew 必居其一给出手），防空挂兜底
      yield { type: 'error', message: 'MiMo ACP 会话初始化失败（未知路径）' };
      yield { type: 'done' };
      return;
    }

    session.lastUsed = Date.now();

    // 人设注入：首条消息注入 systemPrompt（由 agents-to-feishu 统一注入）
    let fullPrompt = params.text;
    if (!session.personaInjected) {
      fullPrompt = `${params.systemPrompt || ''}\n\n${params.text}`;
      session.personaInjected = true;
    }
    // [2026-09-17] history 注入条件为新建会话（见上方注释）。
    // 🔴 老大令 2026-09-19：非 /new 的丢失性新建 → 自动 /new（回调桥清 shadow 并告知），影子回灌废除。
    // [09-25] 走到这里说明 load 通道没兜住（无旧 sid 或引擎拒绝）——把原因传准（票 claude-2 同款），
    // 桥侧卡片不再冒"原因无法判定"的重警告。成功赎回的会话根本不会进这个分支。
    if (isNewSession && !params.freshSession && params.history && params.history.length > 0) {
      rtLog(`[mimo] engine session lost (shadow ${params.history.length}${resumeTried ? ', resume rejected' : ''}) → auto /new`);
      params.onSessionLost?.(resumeTried ? 'resume-failed-library-intact' : 'restart');
    }
    const historyText = isNewSession && params.freshSession && params.history && params.history.length > 0
      ? params.history.map((m) => `[${m.role === 'user' ? '用户' : '助手'}]\n${m.content}`).join('\n\n')
      : '';
    if (historyText) {
      fullPrompt = `${historyText}\n\n---\n\n${fullPrompt}`;
      rtLog(`[mimo] new session: injected ${params.history?.length ?? 0} history turns`);
    }

    const child = this.child!;
    const promptId = this.nextId++;
    const queue: StreamEvent[] = [];
    let settled = false;
    let settleErr: string | null = null;
    let resolveSettled: () => void = () => {};
    const settledP = new Promise<void>((r) => { resolveSettled = r; });
    let lastOutput = Date.now();

    let wakeup: () => void = () => {};
    let wakeupP: Promise<void> = Promise.resolve();
    const poke = (): void => { wakeup(); };
    let gotUsage = false;
    let gotText = false; // 已流出正文（watchdog 判定：有正文且超时=结束信号丢失，静默完成） // 本轮是否已收到 usage（防响应兜底重复记账）
    const promptHandler: ActivePrompt = {
      promptId,
      sessionId: session.sessionId,
      onUpdate: (msg) => {
        lastOutput = Date.now();
        const update = msg.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text') {
          const delta = update.content.text;
          const metaUsage = (update as { _meta?: { usage?: unknown } })._meta?.usage as UsageInfo | undefined;
          if (metaUsage) {
            queue.push({ type: 'usage', usage: metaUsage, sessionId: session.sessionId });
            gotUsage = true;
          } else if (delta) {
            queue.push({ type: 'text', text: delta }); gotText = true;
            poke();
          }
        } else if (update?.sessionUpdate === 'agent_thought_chunk' && update?.content?.type === 'text') {
          queue.push({ type: 'thinking', text: update.content.text });
          poke();
        } else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
          const u = update as any;
          const status = String(u.status || (update?.sessionUpdate === 'tool_call' ? 'running' : 'done'));
          queue.push({
            type: 'tool',
            tool: String(u.title || 'tool'),
            status: status === 'failed' ? 'error' : status === 'completed' ? 'done' : 'running',
            input: typeof u.rawInput === 'string' ? u.rawInput.slice(0, 200) : JSON.stringify(u.rawInput ?? '').slice(0, 200),
          });
          poke();
        }
      },
      onDone: (err?: string) => { if (settled) return; /* 票 hand-3：首个终态为准（否则收口唤醒会被迟到事件盖成假错误） */ if (err) settleErr = err; settled = true; resolveSettled(); },
    };
    this.activePrompt = promptHandler;

    this.waitResponse(promptId).then(
      (msg) => {
        if (this.activePrompt === promptHandler) this.activePrompt = null;
        // 2026-08-30 兜底：CLI 不发 _meta.usage 流事件时，从 prompt 响应捞 usage（保底命中率数据）
        if (!gotUsage) {
          const rr = msg.result as { usage?: UsageInfo; _meta?: { usage?: UsageInfo } } | undefined;
          const ru = rr?._meta?.usage ?? rr?.usage;
          if (ru && (Number(ru.inputTokens ?? 0) > 0 || Number(ru.outputTokens ?? 0) > 0)) {
            queue.push({ type: 'usage', usage: ru, sessionId: session.sessionId });
            poke();
          }
        }
        if (msg.error) promptHandler.onDone(msg.error.message || JSON.stringify(msg.error));
        else promptHandler.onDone();
      },
      (err: unknown) => {
        if (this.activePrompt === promptHandler) this.activePrompt = null;
        // 票 hand-3④：原因说实话。原先不分起因一律写"ACP prompt 响应超时"，
        // 进程丢失/管道报错都被这句盖成谎话（老大 09-20 令：文案要说实话）。
        const em = err instanceof Error ? err.message : "";
        promptHandler.onDone(/timeout/i.test(em) ? "MiMo 引擎本轮未回 prompt 响应（请求超时）" : (em || "MiMo ACP prompt 响应异常"));
      },
    );

    const watchdog = setInterval(() => {
      if (settled) { clearInterval(watchdog); return; }
      if (Date.now() - lastOutput > MiMoProvider.PROMPT_TIMEOUT_MS) {
        clearInterval(watchdog);
        if (gotText) {
          // 2026-08-30 同步 gemini/hermes 修复：正文已完整流出=结束信号丢失，静默完成不报错
          console.log(`[MiMo] 超时但正文已完整流出——按正常完成处理`);
          promptHandler.onDone();
        } else {
        promptHandler.onDone(`MiMo ACP 卡死：连续 ${MiMoProvider.PROMPT_TIMEOUT_MS / 1000}s 无输出，已中断`);
        }
        rtLog(`[mimo] watchdog timeout promptId=${promptId}`);
      }
    }, 30_000);

    // 票 hand-3③：不再裸写 stdin（写已销毁管道 = 同步抛 EPIPE 崩掉整个桥进程）
    this.writeStdin(child, {
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId: session.sessionId, prompt: [{ type: 'text', text: fullPrompt }] },
    }, 'session/prompt');
    rtLog(`[mimo] prompt sent id=${promptId} session=${session.sessionId.slice(0, 8)}`);

    let resolveStreamEnd: () => void = () => {};
    const streamEndP = new Promise<void>((r) => { resolveStreamEnd = r; });
    this.currentStreamEnd = streamEndP;
    try {
      while (true) {
        if (queue.length > 0) {
          const ev = queue.shift()!;
          yield ev;
          continue;
        }
        if (settled) break;
        wakeupP = new Promise<void>((r) => { wakeup = r; });
        const raceP = Promise.race([settledP, wakeupP]);
        if (queue.length > 0 || settled) continue;
        await raceP;
      }
    } finally {
      clearInterval(watchdog);
      session.lastUsed = Date.now();
      if (settleErr) yield { type: 'error', message: settleErr };
      yield { type: 'done' };
      resolveStreamEnd();
      if (this.currentStreamEnd === streamEndP) this.currentStreamEnd = null;
    }
  }
}

export function createMiMoProvider(): MiMoProvider {
  return new MiMoProvider();
}