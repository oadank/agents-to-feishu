/**
 * DSH Provider — ACP 协议接入 DeepSeek Harness ACP 服务器。
 *
 * 架构：单 ACP 进程 + 进程内多会话。
 * 实测（2026-08-24）：DSH acp-demo 支持一个进程内 session/new 多次，各 session
 * 上下文完全隔离（session#2 不知 session#1 内容）。因此 /new 只需在现有进程里
 * 开新 session，绝不杀进程。
 *
 * 进程模型：10 个飞书对话 = 1 个 ACP 进程 + 进程内 10 个 session。
 * - 会话上限 CTI_DSH_MAX_SESSIONS（默认 20），超出按 LRU 淘汰最久未用的
 * - 空闲回收：进程内所有 session 超时（默认 30min）→ 杀进程，下次自动重建
 * - 消息处理：单一常驻 stdout 监听器 + 按 request id 分发（避免多监听器
 *   重复 append 行缓冲导致 JSON 错乱）
 *
 * 协议要点（本地踩坑沉淀，重写保留）：
 * - spawn `node --import tsx/esm packages/examples/acp-demo/src/bin.ts --config <cordis.yml>`
 * - 必须剥离宿主 DSH_* 环境变量（否则 ACP 会挂到宿主会话存储，SQLite 锁冲突无声卡死）
 * - session/new 必填 mcpServers: []（不接受非空）
 * - danger-full-access 下 approval=never，不触发 request_permission
 * - DSH 只推提交式输出（agent_message_chunk），无思考流
 * - usage 从 _meta.usage 透传，换算成 prompt/cache_hit/cache_miss 口径落盘
 */

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeProvider, StreamChatParams, StreamEvent, UsageInfo } from './types.js';
import { ensureDshPluginInjected } from '../tools/dsh-inject.js';
import { buildWindowsPath } from './win-spawn-env.js';

// ── 工具函数 ──

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

function readDeepSeekApiKey(): string {
  const explicit = process.env.CTI_DSH_DEEPSEEK_API_KEY;
  if (explicit) return explicit;
  try {
    const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const txt = fs.readFileSync(cred, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)/);
      if (m) return m[1];
    }
  } catch {}
  return process.env.DEEPSEEK_API_KEY || '';
}

/** 解析 DSH ACP 服务器启动命令 */
function resolveDshCommand(): { command: string; args: string[]; cwd: string } {
  const harness = process.env.CTI_DSH_HARNESS_PATH || 'C:\\D\\opt\\deepseek-harness\\deepseek-harness';
  const config = process.env.CTI_DSH_ACP_CONFIG || path.join(os.homedir(), '.dsh', 'dsh-bot', 'cordis.yml');
  return {
    command: process.execPath,
    args: ['--import', 'tsx/esm', 'packages/examples/acp-demo/src/bin.ts', '--config', config],
    cwd: harness,
  };
}

/** 剥离 DSH_* 环境变量 + 补全 Windows 必需系统变量（NSSM 环境残缺） */
function buildSpawnEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue;
    clean[key] = value;
  }
  if (process.platform !== 'win32') return { ...clean, ...extra };
  const parentPath = (clean.PATH || '').split(';').filter(Boolean);
  return {
    ...clean,
    ...extra,
    ComSpec: clean.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe',
    SystemRoot: clean.SystemRoot || 'C:\\WINDOWS',
    PATH: buildWindowsPath(clean.PATH),
  };
}

