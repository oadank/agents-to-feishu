/**
 * Claude Provider — 通过 @anthropic-ai/claude-agent-sdk 0.3.250 常驻接入官方 Claude Code CLI。
 *
 * 由 agents-to-feishu 统一管理人设/记忆/模型：
 * - 人设：params.systemPrompt（config-store 统一注入 + 独立注入）
 * - 模型：走 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN（第三方网关，如 henry-gao）
 *
 * 常驻长连接：query({prompt: AsyncIterable}) 起一个常驻 claude 进程，streamChat 每次
 * 把用户消息 push 进队列，同一 claude 进程连续多轮（不反复 spawn），复用 session。
 *
 * SDK 0.3.250 事件结构：assistant 完整消息（message.content[] 块：text / thinking / tool_use）。
 * tool_use 实时映射成 StreamEvent{tool}，供桥接层显示工具卡；thinking 映射成 {thinking}。
 * 权限：permissionMode=bypassPermissions + allowDangerouslySkipPermissions（全权限自动审批）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeProvider, StreamChatParams, StreamEvent } from './types.js';
import { buildClaudeBuiltinServer, setCurrentChatId } from '../tools/claude-tools.js';
import type { ClaudeBuiltinServer } from '../tools/claude-tools.js';
import type { BridgeToolDeps } from '../tools/registry.js';
import { buildWindowsPath } from './win-spawn-env.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

// ── 会话持久化（2026-08-31 重启保记忆）──
// P2-3 修复：惰性求值——模块加载早于 main() 里 config.env 灌 CTI_USER_HOME，常量会在错误时点取值
let _claudeSessionFile: string | null = null;
function claudeSessionFile(): string {
  if (!_claudeSessionFile) {
    _claudeSessionFile = path.join(
      process.env.CTI_USER_HOME || 'C:\Users\oadan',
      '.agents-to-feishu', 'runtime', 'claude-session.txt',
    );
  }
  return _claudeSessionFile;
}

function readSavedSessionId(): string | null {
  try {
    const id = fs.readFileSync(claudeSessionFile(), 'utf-8').trim();
    return /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch { return null; }
}

function writeSavedSessionId(id: string): void {
  fs.mkdirSync(path.dirname(claudeSessionFile()), { recursive: true });
  fs.writeFileSync(claudeSessionFile(), id, 'utf-8');
}

function clearSavedSessionId(): void {
  try { fs.rmSync(claudeSessionFile(), { force: true }); } catch { /* 忽略 */ }
}

// usage 落盘统一由 bridge 层承担（engine.ts 消费 {type:'usage'} 事件 → src/bridge/stats.ts recordStats），
// 此处不再 provider 内落盘（否则双写）。状态条缓存命中率/上下文数据源：~/.dsh/claude-bot/stats/。

/**
 * 瞬态故障重试 + 空闲看门狗（2026-08-29）。
 *
 * 背景：网关 gateway.henry-gao.com 偶发抖动（502/503/504/429/网络中断），属瞬态，重试即可恢复；
 * 此前代码零重试 + 无超时 ⇒ 一条瞬态错误直接葬送整轮，且网关把连接挂住不返回时会一直卡到网关自己放弃。
 *
 * 设计原则（对齐用户要求）：
 * - **不加"总时长超时"**：claude 生图/长任务跑几小时是常态，一刀切超时会杀正常长任务。
 * - **空闲看门狗**：只在"完全零事件"超过 STALL_MS 才判定流卡死 ⇒ 活跃生成（持续吐字）、
 *   工具事件（持续到达）都**不触发**；只有网关真把流掐断、长时间无响应才兜底。默认 5 分钟，
 *   CTI_CLAUDE_STALL_MS 可调大（如长命令构建场景）。
 * - **重试**：is_error 且属瞬态（502/5xx/429/网络/超时）或空闲卡死 ⇒ 重投 prompt（对齐老项目
 *   zcode-provider.ts:543-565 的 pendingRetryPrompt 重投模式），指数退避 1s/2s/4s，最多 MAX_RETRIES 次。
 */
