/**
 * Hermes Provider — ACP 协议接入 `hermes --acp --yolo` 进程。
 *
 * 通过 HermesAppServerClient（hermes --acp 子进程，JSON-RPC 2.0 over stdio）通信。
 * 由 agents-to-feishu 统一管理人设/记忆/模型：
 * - 人设：params.systemPrompt（config-store 统一注入 + 独立注入），首条消息注入
 * - 模型：HermesConfig/system 决定，走 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL
 *
 * 协议：initialize → authenticate(gateway) → session/new → session/prompt
 * 流式事件：agent_message_chunk(+/think 标签) / agent_thought_chunk / tool_call
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HermesAppServerClient } from './hermes/hermes-app-server-client.js';
import type { HermesServerMessage } from './hermes/hermes-app-server-client.js';
import { readSessionMcpServers } from './shared/per-session-mcp.js';
import type { RuntimeProvider, StreamChatParams, StreamEvent, UsageInfo } from './types.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

type JsonRecord = Record<string, unknown>;

// MCP 穿透收编（2026-09-18）：readCtiMcpServers 已上收 src/providers/shared/per-session-mcp.ts，
// hermes 引擎行为 = 'stdioOnly'（http 型条目被拒，报错原文 -32602，实测矩阵见该模块注释）。

function extractSessionId(msg: HermesServerMessage): string {
  const params = typeof msg.params === 'object' && msg.params ? msg.params as JsonRecord : {};
  return typeof params.sessionId === 'string' ? params.sessionId : '';
}

export class HermesProvider implements RuntimeProvider {
  readonly name = 'hermes';

  /** 会话复用：sessionKey → app-server 会话（hermes 每次必须开新 session，靠此映射跨消息复用上下文） */
  private sessions = new Map<string, { sessionId: string; lastUsed: number; personaInjected: boolean }>();
  private static readonly MAX_SESSIONS = 20;

  private client: HermesAppServerClient | null = null;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cliPath: string;
  private readonly acpArgs: string[];
  private readonly modelGroup: string;

  constructor() {
    this.apiKey = process.env.CTI_HERMES_API_KEY || process.env.LITELLM_API_KEY || 'sk-200418';
    this.baseUrl = process.env.CTI_HERMES_BASE_URL || 'http://127.0.0.1:4000';
    this.cliPath = process.env.CTI_HERMES_CLI_PATH || 'hermes';
    this.modelGroup = process.env.CTI_BOT_HERMES_MODEL_GROUP || 'hermes-model';
    const base = ['acp', '--accept-hooks', '--yes'];
    const extra = process.env.CTI_HERMES_ACP_ARGS?.trim();
    if (extra) base.push(...extra.split(/\s+/));
    this.acpArgs = base;
  }

  private async ensureClient(): Promise<HermesAppServerClient> {
    if (this.client) {
      await this.client.prepare();
      return this.client;
    }
    const client = new HermesAppServerClient(this.cliPath, this.acpArgs);
    await client.prepare();
    this.client = client;
    return client;
  }

  async prepare(): Promise<void> {
    try { await this.ensureClient(); } catch (e) {
      console.warn(`[hermes] prepare failed:`, e);
    }
  }

  async resetSession(sessionKey?: string): Promise<void> {
    // hermes 跨消息靠 sessionKey → app-server 会话映射复用上下文；重置时清掉对应映射，
    // 下条消息（freshSession=true）会为新 sessionKey 开全新会话。
    if (sessionKey) {
      this.sessions.delete(sessionKey);
      rtLog(`[hermes] resetSession key=${sessionKey.slice(0, 8)} -> dropped, next msg opens fresh session`);
    } else {
      this.sessions.clear();
      rtLog(`[hermes] resetSession: all sessions dropped`);
    }
  }

  async interrupt(): Promise<void> {
    rtLog(`[hermes] interrupt: gems 由 app-server 管理，尽力取消`);
  }

  async dispose(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    const client = await this.ensureClient();
    let unsubscribe: (() => void) | null = null;

    // 事件队列 + 唤醒（对齐 opencode.ts 流式消费）
    const queue: StreamEvent[] = [];
    let settled = false;
    let settleErr: string | null = null;
    let gotText = false; // 是否已流出正文（超时判定）
    let wakeup: () => void = () => {};
    let wakeupP: Promise<void> = Promise.resolve();
    const poke = (): void => { wakeup(); };
    let settleResolve: () => void = () => {};
    const settledP = new Promise<void>((r) => { settleResolve = r; });

    let thinkingBuffer = '';

    // [2026-09-05 修复] 复用 app-server 会话：此前每次消息都新建 session 且不带 history，
    // 导致 bot 完全没有跨消息记忆。现在按 sessionKey 复用会话，跟 openakita 同款——
    // 只有 /new（freshSession=true）才开新会话，正常轮次靠 app-server 会话自带上下文。
    const { sessionKey } = params;
    let session = this.sessions.get(sessionKey);

    if (this.sessions.size >= HermesProvider.MAX_SESSIONS && !this.sessions.has(sessionKey)) {
      let oldestKey: string | null = null, oldestAt = Infinity;
      for (const [k, s] of this.sessions) if (s.lastUsed < oldestAt) { oldestAt = s.lastUsed; oldestKey = k; }
      if (oldestKey) this.sessions.delete(oldestKey);
    }

    // [2026-09-17] 仅本轮新建会话时才注入 history——engine 现恒传 history，
    // 若无此门控，正常轮次会把 bridge context 重复拼进已有会话（app-server 自带历史）。
    // 须在建会话前取值：建完 session 后 !session 恒 false，门控会失效。
    const injectHistory = !session || params.freshSession;
    if (!session || params.freshSession) {
      try {
        // 2026-08-30 修复：session/new 也挂起过（app-server 无响应）——120s 超时护栏
        const newSession = await Promise.race([
          client.call<{ sessionId: string }>('session/new', {
            cwd: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
            // 2026-09-18 实测结论：hermes 引擎的 session/new【拒绝一切非空 mcpServers】
            // （传配置中心勾选的任何 MCP 都回 Invalid params，与 cti-builtin 无关）。
            // 字段本身必传（去掉会报 Invalid params）；要给 hermes 挂工具走本穿透（只传 stdio，
            // 引擎行为 flag='stdioOnly'）。首轮"拒绝一切非空"系 http 条目被拒，实测记录见 openmem。
            mcpServers: readSessionMcpServers('hermes', 'stdioOnly'),
          }),
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error('session/new 超时 120s（app-server 无响应）')),
            120_000,
          )),
        ]);
        session = { sessionId: newSession.sessionId, lastUsed: Date.now(), personaInjected: false };
        this.sessions.set(sessionKey, session);
      } catch (e) {
        yield { type: 'error', message: `Hermes session/new 失败: ${e instanceof Error ? e.message : String(e)}` };
        yield { type: 'done' };
        return;
      }
    }

    const sessionId = session.sessionId;
    session.lastUsed = Date.now();
    rtLog(`[hermes] session ${params.freshSession ? 'CREATED' : 'REUSED'} ${sessionId.slice(0, 8)} key=${sessionKey.slice(0, 8)}`);

    // 人设：仅新会话首条消息注入；[2026-09-17] history 仅新建会话时注入（engine 恒传，靠 injectHistory 门控）。
    const historyText = injectHistory && params.history && params.history.length > 0
      ? params.history.map((m) => `[${m.role === 'user' ? '用户' : '助手'}]\n${m.content}`).join('\n\n')
      : '';
    const promptParts: string[] = [];
    if (params.systemPrompt && !session.personaInjected) promptParts.push(params.systemPrompt);
    if (historyText) promptParts.push(historyText);
    promptParts.push(params.text);
    session.personaInjected = true;
    const fullPrompt = promptParts.join('\n\n---\n\n');

    // [2026-09-05] 思考冻结防闪烁（同 zcode.ts）：只流式转发前 THINK_STREAM_HEAD 字后冻结💭，
    // 避免引擎的💭尾部滑动窗口整窗轮转（视觉=正文反复从头打）导致闪烁。终态补发真实思考尾部。
    const THINK_STREAM_HEAD = 400;
    const THINK_MERGE_MS = 1200;
    let thinkForwarded = 0;
    let thinkFrozen = false;
    let thinkBuf = '';
    let thinkFull = '';
    let thinkMergeTimer: ReturnType<typeof setTimeout> | null = null;
    const flushThink = (): void => {
      thinkMergeTimer = null;
      if (thinkFrozen || !thinkBuf) { thinkBuf = ''; return; }
      const head = thinkBuf.slice(0, Math.max(0, THINK_STREAM_HEAD - thinkForwarded));
      thinkBuf = '';
      if (head) { queue.push({ type: 'thinking', text: head }); thinkForwarded += head.length; poke(); }
      if (thinkForwarded >= THINK_STREAM_HEAD) thinkFrozen = true;
    };
    const pushThinking = (delta: string): void => {
      thinkFull += delta;
      if (thinkFrozen) return;
      thinkBuf += delta;
      if (thinkMergeTimer) return;
      thinkMergeTimer = setTimeout(flushThink, THINK_MERGE_MS);
    };
    const flushThinkingSync = (): void => { if (thinkMergeTimer) { clearTimeout(thinkMergeTimer); thinkMergeTimer = null; } flushThink(); };

    // 订阅 server notifications → push 事件
    unsubscribe = client.subscribe((message) => {
      if (extractSessionId(message) !== sessionId) return;

      // server request：处理 fs/read_text_file
      if (message.kind === 'request') {
        if (message.method === 'fs/read_text_file') {
          const reqParams = message.params as JsonRecord | undefined;
          const filePath = reqParams?.path ? String(reqParams.path) : '';
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            client.respond(message.id, { content }).catch(() => {});
          } catch (err) {
            client.respondError(message.id, -32000, `Read failed: ${String(err)}`).catch(() => {});
          }
        } else {
          client.respondError(message.id, -32601, `Method not supported: ${message.method}`).catch(() => {});
        }
        return;
      }

      const paramsRecord = (typeof message.params === 'object' && message.params ? message.params as JsonRecord : {});
      const update = paramsRecord.update as JsonRecord | undefined;
      const updateType = update?.sessionUpdate as string | undefined;
      const content = update?.content as JsonRecord | undefined;

      switch (updateType) {
        case 'agent_message_chunk': {
          const text = content?.text;
          if (typeof text === 'string') {
            // 兼容 /think 标签
            const tagStart = '<think>';
            const tagEnd = '</think>';
            const startIndex = thinkingBuffer.indexOf(tagStart);
            if (startIndex >= 0) {
              thinkingBuffer += text;
              const endIndex = thinkingBuffer.indexOf(tagEnd);
              const effectiveStart = thinkingBuffer.indexOf(tagStart);
              if (endIndex >= 0 && effectiveStart >= 0) {
                const thinkingText = thinkingBuffer.slice(effectiveStart + tagStart.length, endIndex).trim();
                const bodyText = (thinkingBuffer.slice(0, effectiveStart) + thinkingBuffer.slice(endIndex + tagEnd.length)).trim();
                if (thinkingText) { pushThinking(thinkingText); }
                thinkingBuffer = '';
                if (bodyText) { queue.push({ type: 'text', text: bodyText }); gotText = true; }
                poke();
              }
            } else if (text.includes(tagStart)) {
              const s = text.indexOf(tagStart);
              const head = text.slice(0, s).trim();
              if (head) { queue.push({ type: 'text', text: head }); gotText = true; }
              thinkingBuffer = text.slice(s);
              poke();
            } else {
              thinkingBuffer = '';
              queue.push({ type: 'text', text });
              poke();
            }
          }
          break;
        }
        case 'agent_thought_chunk': {
          const text = content?.text;
          if (typeof text === 'string') { pushThinking(text); }
          break;
        }
        case 'tool_call':
        case 'tool_call_update': {
          const status = String(update?.status || (updateType === 'tool_call' ? 'running' : 'done'));
          queue.push({
            type: 'tool',
            tool: String(update?.title || 'tool'),
            status: status === 'failed' ? 'error' : status === 'completed' ? 'done' : 'running',
            input: typeof update?.input === 'object' ? JSON.stringify(update.input).slice(0, 220) : String(update?.input ?? '').slice(0, 220),
          });
          poke();
          break;
        }
        default:
          break;
      }
    });

    // 发送 prompt（后台任务：hermes 的 prompt 响应只在 turn 结束返回，绝不能 await 它——
    // 否则流式事件全堵死。详见下方消费循环注释）
    const promptTask = (async (): Promise<void> => {
    try {
      // 2026-08-30 修复：prompt 加超时（与 gemini 同病——无超时挂起会卡死该 chat 队列，
      // 后续消息排队数十分钟全被判"过期消息"未处理）
      // 2026-08-31 重大修复：hermes 的 session/prompt 响应只在 turn 结束时返回——原来先 await prompt
      // 再消费队列，导致流式事件（thought/tool/text）全部堵到 turn 结束才一次性吐出，
      // 飞书卡片全程卡在"思考中"骨架。改为：prompt 后台跑，消费循环立即启动。
      const result = await Promise.race([
        client.call<{ stopReason: string; usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; thoughtTokens?: number } }>('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: fullPrompt }],
        }),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('[hermes] session/prompt 超时 600s（app-server 无响应，已释放队列）')),
          parseInt(process.env.CTI_HERMES_PROMPT_TIMEOUT_MS || '600000', 10),
        )),
      ]);
      const usg = result.usage;
      if (usg) {
        const u: UsageInfo = {
          inputTokens: usg.inputTokens || 0,
          outputTokens: usg.outputTokens || 0,
          cacheReadTokens: usg.cachedReadTokens || 0,
          reasoningTokens: usg.thoughtTokens || 0,
        };
        queue.push({ type: 'usage', usage: u, sessionId });
      }
      if (result.stopReason !== 'end_turn') {
        settleErr = `Hermes 非正常结束: stopReason=${result.stopReason}`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/超时/.test(msg) && gotText) {
        // 2026-08-30：正文已完整流出但结束信号超时——按正常完成处理，不报错
        console.warn('[hermes] 结束信号超时，但正文已完整流出——按正常完成处理');
      } else {
        settleErr = `Hermes prompt 失败: ${msg}`;
      }
    } finally {
      // 先刷出未合并的思考增量，再补发真实思考尾部（冻结后隐含正文继续，终卡显示尾部保真不闪）
      flushThinkingSync();
      if (thinkFull.length > thinkForwarded + 120) {
        queue.push({ type: 'thinking', text: `\n……\n${thinkFull.slice(-1100)}` });
      }
      settled = true;
      settleResolve();
      try { await client.notify('session/compact', { sessionId }); } catch {}
      unsubscribe?.();
    }
  })();

    // 消费队列（流式）——与 prompt 后台任务并发，事件到达即吐（卡片实时更新）
    void promptTask;
    try {
      while (true) {
        if (queue.length > 0) { yield queue.shift()!; continue; }
        if (settled) break;
        wakeupP = new Promise<void>((r) => { wakeup = r; });
        if (queue.length > 0 || settled) continue;
        await Promise.race([settledP, wakeupP]);
      }
    } finally {
      if (settleErr) yield { type: 'error', message: settleErr };
      yield { type: 'done' };
    }
  }
}

export function createHermesProvider(): HermesProvider {
  return new HermesProvider();
}
