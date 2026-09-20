/**
 * Gemini ACP Client — JSON-RPC 2.0 Client over stdin/stdout
 *
 * 通过 gemini --acp 子进程通信，支持流式响应和会话保持
 * 参考 hermes/hermes-app-server-client.ts 的 ACP 协议实现
 *
 * Gemini ACP 差异（相对 Hermes）：
 * - 启动参数为 ['--acp', '--yolo']（而非 Hermes 的 ['acp']）
 * - 使用 Zed 兼容的 initialize 握手（protocolVersion: 1）
 * - authenticate 步骤需要（methodId: 'gateway'）
 * - session/new 支持 mcpServers 参数
 * - 通过 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL 走 gateway auth 到 LiteLLM
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

export type GeminiServerMessage =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs: {
      readTextFile: boolean;
      writeTextFile: boolean;
    };
  };
}

function buildInitializeParams(): InitializeParams {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
  };
}

function resolveGeminiHome(): string {
  return process.env.CTI_GEMINI_HOME || path.join(os.homedir(), '.gemini');
}

/**
 * PID 文件路径，用于检测 Gemini 进程是否重启
 */
function resolvePidFile(): string {
  const ctiHome = process.env.CTI_HOME;
  if (ctiHome) {
    return path.join(ctiHome, 'runtime', 'gemini-app-server.pid');
  }
  return path.join(resolveGeminiHome(), 'runtime', 'gemini-app-server.pid');
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
    console.warn('[gemini-app-server] Failed to save PID file:', error);
  }
}

function jsonRpcError(method: string, error: JsonRpcFailure['error']): Error {
  const detail = typeof error.data === 'string' ? ` (${error.data})` : '';
  return new Error(`[gemini-app-server] ${method} failed: ${error.message}${detail}`);
}

export interface GeminiAppServerOptions {
  executable?: string;
  acpArgs?: string[];
  apiKey?: string;
  baseUrl?: string;
  extraEnv?: Record<string, string>;
}

