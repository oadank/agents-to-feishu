/**
 * OpenAkita Provider — ACP 协议接入 `openakita-acp-server.py` 进程。
 *
 * 由 agents-to-feishu 统一管理人设/记忆/模型/MCP：
 * - 人设：接收 params.systemPrompt（config-store 统一注入 + 独立注入），首条消息注入
 * - 记忆：会话由 SessionManager 管理，不依赖 openclaw 自有记忆
 * - 模型：走 openakita 自带的网关/模型配置（provider/model 由 CLI 决定）
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
import { buildWindowsPath } from './win-spawn-env.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

/** 解析 openakita ACP 启动命令 */
function resolveOpenAkitaCommand(): { command: string; args: string[]; cwd: string } {
  const python = process.env.CTI_OPENAKITA_PYTHON
    || 'C:\\D\\opt\\openakita\\venv\\Scripts\\python.exe';
  const server = process.env.CTI_OPENAKITA_SERVER
    || path.join(process.cwd(), 'scripts', 'openakita-acp-server.py');
  const workspace = process.env.CTI_OPENAKITA_WORKSPACE
    || path.join(os.homedir(), '.openakita', 'workspaces', 'default');
  if (!fs.existsSync(server)) {
    console.warn(`[openakita] acp server not found at ${server}, spawn may fail`);
  }
  return { command: python, args: [server], cwd: workspace };
}