/** DSH usage 落盘：stats/YYYY-MM-DD.jsonl（对齐 reasonix 口径；目录按 bot 的 ACP config 决定） */
function recordUsage(usage: UsageInfo): void {
  try {
    const input = Number(usage.inputTokens ?? 0);
    const cacheRead = Number(usage.cacheReadTokens ?? 0);
    const hit = cacheRead;
    const miss = input;
    if (hit + miss <= 0) return;
    // 目录规则：跟随 ACP config（~/.dsh/<bot>/cordis.yml → ~/.dsh/<bot>/stats）
    // 由 CTI_DSH_ACP_CONFIG 决定，而不是写死 dsh-bot。
    let botStatsDir: string | null = null;
    const acpConfig = process.env.CTI_DSH_ACP_CONFIG || '';
    const m = acpConfig.match(/\\(\w+)-bot\\(cordis\.yml)$/i) || acpConfig.match(/\/(\w+)-bot\/(cordis\.yml)$/i);
    if (m) {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      botStatsDir = path.join(home, `${m[1]}-bot`, 'stats');
    } else {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      botStatsDir = path.join(home, 'dsh-bot', 'stats'); // 兜底
    }
    fs.mkdirSync(botStatsDir, { recursive: true });
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const file = path.join(botStatsDir, `${localDate}.jsonl`);
    const rec = {
      ts: now.toISOString(),
      model: process.env.CTI_BOT_DSH_MODEL_GROUP || 'deepseek-v4-flash',
      source: 'cli',
      prompt: input + cacheRead,
      completion: Number(usage.outputTokens ?? 0),
      reasoning: Number(usage.reasoningTokens ?? 0),
      cache_hit: hit,
      cache_miss: miss,
      total: input + cacheRead + Number(usage.outputTokens ?? 0),
      requests: 1,
    };
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf-8');
  } catch {}
}

// ── ACP 会话（进程内的一个 session）──

interface AcpSession {
  sessionId: string;
  cwd: string;
  lastUsed: number;
  personaInjected: boolean;
}

/** 活跃 prompt 的流式事件处理器 */
interface ActivePrompt {
  promptId: number;
  /** 当前 ACP session id（interrupt 用 session/cancel 需要真实 sessionId） */
  sessionId: string;
  onUpdate: (msg: any) => void;
  onDone: (err?: string) => void;
}

// ── DshProvider ──

export class DshProvider implements RuntimeProvider {
  readonly name = 'dsh';

  /** 单 ACP 进程（惰性 spawn，空闲回收） */
  private child: ChildProcess | null = null;
  /** 行缓冲：只被唯一常驻监听器读写 */
  private lineBuf = '';
  /** 下一可用 request id */
  private nextId = 100;
  /** 按 request id 等待的响应 resolver */
  private pending = new Map<number, (msg: any) => void>();
  /** 当前活跃 prompt（流式事件分发目标） */
  private activePrompt: ActivePrompt | null = null;
  /** 当前 streamChat 流的结束 promise（interrupt 等待它，确保 turn 完全结束后再放行下一条） */
  private currentStreamEnd: Promise<void> | null = null;
  /** 被 interrupt 取消过的 sessionId：下一条消息必须开新 session（cancel 后旧 turn 未释放，复用会 turn/start 冲突） */
  private interruptedSessionIds = new Set<string>();
  /** 会话注册表：sessionKey（桥接层 id）→ ACP session（同一进程内） */
  private sessions = new Map<string, AcpSession>();
  /** 进程 spawn 等待队列（initialize 未完成时排队的请求） */
  private spawnPromise: Promise<ChildProcess> | null = null;

