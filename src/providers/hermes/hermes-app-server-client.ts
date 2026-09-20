/**
 * Hermes ACP Client — JSON-RPC 2.0 Client over stdin/stdout
 *
 * 通过 hermes acp 子进程通信，支持流式响应和会话保持
 * 参考 codex/app-server-client.ts 的 ACP 协议实现
 *
 * Hermes ACP 差异：
 * - 启动参数为 ['acp']（而非 Codex 的 ['app-server', ...]）
 * - 不需要 --dangerously-bypass-* 等参数
 * - 不支持 collaborationMode 相关 API
 * - 使用 --accept-hooks 自动批准 shell hooks
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { buildWindowsPath } from '../win-spawn-env.js';

// 实时日志：绕过 NSSM stdout 缓冲
function rtLog(msg: string): void {
  const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_${process.env.CTI_BOT || 'unknown'}.log`;
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type HermesServerMessage =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface InitializeParams {
  protocolVersion: number;
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
  } | null;
}

const CLIENT_INFO = {
  name: 'agents-to-im',
  title: 'Hermes ACP Client',
  version: '0.1.0',
} as const;

function buildInitializeParams(): InitializeParams {
  return {
    protocolVersion: 1,
    clientInfo: CLIENT_INFO,
    capabilities: {
      experimentalApi: true,
    },
  };
}

function resolveHermesHome(): string {
  return process.env.CTI_HERMES_HOME || path.join(os.homedir(), '.hermes');
}

function resolvePidFile(): string {
  const ctiHome = process.env.CTI_HOME;
  if (ctiHome) {
    return path.join(ctiHome, 'runtime', 'hermes-app-server.pid');
  }
  return path.join(resolveHermesHome(), 'runtime', 'hermes-app-server.pid');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSavedPid(): number | null {
  const pidFile = resolvePidFile();
  try {
    const content = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (pid > 0) return pid;
  } catch {
    // file not found
  }
  return null;
}

function savePid(pid: number): void {
  const pidFile = resolvePidFile();
  const pidDir = path.dirname(pidFile);
  try {
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(pidFile, String(pid));
  } catch (error) {
    console.warn('[hermes-app-server] Failed to save PID file:', error);
  }
}

function jsonRpcError(method: string, error: JsonRpcFailure['error']): Error {
  const detail = typeof error.data === 'string' ? ` (${error.data})` : '';
  return new Error(`[hermes-app-server] ${method} failed: ${error.message}${detail}`);
}

export class HermesAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingCall>();
  private listeners = new Set<(message: HermesServerMessage) => void>();
  /**
   * 🔴 票 hand-2（2026-09-20）：进程丢失事件出口。
   * 此前 exit/error 只做 failAllPending，**从不告诉 provider** ⇒ provider 的 sessions map
   * 里的 sessionId 指向一个已经不存在的引擎进程，之后每条消息都打在死会话上，只能人工 /new
   * （claude 案同款病，样板见 claude.ts handleProcessLost / commit caf59ff）。
   */
  private processLostListeners = new Set<(reason: string) => void>();
  /** 本 client 最近一次 spawn 的引擎 pid（判"换代"的硬证据，不被 pid 文件误伤） */
  private spawnedPid: number | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly executable = 'hermes',
    private readonly acpArgs: string[] = ['acp', '--accept-hooks'],
  ) {}

  subscribe(listener: (message: HermesServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 🔴 票 hand-2：订阅"引擎进程没了"。回调在 exit/error 事件里同步触发，
   * provider 必须在此把 sessions map 里指向该引擎的会话全部作废（自愈，不等人工 /new）。
   */
  onProcessLost(listener: (reason: string) => void): () => void {
    this.processLostListeners.add(listener);
    return () => {
      this.processLostListeners.delete(listener);
    };
  }

  private notifyProcessLost(reason: string): void {
    for (const listener of this.processLostListeners) {
      try {
        listener(reason);
      } catch (e) {
        console.warn(`[hermes-app-server] onProcessLost 回调异常（不阻塞收口）: ${e}`);
      }
    }
  }

  async prepare(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.bootstrap();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  /**
   * 检查是否需要清空 Hermes thread id（因为 Hermes 进程重启了）
   *
   * 🔴 票 hand-2（2026-09-20）：这条线此前**全仓零调用**（死线），现由 provider 在每次
   * 请求前、`prepare()` 之前调用（codex 原注释就写着"在 prepare() 之前调用"——先 prepare
   * 会重起引擎并改写 pid 文件，事后再问永远"没换过"）。
   *
   * 判据只认硬证据，宁漏不误杀（原实现把"pid 文件读不到"当重启证据，会误清正常会话、
   * 凭空触发自动 /new；pid 文件又落在共享的 CTI_HOME 下，同机多 bot 时可能被别家改写）：
   *   ① 本 client 手里还有活着的子进程 ⇒ false（我们的会话没作废）；
   *   ② 子进程已不在 ⇒ 看 pid 文件留底的 pid 还活不活，不活 ⇒ true（会话全废）；
   *   ③ 连一次都没 spawn 过 ⇒ false（没有在存会话可作废，此时 map 必为空）。
   */
  checkPidChanged(): boolean {
    if (this.proc?.pid) return false;
    const savedPid = readSavedPid();
    if (savedPid !== null) {
      if (!isProcessRunning(savedPid)) {
        console.log(`[hermes-app-server] Previous PID ${savedPid} not running, Hermes process restarted`);
        return true;
      }
      return false;
    }
    if (this.spawnedPid !== null) {
      if (!isProcessRunning(this.spawnedPid)) {
        console.log(`[hermes-app-server] Spawned PID ${this.spawnedPid} not running and no PID file left, Hermes process restarted`);
        return true;
      }
      return false;
    }
    // 本机从没起过引擎 ⇒ 没有在存 thread/sessionId 可作废，不能因此判"换代"
    return false;
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    await this.prepare();
    return this.callInternal<T>(method, params);
  }

  private async callInternal<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const proc = this.proc;
    if (!proc) {
      throw new Error('[hermes-app-server] Process not running');
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.writePayload(payload);
    return promise;
  }

  private writePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.proc) {
      throw new Error('[hermes-app-server] Process not running');
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({ jsonrpc: '2.0', id, result });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.startPromise = null;
    proc.kill();
  }

  private async bootstrap(): Promise<void> {
    // 启动 hermes acp
    const args = [...this.acpArgs];
    rtLog(`[hermes-app-server] bootstrap: spawning "${this.executable}" args=${JSON.stringify(args)}`);
    const proc = spawn(this.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // 2026-08-30 修复 turn 挂起：hermes 的系统提示词构建（build_coding_workspace_block）
      // 会在 cwd 是 git 仓库时跑 git status/log 收集代码上下文；而 git 在服务会话（无桌面）
      // 里会卡死 → subprocess.run 超时后 Windows 特有的二次 communicate() 无超时 → 永久死锁。
      // 显式给 hermes 一个非 git 仓库的工作目录，让 git 探测直接不触发。
      cwd: process.env.CTI_DEFAULT_WORKDIR || 'C:\\D\\opt',
      env: {
        ...process.env,
        PATH: buildWindowsPath(process.env.PATH),
        HOME: os.homedir(),
        HERMES_HOME: resolveHermesHome(),
        USERPROFILE: os.homedir(),
        APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        // hermes 官方 gateway 机制：TERMINAL_CWD 决定系统提示词里的工作区/上下文探测目录
        TERMINAL_CWD: process.env.CTI_DEFAULT_WORKDIR || 'C:\\D\\opt',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-200418',
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'http://localhost:4000/v1',
        PYTHONUNBUFFERED: '1',
        // Skip dangerous command approval prompts in ACP mode (no TTY available).
        // _YOLO_MODE_FROZEN is read at import time from this env var.
        HERMES_YOLO_MODE: '1',
      },
    });
    rtLog(`[hermes-app-server] spawned HERMES_HOME=${resolveHermesHome()} OPENAI_BASE_URL=...:4000`);
    this.proc = proc;
    this.spawnedPid = proc.pid ?? null;

    proc.once('error', (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      rtLog(`[hermes-app-server] spawn ERROR: ${msg}`);
      this.failAllPending(error instanceof Error ? error : new Error(String(error)));
      // 🔴 票 hand-2（2026-09-20）：告诉 provider「引擎没了」，让它作废 sessions map。
      // 此前这里只 failAllPending，map 里的旧 sessionId 无人清 ⇒ 之后每条消息都打在已不存在的
      // 会话上，永久报 "Hermes prompt 失败"，只能人工 /new（claude 案同款病，样板 caf59ff）。
      this.notifyProcessLost(`spawn error: ${msg}`);
    });
    proc.once('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      rtLog(`[hermes-app-server] process EXIT: ${suffix}`);
      this.failAllPending(new Error(`[hermes-app-server] Process exited with ${suffix}`));
      this.proc = null;
      this.startPromise = null;
      // 🔴 票 hand-2：进程丢失出口（failAllPending 之后再通知：在途轮次先醒，provider 后复位）
      this.notifyProcessLost(`process exited (${suffix})`);
    });

    // 捕获原始 stdout 输出到日志（排查 buffering 问题）
    let stderrLog = '';
    proc.stdout.on('data', (chunk) => {
      rtLog(`[hermes-app-server] stdout: received ${chunk.length} bytes`);
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      stderrLog += text;
      if (text) {
        rtLog(`[hermes-app-server] stderr: ${text}`);
        console.warn(`[hermes-app-server][stderr] ${text}`);
      }
    });

    // readline 按行解析 ACP 协议
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      rtLog(`[hermes-app-server] stdout LINE: ${line.substring(0, 600)}`); // 100→600：100 截断看不到 sessionUpdate 类型
      this.handleLine(line);
    });

    // 120秒超时：initialize 握手（2026-08-09 从 30s 调大：hermes Python app-server 冷启动加载依赖慢，
    // 重启后 30s 内未就绪会被强杀 SIGTERM 导致 bot 不稳定，实测 initialize 需 40-90s）
    rtLog(`[hermes-app-server] calling initialize...`);
    let initDone = false;
    const timeoutId = setTimeout(() => {
      if (!initDone) {
        rtLog(`[hermes-app-server] initialize TIMEOUT (120s), killing process`);
        proc.kill();
      }
    }, 120000);
    await this.callInternal('initialize', buildInitializeParams());
    initDone = true;
    clearTimeout(timeoutId);
    rtLog(`[hermes-app-server] initialize OK`);

    // 保存 Hermes 进程 PID
    if (proc.pid) {
      savePid(proc.pid);
      rtLog(`[hermes-app-server] Started with PID ${proc.pid}`);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    } catch (error) {
      console.warn('[hermes-app-server] Ignoring invalid JSON-RPC frame:', error);
      return;
    }

    // Response to a pending call
    if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if ('error' in parsed) {
        pending.reject(jsonRpcError('response', parsed.error));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    // Notification or server request
    if (typeof parsed.method !== 'string') {
      return;
    }

    const envelope: HermesServerMessage = 'id' in parsed
      ? {
        kind: 'request',
        id: parsed.id,
        method: parsed.method,
        params: parsed.params,
      }
      : {
        kind: 'notification',
        method: parsed.method,
        params: parsed.params,
      };

    for (const listener of this.listeners) {
      listener(envelope);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