/** 补齐 Windows 必需系统变量 + openakita ACP server 环境（NSSM 环境残缺） */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue;
    clean[key] = value;
  }
  if (process.platform !== 'win32') return { ...clean };
  const parentPath = (clean.PATH || '').split(';').filter(Boolean);
  const workspace = process.env.CTI_OPENAKITA_WORKSPACE
    || path.join(os.homedir(), '.openakita', 'workspaces', 'default');
  return {
    ...clean,
    ComSpec: clean.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe',
    SystemRoot: clean.SystemRoot || 'C:\\WINDOWS',
    PATH: buildWindowsPath(clean.PATH),
    OPENAKITA_ACP_WORKSPACE: workspace,
    LLM_ENDPOINTS_CONFIG: path.join(workspace, 'data', 'llm_endpoints.json'),
    OPENAKITA_AUTO_CONFIRM: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
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

export class OpenAkitaProvider implements RuntimeProvider {
  readonly name = 'openakita';

  private child: ChildProcess | null = null;
  private lineBuf = '';
  private nextId = 100;
  private pending = new Map<number, (msg: any) => void>();
  private activePrompt: ActivePrompt | null = null;
  private currentStreamEnd: Promise<void> | null = null;
  private interruptedSessionIds = new Set<string>();
  private sessions = new Map<string, AcpSession>();
  private spawnPromise: Promise<ChildProcess> | null = null;

  private static IDLE_TIMEOUT_MS = parseInt(process.env.CTI_OPENAKITA_IDLE_TIMEOUT_MS || '1800000', 10);
  private static MAX_SESSIONS = parseInt(process.env.CTI_OPENAKITA_MAX_SESSIONS || '20', 10);
  private static PROMPT_TIMEOUT_MS = parseInt(process.env.CTI_OPENAKITA_TIMEOUT_MS || '300000', 10);
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async prepare(): Promise<void> {
    const { command } = resolveOpenAkitaCommand();
    // Windows NSSM 下 --version 会挂死（openclaw.exe 有网络/配置初始化），跳过版本检查；
    // 但仍要预启动 ACP 进程（常驻长连接，避免每条首消息冷启动）。
    if (process.platform === 'win32') {
      try {
        await this.ensureProcess();
      } catch (e) {
        console.warn(`[openakita] prepare pre-spawn ACP failed (Windows):`, e);
      }
      return;
    }
    try {
      await this.ensureProcess();
    } catch (e) {
      console.warn(`[openakita] prepare pre-spawn ACP failed:`, e);
    }
  }

  async resetSession(sessionKey?: string): Promise<void> {
    if (sessionKey) { this.sessions.delete(sessionKey); rtLog(`[openakita] resetSession key=${sessionKey.slice(0, 8)}`); }
  }

  async interrupt(): Promise<void> {
    if (!this.activePrompt || !this.child) return;
    try {
      this.child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', method: 'session/cancel',
        params: { sessionId: this.activePrompt.sessionId },
      }) + '\n');
      rtLog(`[openakita] interrupt session=${this.activePrompt.sessionId.slice(0, 8)}`);
    } catch {}
    this.interruptedSessionIds.add(this.activePrompt.sessionId);
    if (this.currentStreamEnd) {
      await this.currentStreamEnd;
      rtLog(`[openakita] interrupt: current turn fully ended`);
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
        if (now - s.lastUsed > OpenAkitaProvider.IDLE_TIMEOUT_MS) {
          this.sessions.delete(key);
          rtLog(`[openakita] idle cleanup session ${s.sessionId.slice(0, 8)}`);
        }
      }
    }, 60_000);
  }

  private killProcess(): void {
    if (this.child && !this.child.killed) { try { this.child.kill('SIGTERM'); } catch {} }
    this.child = null;
    this.spawnPromise = null;
    this.sessions.clear();
    this.pending.clear();
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
        const resolve = this.pending.get(id)!;
        this.pending.delete(id);
        resolve(msg);
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
    if (this.child && !this.child.killed) return Promise.resolve(this.child);
    if (this.spawnPromise) return this.spawnPromise;

    let rejectSpawn: (e: Error) => void = () => {};
    this.spawnPromise = new Promise<ChildProcess>((resolve, reject) => {
      rejectSpawn = reject;
      const { command, args, cwd } = resolveOpenAkitaCommand();
      const env = buildSpawnEnv();
      let child: ChildProcess;
      try { child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env }); }
      catch (e) { this.spawnPromise = null; reject(e); return; }

      rtLog(`[openakita] ACP spawned pid=${child.pid}`);
      child.stderr?.on('data', (c: Buffer) => rtLog(`[openakita] ACP stderr: ${c.toString().trim().slice(0, 300)}`));
      child.on('error', (err) => {
        rtLog(`[openakita] SPAWN ERROR: ${err.message}`);
        if (this.child === child) { this.child = null; this.spawnPromise = null; }
        reject(err);
      });
      child.on('close', (code) => {
        rtLog(`[openakita] ACP exited code=${code}`);
        if (this.child === child) {
          this.child = null; this.spawnPromise = null;
          this.sessions.clear(); this.pending.clear(); this.activePrompt = null; this.lineBuf = '';
        } else if (this.spawnPromise) {
          // 2026-09-01 修复（同 openclaw）：初始化完成前进程退出时清悬挂 spawnPromise
          this.spawnPromise = null;
          rejectSpawn(new Error(`OpenAkita ACP exited during init (code=${code})`));
        }
      });

      child.stdout!.on('data', (c: Buffer) => this.onStdout(c));

      const initId = this.nextId++;
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: initId, method: 'initialize', params: {
        protocolVersion: 1, capabilities: {},
        clientInfo: { name: 'agents-to-feishu', version: '0.1.0' },
      } }) + '\n');

      // openakita ACP 冷启动给足 60s（不涉及 tsx 编译，比 DSH 快）
      const timeout = setTimeout(() => {
        if (!this.child) { try { child.kill('SIGTERM'); } catch {} reject(new Error('Reasonix ACP initialize timeout')); }
      }, 60_000);

      this.waitResponse(initId, 60_000).then(
        (msg) => {
          clearTimeout(timeout);
          if (msg.error) { reject(new Error('Reasonix ACP initialize failed')); return; }
          rtLog(`[openakita] ACP initialized`);
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
      this.pending.set(id, resolve);
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
      params: { cwd, mcpServers: [] },
    }) + '\n');

    const msg = await this.waitResponse(sessionNewId, 60_000);
    if (!msg.result) throw new Error('Reasonix ACP session/new failed');
    const sessionId = (msg.result as Record<string, unknown>).sessionId as string | undefined;
    if (!sessionId) throw new Error('Reasonix ACP session/new: missing sessionId');

    rtLog(`[openakita] session/new OK: ${sessionId.slice(0, 8)}`);
    this.pruneOldSessions();
    return { sessionId, cwd, lastUsed: Date.now(), personaInjected: false };
  }

  private pruneOldSessions(): void {
    try {
      const root = path.join(os.homedir(), '.openakita');
      // 仅做提示级清理；openclaw 由 CLI 自身管理会话目录
      if (!fs.existsSync(root)) return;
      rtLog(`[openakita] session root exists: ${root}`);
    } catch {}
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    const { sessionKey } = params;
    let session = this.sessions.get(sessionKey);

    if (this.sessions.size >= OpenAkitaProvider.MAX_SESSIONS && !this.sessions.has(sessionKey)) {
      let oldestKey: string | null = null, oldestAt = Infinity;
      for (const [k, s] of this.sessions) { if (s.lastUsed < oldestAt) { oldestAt = s.lastUsed; oldestKey = k; } }
      if (oldestKey) { this.sessions.delete(oldestKey); rtLog(`[openakita] LRU evict ${oldestKey.slice(0, 8)}`); }
    }

    const sessionInterrupted = session ? this.interruptedSessionIds.has(session.sessionId) : false;
    if (!session || params.freshSession || sessionInterrupted) {
      if (session && sessionInterrupted) {
        this.interruptedSessionIds.delete(session.sessionId);
        this.sessions.delete(sessionKey);
        rtLog(`[openakita] interrupted, opening new session`);
      }
      try {
        session = await this.createSession(process.env.CTI_DEFAULT_WORKDIR || process.cwd());
        this.sessions.set(sessionKey, session);
        this.startCleanupTimer();
      } catch (e) {
        yield { type: 'error', message: `Reasonix ACP 会话创建失败: ${e instanceof Error ? e.message : String(e)}` };
        yield { type: 'done' };
        return;
      }
    }

    session.lastUsed = Date.now();

    // 人设注入：首条消息注入 systemPrompt（由 agents-to-feishu 统一注入）
    let fullPrompt = params.text;
    if (!session.personaInjected) {
      fullPrompt = `${params.systemPrompt || ''}\n\n${params.text}`;
      session.personaInjected = true;
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
      onDone: (err?: string) => { if (err) settleErr = err; settled = true; resolveSettled(); },
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
      () => {
        if (this.activePrompt === promptHandler) this.activePrompt = null;
        promptHandler.onDone('ACP prompt 响应超时');
      },
    );

    const watchdog = setInterval(() => {
      if (settled) { clearInterval(watchdog); return; }
      if (Date.now() - lastOutput > OpenAkitaProvider.PROMPT_TIMEOUT_MS) {
        clearInterval(watchdog);
        if (gotText) {
          // 2026-08-30 同步 gemini/hermes 修复：正文已完整流出=结束信号丢失，静默完成不报错
          console.log(`[OpenAkita] 超时但正文已完整流出——按正常完成处理`);
          promptHandler.onDone();
        } else {
        promptHandler.onDone(`Reasonix ACP 卡死：连续 ${OpenAkitaProvider.PROMPT_TIMEOUT_MS / 1000}s 无输出，已中断`);
        }
        rtLog(`[openakita] watchdog timeout promptId=${promptId}`);
      }
    }, 30_000);

    child.stdin!.write(JSON.stringify({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId: session.sessionId, prompt: [{ type: 'text', text: fullPrompt }] },
    }) + '\n');
    rtLog(`[openakita] prompt sent id=${promptId} session=${session.sessionId.slice(0, 8)}`);

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

export function createOpenAkitaProvider(): OpenAkitaProvider {
  return new OpenAkitaProvider();
}