  private static IDLE_TIMEOUT_MS = parseInt(process.env.CTI_DSH_IDLE_TIMEOUT_MS || '1800000', 10); // 默认 30min
  /** 进程内最大会话数（超出按 LRU 淘汰最久未用的） */
  private static MAX_SESSIONS = parseInt(process.env.CTI_DSH_MAX_SESSIONS || '20', 10);
  private static PROMPT_TIMEOUT_MS = parseInt(process.env.CTI_DSH_TIMEOUT_MS || '300000', 10); // 5min 无输出判卡死
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Phase 1（2026-08-29 方向定调）：bot 启动即确保内置工具插件就位（幂等，零配置、不走 HTTP）
    ensureDshPluginInjected((m) => rtLog(m));
  }

  async prepare(): Promise<void> {
    const { cwd } = resolveDshCommand();
    const config = process.env.CTI_DSH_ACP_CONFIG || path.join(os.homedir(), '.dsh', 'dsh-bot', 'cordis.yml');
    if (!fs.existsSync(config)) throw new Error(`DSH ACP config not found: ${config}`);
    if (!fs.existsSync(path.join(cwd, 'packages', 'examples', 'acp-demo', 'src', 'bin.ts'))) {
      throw new Error(`DSH harness not found at: ${cwd} (set CTI_DSH_HARNESS_PATH)`);
    }
    // ⚠️ 常驻模式（2026-08-25）：服务启动即预启动 ACP 进程并完成 initialize/MCP 初始化，
    // 而不是等第一条消息才惰性 spawn（那是"一次性调用"体验，首条消息要冷启动 4-5 秒）。
    // 进程常驻后，消息来了直接复用，秒回（只等模型首字，不再等 ACP 冷启动）。
    try {
      await this.ensureProcess();
      rtLog(`[dsh] prepare: ACP pre-spawned & initialized (常驻模式)`);
    } catch (e) {
      // 预启动失败不阻塞启动（消息来时仍会惰性重试），但记日志便于排查
      console.warn(`[dsh] prepare pre-spawn ACP failed:`, e);
    }
  }

  /**
   * /new：清掉该 key 的旧会话绑定，下一条消息在进程内开新 session（不杀进程）。
   */
  async resetSession(sessionKey?: string): Promise<void> {
    if (sessionKey) {
      this.sessions.delete(sessionKey);
      rtLog(`[dsh] resetSession key=${sessionKey.slice(0, 8)}`);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activePrompt || !this.child) return;
    // session/cancel 必须传真实 sessionId（空字符串 ACP 找不到会话 → 插队无效）
    try {
      this.child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', method: 'session/cancel',
        params: { sessionId: this.activePrompt.sessionId },
      }) + '\n');
      rtLog(`[dsh] interrupt session=${this.activePrompt.sessionId.slice(0, 8)}`);
    } catch {}
    // 标记该 session 已中断：下一条必须开新 session（cancel 后旧 turn 不释放，复用会 turn/start 冲突）
    this.interruptedSessionIds.add(this.activePrompt.sessionId);
    // ⚠️ cancel 是异步的：harness 标记取消后还要等当前 turn quiesce 才真正结束。
    // 若不等待，下一条 prompt 会在 turn 1 未结束时发出 → "turn/start 2 while turn 1 is still open"。
    // 所以 interrupt() 必须阻塞到当前 streamChat 的流彻底结束（settled）再返回。
    if (this.currentStreamEnd) {
      await this.currentStreamEnd;
      rtLog(`[dsh] interrupt: current turn fully ended`);
    }
  }

  async dispose(): Promise<void> {
    this.killProcess();
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  /** 会话回收：清理超时未用的 session 绑定，但【进程常驻不杀】（常驻模式 2026-08-25） */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, s] of this.sessions) {
        if (now - s.lastUsed > DshProvider.IDLE_TIMEOUT_MS) {
          this.sessions.delete(key);
          rtLog(`[dsh] idle cleanup session ${s.sessionId.slice(0, 8)}`);
        }
      }
      // ⚠️ 不再杀进程：进程常驻，等用户随时发消息秒回（对齐 CLI 长连接体验）。
      // 进程异常退出由 ensureProcess 惰性重建兜底。
    }, 60_000);
  }

  private killProcess(): void {
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch {}
    }
    this.child = null;
    this.spawnPromise = null;
    this.sessions.clear();
    this.pending.clear();
    this.activePrompt = null;
    this.lineBuf = '';
  }

  /** 唯一常驻 stdout 监听器：按 id 分发响应，流式事件给 activePrompt */
  private onStdout(chunk: Buffer): void {
    this.lineBuf += chunk.toString();
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop() || '';
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) continue;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const id = msg.id as number | undefined;
      const isResponse = !msg.method && (msg.result !== undefined || msg.error);

      // 1) 请求-响应：匹配 pending
      if (isResponse && id != null && this.pending.has(id)) {
        const resolve = this.pending.get(id)!;
        this.pending.delete(id);
        resolve(msg);
        continue;
      }

      // 2) 服务端通知（session/update / request_permission）
      if (msg.method === 'session/update') {
        this.activePrompt?.onUpdate(msg);
        continue;
      }
      if (msg.method === 'session/request_permission') {
        // danger-full-access 下不应触发，防御性自动批准
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

  /** 确保 ACP 进程存在（惰性 spawn，仅挂一次 stdout 监听器） */
  private ensureProcess(): Promise<ChildProcess> {
    if (this.child && !this.child.killed) return Promise.resolve(this.child);
    if (this.spawnPromise) return this.spawnPromise;

    let rejectSpawn: (e: Error) => void = () => {};
    this.spawnPromise = new Promise<ChildProcess>((resolve, reject) => {
      rejectSpawn = reject;
      const { command, args, cwd: harnessCwd } = resolveDshCommand();
      const env = buildSpawnEnv({
        DEEPSEEK_API_KEY: readDeepSeekApiKey(),
        DSH_PERMISSION_MODE: 'danger-full-access',
        // 2026-08-29 修复：插件（cti-builtin-tools）按 DSH_HOME 定位 voice-config.json/素材。
        // 不设则 homedir() 在 LocalSystem 下指向 systemprofile ⇒ 配置漂移——看图回落
        // "本地 ollama qwen3-vl" 默认（弱模型误描述=看错图 / 后端缺模型=找不到图片）。
        // harness 的 BOOTSTRAP_PREFIXES 只禁 .env 文件带 DSH_*，父进程 spawn 注入是受信通道。
        DSH_HOME: path.join(process.env.CTI_USER_HOME || 'C:\\Users\\oadan', '.dsh'),
      });
      const child = spawn(command, args, {
        cwd: harnessCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
      rtLog(`[dsh] ACP spawned pid=${child.pid}`);

      child.stderr.on('data', (c: Buffer) => rtLog(`[dsh] ACP stderr: ${c.toString().trim().slice(0, 300)}`));
      child.on('error', (err) => {
        rtLog(`[dsh] SPAWN ERROR: ${err.message}`);
        if (this.child === child) {
          this.child = null;
          this.spawnPromise = null;
        }
        reject(err);
      });
      child.on('close', (code) => {
        rtLog(`[dsh] ACP exited code=${code}`);
        if (this.child === child) {
          this.child = null;
          this.spawnPromise = null;
          this.sessions.clear();
          this.pending.clear();
          this.activePrompt = null;
          this.lineBuf = '';
        } else if (this.spawnPromise) {
          // 2026-09-01 修复（同 openclaw）：初始化完成前进程退出时清悬挂 spawnPromise
          this.spawnPromise = null;
          rejectSpawn(new Error(`DSH ACP exited during init (code=${code})`));
        }
      });

      // 唯一常驻 stdout 监听器
      child.stdout!.on('data', (c: Buffer) => this.onStdout(c));

      // initialize 握手（走统一 pending 机制）
      const initId = this.nextId++;
      this.sendRequest(child, { id: initId, method: 'initialize', params: {
        protocolVersion: 1, capabilities: {},
        clientInfo: { name: 'agents-to-feishu', version: '0.1.0' },
      }});

      // tsx 首次编译给足 120s
      const timeout = setTimeout(() => {
        if (!this.child) {
          try { child.kill('SIGTERM'); } catch {}
          reject(new Error('DSH ACP initialize timeout'));
        }
      }, 120_000);

      // 等 initialize 响应（保留 60s 兜底，initialize 不应长期挂起）
      this.waitResponse(initId, 60_000).then(
        (msg) => {
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error('DSH ACP initialize failed'));
            return;
          }
          rtLog(`[dsh] ACP initialized`);
          this.child = child;
          resolve(child);
        },
        (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      );
    });

    return this.spawnPromise;
  }

  /** 发请求并返回 promise（等统一监听器分发响应） */
  private sendRequest(child: ChildProcess, msg: unknown): void {
    child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  private waitResponse(id: number, timeoutMs?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      // 兜底超时：默认不超时（长任务可能很久，如访问外部 gateway / 长文本生成）。
      // 仅 initialize / session/new 等必须快速返回的请求显式传 timeoutMs。
      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`ACP request ${id} timeout`));
          }
        }, timeoutMs);
      }
    });
  }

  /** 在现有进程里开一个新 ACP session */
  private async createSession(cwd: string): Promise<AcpSession> {
    const child = await this.ensureProcess();
    const sessionNewId = this.nextId++;

    this.sendRequest(child, {
      jsonrpc: '2.0', id: sessionNewId, method: 'session/new',
      params: { cwd, mcpServers: [] },
    });

    const msg = await this.waitResponse(sessionNewId, 60_000);
    if (!msg.result) throw new Error('DSH ACP session/new failed');

    const sessionId = (msg.result as Record<string, unknown>).sessionId as string | undefined;
    if (!sessionId) throw new Error('DSH ACP session/new: missing sessionId');

    rtLog(`[dsh] session/new OK: ${sessionId.slice(0, 8)}`);
    this.pruneOldSessions();
    return { sessionId, cwd, lastUsed: Date.now(), personaInjected: false };
  }

  /**
   * 自动清理旧会话记录：保留最近 N 个 session 目录（按修改时间），更早的删除。
   * 对齐"新建聊天记录，旧记录备份保留 N 条"的语义。N 由 CTI_DSH_SESSION_KEEP 控制（默认 10）。
   */
  private pruneOldSessions(): void {
    try {
      const keep = parseInt(process.env.CTI_DSH_SESSION_KEEP || '10', 10);
      if (keep < 1) return;
      // 会话记录根目录：<DSH_HOME>/<bot>-bot/sessions/<cwd编码>/
      const acpConfig = process.env.CTI_DSH_ACP_CONFIG || '';
      const m = acpConfig.match(/\\(\w+)-bot\\(cordis\.yml)$/i) || acpConfig.match(/\/(\w+)-bot\/(cordis\.yml)$/i);
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const botSessionsRoot = m
        ? path.join(home, `${m[1]}-bot`, 'sessions')
        : path.join(home, 'dsh-bot', 'sessions');
      if (!fs.existsSync(botSessionsRoot)) return;
      const cwdDir = '--C-D-opt--';
      const dir = path.join(botSessionsRoot, cwdDir);
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); // 最新在前
      if (entries.length <= keep) return;
      const toRemove = entries.slice(keep);
      for (const p of toRemove) {
        try {
          // 只清纯 session 记录目录（内含 session.jsonl.zstd），不碰 db 索引
          fs.rmSync(p, { recursive: true, force: true });
          rtLog(`[dsh] pruned old session: ${path.basename(p)}`);
        } catch (e) {
          console.warn(`[dsh] prune session failed ${p}:`, e);
        }
      }
      rtLog(`[dsh] prune done: kept=${keep}, removed=${toRemove.length}`);
    } catch (e) {
      // 清理失败不影响主流程
      console.warn(`[dsh] pruneOldSessions error:`, e);
    }
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    const { sessionKey } = params;
    let session = this.sessions.get(sessionKey);

    // 会话数上限：超出按 LRU 淘汰最久未用的（进程内删绑定，进程不杀）
    if (this.sessions.size >= DshProvider.MAX_SESSIONS && !this.sessions.has(sessionKey)) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastUsed < oldestAt) { oldestAt = s.lastUsed; oldestKey = k; }
      }
      if (oldestKey) {
        this.sessions.delete(oldestKey);
        rtLog(`[dsh] LRU evict session ${oldestKey.slice(0, 8)} (cap=${DshProvider.MAX_SESSIONS})`);
      }
    }

    // /new 或首次，或该 session 刚被 interrupt 取消：开新 ACP session（复用进程，不杀）
    // （interrupt 后旧 turn 未释放，复用同一 sessionId 会 turn/start 冲突，必须新建）
    const sessionInterrupted = session ? this.interruptedSessionIds.has(session.sessionId) : false;
    if (!session || params.freshSession || sessionInterrupted) {
      if (session && sessionInterrupted) {
        this.interruptedSessionIds.delete(session.sessionId);
        this.sessions.delete(sessionKey);
        rtLog(`[dsh] interrupted session, opening new one for key ${sessionKey.slice(0, 8)}`);
      }
      try {
        session = await this.createSession(process.env.CTI_DEFAULT_WORKDIR || process.cwd());
        this.sessions.set(sessionKey, session);
        this.startCleanupTimer();
        if (params.freshSession) rtLog(`[dsh] freshSession: new acp session for key ${sessionKey.slice(0, 8)}`);
      } catch (e) {
        yield { type: 'error', message: `DSH ACP 会话创建失败: ${e instanceof Error ? e.message : String(e)}` };
        yield { type: 'done' };
        return;
      }
    }

    session.lastUsed = Date.now();

    // 首次注入人设
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

    // 设置活跃 prompt 处理器（统一监听器分发 session/update 到这里）
    // [去重修复 2026-08-25 v3] harness ACP 对一条回复会发两类 agent_message_chunk：
    //   ① text-delta 流式增量（多个，不带 _meta）—— 正文的逐段增量
    //   ② assistant/message 提交时整块再发一次（完整文本，带 _meta.usage）—— 等于增量总和
    // v1（字符串去重）在增量/完整块内容不完全一致时失效 → 重复。
    // v2（只信完整块、丢弃增量）解决了重复，但牺牲流式 → 打断时正文为空"（空回复）"。
    // v3 正解：增量照发（保持流式实时），完整块只收 usage 不再发正文（增量总和即完整正文）。
    // 效果：流式实时 + 不重复 + 打断时已发增量保留（不空回复）。
    // [流式唤醒] queue 空时不能傻等 settledP（会阻塞到 turn 结束，push 全攒 → 一次性 yield）。
    // 用 wakeup 信号：onUpdate push 后 poke() 唤醒 while，实时消费每个 delta。
    let wakeup: () => void = () => {};
    let wakeupP: Promise<void> = Promise.resolve();
    const poke = (): void => { wakeup(); };
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
            // 完整块（assistant/message 提交）：只收 usage，正文已由增量实时发出，不再重复发
            recordUsage(metaUsage);
            queue.push({ type: 'usage', usage: metaUsage, sessionId: session.sessionId });
            rtLog(`[dsh] commit chunk len=${delta?.length || 0} (usage only, text already streamed)`);
          } else if (delta) {
            // text-delta 增量：实时发出（流式）
            queue.push({ type: 'text', text: delta });
            poke();
            rtLog(`[dsh] text-delta len=${delta.length} preview=${delta.slice(0, 40).replace(/\n/g, '\\n')}`);
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
            // [2026-09-01] 透传工具结果文本（harness ACP 已带 rawOutput ≤2000 字符）；
            // send_voice 的 voiceId 就在里面，桥接靠它读语音对象投递到飞书
            output: typeof u.rawOutput === 'string' ? u.rawOutput.slice(0, 500) : undefined,
          });
          poke();
        }
      },
      onDone: (err?: string) => {
        if (err) settleErr = err;
        settled = true;
        resolveSettled();
      },
    };
    this.activePrompt = promptHandler;

    // 请求-响应：prompt 完成
    this.waitResponse(promptId).then(
      (msg) => {
        if (this.activePrompt === promptHandler) this.activePrompt = null;
        if (msg.error) promptHandler.onDone(msg.error.message || JSON.stringify(msg.error));
        else promptHandler.onDone();
      },
      () => {
        if (this.activePrompt === promptHandler) this.activePrompt = null;
        promptHandler.onDone('ACP prompt 响应超时');
      },
    );

    // 卡死看门狗：连续无输出判定卡死
    const watchdog = setInterval(() => {
      if (settled) { clearInterval(watchdog); return; }
      if (Date.now() - lastOutput > DshProvider.PROMPT_TIMEOUT_MS) {
        clearInterval(watchdog);
        promptHandler.onDone(`DSH ACP 卡死：连续 ${DshProvider.PROMPT_TIMEOUT_MS / 1000}s 无输出，已中断`);
        rtLog(`[dsh] watchdog timeout promptId=${promptId}`);
      }
    }, 30_000);

    this.sendRequest(child, {
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId: session.sessionId, prompt: [{ type: 'text', text: fullPrompt }] },
    });
    rtLog(`[dsh] prompt sent id=${promptId} session=${session.sessionId.slice(0, 8)}`);

    // 记录当前流的结束点：interrupt() 发 session/cancel 后要等它结束（turn 彻底 quiesce）
    // 才能放行下一条 prompt，否则 "turn/start 2 while turn 1 is still open"。
    let resolveStreamEnd: () => void = () => {};
    const streamEndP = new Promise<void>((r) => { resolveStreamEnd = r; });
    this.currentStreamEnd = streamEndP;
    // [流式修复 2026-08-25] queue 空时不能傻等 settledP（会阻塞到 turn 结束才唤醒，
    // 期间 push 的全攒着 → 一次性 yield = "憋一下全出"）。
    // 改为：push 时唤醒，while 只在"无新元素且未结束"时等待，实时消费每个 delta。
    try {
      while (true) {
        if (queue.length > 0) {
          const ev = queue.shift()!;
          yield ev;
          continue;
        }
        if (settled) break;
        // 等"新元素 或 结束"：每次 poke 重建 wakeupP
        wakeupP = new Promise<void>((r) => { wakeup = r; });
        const raceP = Promise.race([settledP, wakeupP]);
        // 若期间有元素入队或已结束，继续循环
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

export function createDshProvider(): DshProvider {
  return new DshProvider();
}