const MAX_RETRIES = Number(process.env.CTI_CLAUDE_MAX_RETRIES ?? 3);
const STALL_MS = Number(process.env.CTI_CLAUDE_STALL_MS ?? 300_000); // 5min 零事件 → 判定卡死
/** 瞬态、可重试的错误特征（出现在 error 事件 message 里：gateway/SDK 原始细节） */
const RETRYABLE_RE = /502|503|504|429|backend request failed|ECONNRESET|ETIMEDOUT|timed out|socket hang up|network error|gateway|rate.?limit/i;
/** 永久、不可重试的错误（重试纯浪费）：鉴权/权限/上下文超长/内容策略 */
const NON_RETRYABLE_RE = /permission|forbidden|content.?policy|invalid_api_key|authentication|api[_ ]?key|unauthorized|context.?length|max.?token|too long/i;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 从 ~/.dsh/.credentials.yaml 读 ANTHROPIC_AUTH_TOKEN（兜底） */
function readAnthropicAuthToken(): string {  const explicit = process.env.ANTHROPIC_AUTH_TOKEN;
  if (explicit) return explicit;
  try {
    const cred = `${process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\oadan'}\\.dsh\\.credentials.yaml`;
    const txt = fs.readFileSync(cred, 'utf-8');
    const m = txt.match(/^\s*ANTHROPIC_AUTH_TOKEN\s*:\s*(\S+)/m);
    if (m) return m[1];
  } catch {}
  return '';
}

/**
 * 可 push 的 async iterable：作为 query 的常驻 prompt 流（支持多轮持续喂）。
 *
 * 2026-08-29 修复（空闲看门狗 + 重试必须依赖此修复）：
 * 原实现 close() 仅置 closed=true，但不唤醒正在 await 的消费者（多 waiter 设计也
 * 有丢失风险）⇒ 当 claude 流被网关截断、没有任何 result/error 终态事件到达时，
 * 引擎的 `for await (const ev of out)` 会永久阻塞 ⇒ 卡片停在半截永不收尾（"说一半没消息"）。
 * 改为单 waiter + close() 立即唤醒：close 后消费者看到 closed 直接退出，不再死等。
 */
class PushQueue<T> {
  private items: T[] = [];
  private resolve: (() => void) | null = null;
  private closed = false;
  push(item: T): void {
    this.items.push(item);
    if (this.resolve) { const r = this.resolve; this.resolve = null; r(); }
  }
  close(): void {
    this.closed = true;
    if (this.resolve) { const r = this.resolve; this.resolve = null; r(); }
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length) { yield this.items.shift()!; }
      else if (this.closed) { return; }
      else { await new Promise<void>((res) => { this.resolve = res; }); }
    }
  }
}

interface ContentBlock { type?: string; text?: string; thinking?: string; name?: string; input?: unknown }

interface RoundSink { chatId: string; emit: (ev: StreamEvent) => void }

export class ClaudeProvider implements RuntimeProvider {
  readonly name = 'claude';