export class GeminiAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingCall>();
  private listeners = new Set<(message: GeminiServerMessage) => void>();
  /**
   * 🔴 票 hand-2（2026-09-20）：进程丢失事件出口。
   * 此前 exit/error 只做 failAllPending，**从不告诉 provider** ⇒ provider 的 sessions map
   * 里的 sessionId 指向一个已经不存在的引擎进程，之后每条消息都打在死会话上（claude 案同款病，
   * 样板见 claude.ts handleProcessLost / commit caf59ff）。
   */
  private processLostListeners = new Set<(reason: string) => void>();
  /** 本 client 最近一次 spawn 的引擎 pid（判"换代"的硬证据，不被 pid 文件误伤） */
  private spawnedPid: number | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly executable: string;
  private readonly acpArgs: string[];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly extraEnv: Record<string, string>;
  // 退避机制：防止高频重启风暴
  private retryCount = 0;
  private lastExitTime = 0;
  private readonly maxRetryDelay = 60000; // 最大等待 60 秒

  constructor(options: GeminiAppServerOptions = {}) {
    this.executable = options.executable || 'gemini';
    this.acpArgs = options.acpArgs || ['--acp', '--yolo'];
    this.apiKey = options.apiKey || process.env.CTI_GEMINI_API_KEY || process.env.LITELLM_API_KEY || 'sk-200418';
    this.baseUrl = options.baseUrl || process.env.CTI_GEMINI_BASE_URL || 'http://127.0.0.1:4000';
    this.extraEnv = options.extraEnv || {};
  }

  subscribe(listener: (message: GeminiServerMessage) => void): () => void {
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
        console.warn(`[gemini-app-server] onProcessLost 回调异常（不阻塞收口）: ${e}`);
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
   * 检查是否需要清空 Gemini session id（因为 Gemini 进程重启了）
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
        console.log(`[gemini-app-server] Previous PID ${savedPid} not running, Gemini process restarted`);
        return true;
      }
      return false;
    }
    if (this.spawnedPid !== null) {
      if (!isProcessRunning(this.spawnedPid)) {
        console.log(`[gemini-app-server] Spawned PID ${this.spawnedPid} not running and no PID file left, Gemini process restarted`);
        return true;
      }
      return false;
    }
    // 本机从没起过引擎 ⇒ 没有在存 sessionId 可作废，不能因此判"换代"
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
      throw new Error('[gemini-app-server] Process not running');
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.writePayload(payload);
    // 2026-08-30 修复：prompt 等长调用加超时（默认 10 分钟）——此前无超时，app-server 挂起时
    // 该 chat 队列被永久占用，后续消息排队数十分钟才轮到 ⇒ 全被判"过期消息"未处理（老大实测）。
    const PROMPT_METHODS = new Set(['session/prompt']);
    const timeoutMs = PROMPT_METHODS.has(method)
      ? parseInt(process.env.CTI_GEMINI_PROMPT_TIMEOUT_MS || '600000', 10)
      : 30_000;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[gemini-app-server] ${method} 超时 ${Math.round(timeoutMs / 1000)}s（app-server 无响应，已释放队列）`));
      }, timeoutMs)),
    ]);
  }

  private writePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.proc) {
      throw new Error('[gemini-app-server] Process not running');
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
    // 退避机制：防止高频重启风暴
    const now = Date.now();
    if (this.lastExitTime > 0 && this.retryCount > 0) {
      const delay = Math.min(
        1000 * Math.pow(2, this.retryCount) + Math.random() * 1000,
        this.maxRetryDelay
      );
      const elapsed = now - this.lastExitTime;
      if (elapsed < delay) {
        const waitMs = delay - elapsed;
        console.log(`[gemini-app-server] Backoff: waiting ${Math.round(waitMs / 1000)}s before restart (retry #${this.retryCount})`);
        rtLog(`[gemini-app-server] Backoff: waiting ${waitMs}ms (retry #${this.retryCount})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }

    // 启动 gemini --acp --yolo
    // Windows 上 .cmd/.bat 文件必须通过 shell 或直接用 node.exe 运行 JS
    // 这里用 node.exe 直接运行 gemini.js，避免 shell:true 导致进程树断裂
    let command = this.executable;
    let spawnArgs = [...this.acpArgs];
    let useShell = false;
    if (process.platform === 'win32') {
      // 优先直接 spawn node.exe + gemini.js
      const npmGlobalRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
      const geminiJsPath = path.join(npmGlobalRoot, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
      if (fs.existsSync(geminiJsPath)) {
        command = process.execPath; // node.exe 路径
        spawnArgs = [geminiJsPath, ...this.acpArgs];
        console.log(`[gemini-app-server] Windows: spawning node directly: ${command} ${spawnArgs.join(' ')}`);
      } else if (/\.(cmd|bat)$/i.test(this.executable) || !path.isAbsolute(this.executable)) {
        // 找不到 gemini.js，fallback 到 shell:true 运行 .cmd
        useShell = true;
        console.log(`[gemini-app-server] Windows: using shell mode for ${this.executable}`);
      }
    }
    const proc = spawn(command, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
      env: {
        ...process.env,
        // 2026-08-31：PATH 补全统一收口（SCM 环境快照吃不到系统 PATH 变更，如新装的 gh CLI）
        PATH: buildWindowsPath(process.env.PATH),
        HOME: os.homedir(),
        USERPROFILE: os.homedir(),
        // 强制使用 WinPTY，绕过 ConPTY 的 AttachConsole 失败问题
        FORCE_WINPTY: '1',
        // 防止输出缓冲区堵塞
        PYTHONUNBUFFERED: '1',
        GEMINI_HOME: resolveGeminiHome(),
        GEMINI_API_KEY: this.apiKey,
        GOOGLE_GEMINI_BASE_URL: this.baseUrl,
        APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        ...this.extraEnv,
      },
    });
    rtLog(`[gemini-app-server] ACP spawn: command=${command} args=${JSON.stringify(spawnArgs)} pid=${proc.pid}`);
    this.proc = proc;
    this.spawnedPid = proc.pid ?? null;

    // 原始字节流监控（绕过 readline 缓冲）
    proc.stdout.on('data', (chunk: Buffer) => {
      rtLog(`[gemini-app-server] stdout RAW: ${chunk.length} bytes -> "${chunk.toString('utf-8').substring(0, 200)}"`);
    });

    proc.once('error', (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      rtLog(`[gemini-app-server] spawn ERROR: ${msg}`);
      this.failAllPending(error instanceof Error ? error : new Error(String(error)));
      // 🔴 票 hand-2（2026-09-20）：告诉 provider「引擎没了」，让它作废 sessions map。
      // 此前这里只 failAllPending，map 里的旧 sessionId 无人清 ⇒ 之后每条消息都打在已不存在的
      // 会话上，永久报错，只能人工 /new（claude 案同款病，样板 caf59ff）。
      this.notifyProcessLost(`spawn error: ${msg}`);
    });
    proc.once('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      rtLog(`[gemini-app-server] process EXIT: ${suffix}`);
      this.failAllPending(new Error(`[gemini-app-server] Process exited with ${suffix}`));
      this.proc = null;
      this.startPromise = null;
      // 更新退避状态
      this.lastExitTime = Date.now();
      this.retryCount++;
      // 🔴 票 hand-2：进程丢失出口（failAllPending 之后再通知，保证在途轮次先醒、provider 后复位）
      this.notifyProcessLost(`process exited (${suffix})`);
    });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      rtLog(`[gemini-app-server] stdout LINE: ${line.substring(0, 150)}`);
      this.handleLine(line);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text && !text.includes('YOLO mode is enabled') && !text.includes('MCP issues detected')) {
        rtLog(`[gemini-app-server] stderr: ${text.substring(0, 300)}`);
        console.warn(`[gemini-app-server][stderr] ${text}`);
      }
    });

    // 30秒超时：initialize 握手
    rtLog(`[gemini-app-server] calling initialize...`);
    let initDone = false;
    const initTimeout = setTimeout(() => {
      if (!initDone) {
        rtLog(`[gemini-app-server] initialize TIMEOUT (30s), killing process`);
        proc.kill();
      }
    }, 30000);
    // 握手：initialize
    await this.callInternal('initialize', buildInitializeParams());
    initDone = true;
    clearTimeout(initTimeout);
    rtLog(`[gemini-app-server] initialize OK`);
    // 成功启动，重置退避计数器
    this.retryCount = 0;
    this.lastExitTime = 0;

    // authenticate with gateway method
    try {
      await this.callInternal('authenticate', { methodId: 'gateway' });
    } catch (error) {
      console.warn('[gemini-app-server] authenticate failed:', error);
      // 有些认证方法会返回错误但仍可继续，不阻塞
    }

    // 保存 Gemini 进程 PID
    if (proc.pid) {
      savePid(proc.pid);
      console.log(`[gemini-app-server] Started with PID ${proc.pid}`);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    } catch (error) {
      console.warn('[gemini-app-server] Ignoring invalid JSON-RPC frame:', error);
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

    // 自动批准权限请求（YOLO 模式）
    if (parsed.method === 'session/request_permission' && 'id' in parsed) {
      rtLog(`[gemini-app-server] AUTO-APPROVE session/request_permission id=${parsed.id}`);
      try {
        // 找到第一个 option 的 proceed_always 或第一个 option
        const params = (parsed as { params?: { options?: Array<{ optionId?: string }> } }).params;
        const firstOption = params?.options?.[0]?.optionId || 'proceed_always';
        this.writePayload({
          jsonrpc: '2.0',
          id: parsed.id,
          result: { optionId: firstOption },
        } as JsonRpcResponse);
      } catch (e) {
        rtLog(`[gemini-app-server] auto-approve failed: ${e}`);
      }
      return;
    }

    const envelope: GeminiServerMessage = 'id' in parsed
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