  private cliPath: string;
  private baseUrl: string;
  /** 常驻进程的工作目录。cwd 是**进程级属性**，启动后无法更改 ⇒ /new [目录] 必须重建进程 */
  private cwd: string;
  private q: Query | null = null;
  private queue: PushQueue<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; shouldQuery: boolean }> | null = null;
  private pumpPromise: Promise<void> | null = null;
  /**
   * 等待中的轮次 sink，FIFO 队列。
   *
   * 背景（2026-08-29 修复）：原先是单实例 `sink`，多个 chat 并发时后一轮直接覆盖前一轮，
   * 导致 ① 先前轮次永远等不到 done ⇒ `for await` 永久挂起 ⇒ 该 chat 队列永不释放、
   * 后续消息全部堆积；② 内容串台（A 的回答出现在 B 的聊天里）。
   *
   * 常驻 claude 进程串行消费 prompt 队列，事件按同一顺序返回 ⇒ **事件归属 = 队首 sink**。
   * 故改为 FIFO：注册入队尾，收到 result（本轮终态）后队首出队。
   */
  private sinks: RoundSink[] = [];

  /** 桥接内置工具（Phase 1）：工具依赖 + 进程内工具 server。attachBridgeTools 接线，ensureProcess 注入 */
  private toolDeps: BridgeToolDeps = {};
  private sdkMcp: ClaudeBuiltinServer | null = null;

  constructor() {
    this.cliPath = process.env.CTI_CLAUDE_CLI_PATH
      || (fs.existsSync('C:\\WINDOWS\\system32\\claude.bat') ? 'C:\\WINDOWS\\system32\\claude.bat' : 'claude');
    this.baseUrl = process.env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:4000/';
    this.cwd = process.env.CTI_DEFAULT_WORKDIR || process.cwd();
  }

  /**
   * 桥接接线：注入内置工具依赖（sendVoice / getSpeech）。幂等，以最后一次为准。
   * 必须在首条消息（ensureProcess）之前调用——mcpServers 只在 query() 创建时生效。
   */
  attachBridgeTools(deps: BridgeToolDeps): void {
    this.toolDeps = deps;
    this.sdkMcp = buildClaudeBuiltinServer(deps);
    rtLog('[claude] attachBridgeTools: 进程内内置工具 server 已构建（look_image/generate_image/reverse_prompt/transcribe/send_voice）');
  }

  /**
   * 启动常驻 claude 进程（query + AsyncIterable prompt 队列 + 事件泵）。
   *
   * 传入 workdir 且与进程当前 cwd 不一致时**必须重建**：cwd 是进程级属性，
   * 进程启动后无法更改（这就是 /new [目录] 此前对 claude 完全无效的根因）。
   */
  private ensureProcess(workdir?: string): void {
    const targetCwd = workdir?.trim() || this.cwd;
    if (this.q && targetCwd !== this.cwd) {
      rtLog(`[claude] 工作目录 ${this.cwd} -> ${targetCwd}：重建常驻进程`);
      this.cwd = targetCwd;
      void this.dispose();
    }
    if (this.q) return;
    const queue = new PushQueue<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; shouldQuery: boolean }>();
    const authToken = readAnthropicAuthToken();
    // 2026-08-31 坑（读 SDK 源码实锤）：sdk.mjs 里 `env = options.env ? {...options.env} : {...process.env}`
    // —— 传了 env 就【整体替换】子进程环境，不是合并！此前只传 2-3 个变量 ⇒ 桥接灌回的
    // GITHUB_TOKEN/用户配置全丢（agent 说"token 无效/未登录"的真根因之一）。
    // 必须显式带全 process.env，再覆盖桥接专属键；PATH 用统一收口的补全列表。
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
      ANTHROPIC_BASE_URL: this.baseUrl,
      PATH: buildWindowsPath(process.env.PATH),
    };
    if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
    try {
      const q = query({
        prompt: queue,
        options: {
          cwd: this.cwd,
          ...(this.cliPath ? { pathToClaudeCodeExecutable: this.cliPath } : {}),
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          // 2026-08-31 重启保记忆：resume 上次会话（SDK jsonl 落盘于 ~/.claude/projects）
          ...(readSavedSessionId() ? { resume: readSavedSessionId() as string } : {}),
          // P2-9 修复（2026-08-29）：env 必须总是传。
          // 原写法 `...(env.ANTHROPIC_AUTH_TOKEN ? { env } : {})` 在读不到 token 时会连
          // ANTHROPIC_BASE_URL 一起丢掉 ⇒ claude 退化为直连官方 API，而不是第三方网关。
          env,
          // Phase 1 内置工具注入：进程内 server（内存直调，无 HTTP）。attachBridgeTools 必须先于首条消息调用。
          ...(this.sdkMcp ? { mcpServers: this.sdkMcp.spec } : {}),
        },
      });
      this.q = q;
      this.queue = queue;
      this.startPump(q);
      rtLog(`[claude] ensureProcess: 已起重进程 cwd=${this.cwd}`);
    } catch (e) {
      rtLog(`[claude] ensureProcess spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      this.q = null; this.queue = null; this.sinks = [];
      throw e;
    }
  }

  /** 当前应接收事件的轮次 sink = FIFO 队首 */
  private activeSink(): RoundSink | null {
    return this.sinks[0] ?? null;
  }

  /** 本轮终态出队后：把会话敏感工具（send_voice 等）的归属切到下一个队首轮次 */
  private reassignActiveChat(): void {
    const next = this.sinks[0];
    setCurrentChatId(next ? next.chatId : null);
  }

  /** 事件泵：常驻消费 query 的消息，路由给当前轮次 sink（队首） */
  private startPump(q: Query): void {
    this.pumpPromise = (async () => {
      try {
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
            const blocks = msg.message.content as ContentBlock[];
            const sink = this.activeSink();
            for (const b of blocks) {
              if (!b || !sink) continue;
              if (b.type === 'text' && b.text) sink.emit({ type: 'text', text: b.text });
              else if (b.type === 'thinking' && b.thinking) sink.emit({ type: 'thinking', text: b.thinking });
              else if (b.type === 'tool_use') sink.emit({ type: 'tool', tool: b.name || 'tool', input: JSON.stringify(b.input ?? '').slice(0, 200), status: 'done' });
            }
          } else if (msg.type === 'result') {
            const r = msg as {
              is_error?: boolean;
              subtype?: string;
              result?: unknown;
              session_id?: string;
              num_turns?: number;
              usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
            };
            const sink = this.activeSink();
            if (sink) {              // 发真实 usage（sessionId = claude 真实会话，状态条/AI 记忆用真实数据）
              const u = r.usage;
              if (u && (u.input_tokens != null || u.output_tokens != null || u.cache_read_input_tokens != null)) {
                const usageInfo = {
                  inputTokens: u.input_tokens ?? 0,
                  outputTokens: u.output_tokens ?? 0,
                  cacheReadTokens: u.cache_read_input_tokens ?? 0,
                  cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
                  requests: r.num_turns ?? 1,
                };
                // 统一落盘已移到 bridge 层（engine.ts 消费 usage 事件时写 stats 文件），
                // 此处只发 usage 事件，避免双写。
                if (r.session_id) { try { writeSavedSessionId(r.session_id); } catch { /* 忽略 */ } }
                if (r.session_id) rtLog(`[claude] usage session_id=${r.session_id.slice(0, 8)}`);
                sink.emit({ type: 'usage', sessionId: r.session_id, usage: usageInfo });
              }
              // 错误事件带上 gateway/SDK 原始细节（subtype + result 文本），供 streamChat 判断是否属于瞬态可重试。
              // 原先只发 "Claude 会话非正常结束"，导致 502/超时等瞬态错误无法被识别、也就无法重试。
              let errMsg = 'Claude 会话非正常结束';
              if (r.is_error) {
                const detail = [r.subtype, typeof r.result === 'string' ? r.result : ''].filter(Boolean).join(' ').slice(0, 400);
                errMsg = detail ? `Claude 会话非正常结束：${detail}` : `Claude 会话非正常结束（subtype=${r.subtype ?? 'unknown'}）`;
              }
              sink.emit(r.is_error ? { type: 'error', message: errMsg } : { type: 'done' });
              // 本轮终态：立即出队，后续事件归属下一个轮次（否则下一轮事件会错发到本轮）
              this.sinks.shift();
              this.reassignActiveChat();
            }
          }
        }
      } catch (e) {
        const sink = this.activeSink();
        if (sink) {
          sink.emit({ type: 'error', message: `Claude SDK 泵停止: ${e instanceof Error ? e.message : String(e)}` });
          this.sinks.shift();
          this.reassignActiveChat();
        }
      }
    })();
  }

  async prepare(): Promise<void> {
    rtLog(`[claude] prepare: cli=${this.cliPath} baseUrl=${this.baseUrl}`);
    try { this.ensureProcess(); rtLog('[claude] 常驻进程已启动'); }
    catch (e) { console.warn('[claude] prepare pre-spawn failed:', e); }
  }

  async resetSession(_key?: string): Promise<void> {
    clearSavedSessionId();
    rtLog('[claude] resetSession: 清除持久化会话（/new）');
    // 2026-08-29 修复：/new 必须真正重置，不能是 no-op。
    // 对齐老项目 inbound-handler.ts:362-375 的 resetProviderCache 语义 —— 老项目是 kill 底层
    // 引擎进程，让下一条消息必然走全新会话。claude 的上下文就活在常驻进程里，只有释放重建
    // 才能真正归零。此前这里是空的，导致 /new 后上下文照旧累积，命令却回"✅ 已新建会话"。
    if (this.q) {
      rtLog('[claude] resetSession: 释放常驻进程，下一条消息起为全新会话');
      await this.dispose();
    } else {
      rtLog('[claude] resetSession: 无活跃进程，跳过释放');
    }
    // 立即起重进程：确保下一条消息必然走全新会话，而非依赖下次消息时 ensureProcess 的惰性重建。
    // 即便 q.close() 未能即时杀掉旧子进程，此处起的干净新进程也会被下次消息优先使用。
    this.ensureProcess();
    rtLog('[claude] resetSession: 已立即起重进程');
  }

  async interrupt(): Promise<void> {
    // SDK Query.interrupt() 真实中断当前 turn（会截断当前 assistant 流，本轮以 done 结束）
    try {
      if (this.q) {
        await this.q.interrupt();
        rtLog('[claude] interrupt: SDK query.interrupt() 已调用');
      } else {
        rtLog('[claude] interrupt: 无活跃 query，跳过');
      }
    } catch (e) {
      rtLog(`[claude] interrupt failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async dispose(): Promise<void> {
    try { this.queue?.close(); this.q?.close(); } catch {}
    // 唤醒所有仍在等待的轮次，避免调用方永久挂起（原先只置空 sink，等待方会一直卡在 for await）
    for (const s of this.sinks) {
      try { s.emit({ type: 'error', message: 'Claude 进程已释放' }); } catch {}
    }
    this.q = null; this.queue = null; this.sinks = []; this.pumpPromise = null;
    rtLog('[claude] dispose');
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    await Promise.resolve();
    try { this.ensureProcess(params.workdir); } catch (e) {
      yield { type: 'error', message: `Claude 启动失败: ${e instanceof Error ? e.message : String(e)}` };
      yield { type: 'done' }; return;
    }
    rtLog(`[claude] streamChat: freshSession=${params.freshSession} workdir=${params.workdir || this.cwd} historyLen=${params.history?.length ?? 0} text.len=${(params.text || '').length}`);
    // 新建会话时注入历史上下文（含 /compact 产出的摘要）。
    // 对齐老项目 compact.ts applyCompactResult：摘要作为会话开头内容进入，后续模型自然携带。
    // 2026-08-29 修复：此前 session.context 从未被消费，/compact 压缩完就丢，命令还谎称会带上。
    const historyText = params.freshSession && params.history && params.history.length > 0
      ? params.history.map((m) => `[${m.role === 'user' ? '用户' : '助手'}]\n${m.content}`).join('\n\n')
      : '';
    const body = historyText ? `${historyText}\n\n---\n\n${params.text}` : params.text;
    const fullPrompt = params.systemPrompt ? `${params.systemPrompt}\n\n${body}` : body;
    const q = this.q!, queue = this.queue!;
    if (!q || !queue) { yield { type: 'error', message: 'Claude 进程未就绪' }; yield { type: 'done' }; return; }

    // ── 重试 + 空闲看门狗主循环 ──
    // 对齐老项目 zcode-provider.ts:543-565 的 pendingRetryPrompt：瞬态故障后重投 prompt。
    // 注意：重试"重投 prompt"对 502（本轮已以 is_error 终态、sink 已出队）是干净的新一轮；
    // 对"流被截断无终态"的 stall 场景会重复一条用户消息（罕见），换取"不永久卡死"。
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // 本轮接收缓冲：单 waiter PushQueue（close 可唤醒）
      const out = new PushQueue<StreamEvent>();
      let lastEventAt = Date.now();
      let stalled = false;
      // 空闲看门狗：每 10s 检查，若 STALL_MS 内零事件 ⇒ 判定流卡死，close 唤醒消费者。
      // 活跃生成（持续吐字）/ 工具事件（持续到达）都会刷新 lastEventAt，绝不误杀长任务。
      const stallTimer = setInterval(() => {
        if (Date.now() - lastEventAt >= STALL_MS) {
          stalled = true;
          rtLog(`[claude] 空闲 ${Math.round(STALL_MS / 1000)}s 零事件，判定流卡死，准备重试/放弃 attempt=${attempt}`);
          out.close(); // PushQueue.close 会唤醒正在 await 的消费者
        }
      }, 10_000);
      // 注册 sink 与投递 prompt 必须连续同步执行（中间不能有 await）：
      // 常驻进程按 prompt 投递顺序串行处理，事件按同序返回，两者顺序必须一致。
      const sink: RoundSink = { chatId: params.sessionKey, emit: (ev) => { lastEventAt = Date.now(); out.push(ev); } };
      this.sinks.push(sink);
      // 成为队首 = claude 将立即处理本 prompt ⇒ 会话敏感工具（send_voice 等）此刻起归属本 chat
      if (this.sinks.length === 1) setCurrentChatId(params.sessionKey);
      queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: fullPrompt }] }, parent_tool_use_id: null, shouldQuery: true });

      let doneErr: string | null = null;
      try {
        for await (const ev of out) {
          if (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool' || ev.type === 'usage') {
            yield ev; // 正文/思考/工具/用量：透传给引擎，不中断
          } else if (ev.type === 'done') {
            clearInterval(stallTimer);
            yield { type: 'done' };
            return; // 正常收尾
          } else if (ev.type === 'error') {
            doneErr = (ev as { message: string }).message;
            break; // 出 for-await，走下方重试/收尾判定
          }
        }
      } finally {
        clearInterval(stallTimer);
        // 兜底出队：正常路径由 pump 在收到 result 时 shift，异常/stall 时在此清理，防止泄漏
        const i = this.sinks.indexOf(sink);
        if (i >= 0) this.sinks.splice(i, 1);
        out.close();
      }

      // ── 本轮以 error 或 stall 结束：判断是否可重试 ──
      const retryable = stalled || (!!doneErr && RETRYABLE_RE.test(doneErr) && !NON_RETRYABLE_RE.test(doneErr));
      if (retryable && attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000); // 退避 1s/2s（attempt 只取 1、2：下方要求 attempt < MAX_RETRIES，4s 分支不可达）
        rtLog(`[claude] 瞬态故障，第 ${attempt} 次重试（${delay}ms 后）: ${doneErr ?? (stalled ? '(stall)' : '')}`);
        yield { type: 'text', text: `\n⚠️ 网关瞬态故障，自动重试中（${attempt}/${MAX_RETRIES}）…` };
        await sleep(delay);
        continue; // 下一轮 attempt 重新注册 sink + 重投 prompt
      }
      // P1 修复：resume 的持久化会话报不可重试错误（损坏/超窗/被清理）→ 清除记录自愈，
      // 否则此后每条消息都 resume 同一坏会话，bot 变砖直到手动 /new
      if (doneErr && NON_RETRYABLE_RE.test(doneErr) && readSavedSessionId()) {
        clearSavedSessionId();
        rtLog(`[claude] resume 会话不可恢复（${doneErr.slice(0, 120)}），已清除 session_id，下条消息开新会话`);
      }
      // 不可重试 / 重试耗尽：明确回报，绝不静默半截
      if (doneErr) yield { type: 'error', message: doneErr };
      else if (stalled) yield { type: 'error', message: `⚠️ 回复中断：网关约 ${Math.round(STALL_MS / 1000)}s 无响应，已放弃重试。可重发本条消息。` };
      yield { type: 'done' };
      return;
    }
  }
}

export function createClaudeProvider(): ClaudeProvider {
  return new ClaudeProvider();
}
