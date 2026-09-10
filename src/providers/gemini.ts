/**
 * Gemini Provider — ACP 协议接入 `gemini --acp --yolo` 进程。
 *
 * 通过 GeminiAppServerClient（gemini --acp 子进程，JSON-RPC 2.0 over stdio）通信。
 * 由 agents-to-feishu 统一管理人设/记忆/模型：
 * - 人设：params.systemPrompt（config-store 统一注入 + 独立注入），首条消息注入
 * - 模型：GeminiConfig/system 决定，走 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL
 *
 * 协议：initialize → authenticate(gateway) → session/new → session/prompt
 * 流式事件：agent_message_chunk(+/think 标签) / agent_thought_chunk / tool_call
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiAppServerClient } from './gemini/gemini-app-server-client.js';
import type { GeminiServerMessage } from './gemini/gemini-app-server-client.js';
import type { RuntimeProvider, StreamChatParams, StreamEvent, UsageInfo } from './types.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

// MCP 穿透（2026-09-10）：配置中心勾选的 MCP 池（render.ts 下发 CTI_BOT_<ID>_MCP_SERVERS JSON）
// 映射为 ACP session/new 的 mcpServers。stdio → name/command/args/env；http 类 → name/url。
function readCtiMcpServers(botId: string): Array<Record<string, unknown>> {
  try {
    const raw = process.env[`CTI_BOT_${botId.toUpperCase()}_MCP_SERVERS`] || '';
    if (!raw) return [];
    const defs = JSON.parse(raw) as Array<{ id: string; transport: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }>;
    return defs.map((m) => {
      if (m.transport === 'stdio' && m.command) {
        return { name: m.id, command: m.command, args: m.args || [], env: Object.entries(m.env || {}).map(([k, v]) => ({ name: k, value: v })) };
      }
      if (m.url) return { name: m.id, url: m.url };
      return null;
    }).filter((x): x is Record<string, unknown> => !!x);
  } catch {
    return [];
  }
}

type JsonRecord = Record<string, unknown>;

function extractSessionId(msg: GeminiServerMessage): string {
  const params = typeof msg.params === 'object' && msg.params ? msg.params as JsonRecord : {};
  return typeof params.sessionId === 'string' ? params.sessionId : '';
}

export class GeminiProvider implements RuntimeProvider {
  readonly name = 'gemini';

  /** 会话复用：sessionKey → app-server 会话（gemini 每次必须开新 session，靠此映射跨消息复用上下文） */
  private sessions = new Map<string, { sessionId: string; lastUsed: number; personaInjected: boolean }>();
  private static readonly MAX_SESSIONS = 20;

  private client: GeminiAppServerClient | null = null;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cliPath: string;
  private readonly acpArgs: string[];
  private readonly modelGroup: string;
  private readonly model: string;

  constructor() {
    // 真实值优先读 config-center 渲染的 CTI_BOT_GEMINI_*（config.env 灌入 process.env）：
    //   CTI_BOT_GEMINI_MODEL=真实模型 ID（如 deepseek-v4-flash）
    //   CTI_BOT_GEMINI_BASE_URL=网关地址（render.ts 对 ACP 直连型 provider 指到 LiteLLM 4000，
    //                             因为 gemini CLI 直连火山 Ark 认证不适配会 401，必须走 LiteLLM 中转）
    //   api_key：gemini 走 LiteLLM 网关(4000)，认证 key 必须是 LiteLLM 虚拟 key（sk- 开头）。
    //             config.env 里 OPENAI_API_KEY=sk-200418 即该虚拟 key（实测调 4000 通）；
    //             严禁 fallback 到 ARK_API_KEY(ark- 开头)——LiteLLM 会回 "LiteLLM Virtual Key expected" 401。
    this.apiKey = process.env.OPENAI_API_KEY
      || process.env.LITELLM_API_KEY
      || process.env.CTI_BOT_GEMINI_API_KEY
      || process.env.CTI_GEMINI_API_KEY
      || process.env.ARK_API_KEY
      || 'sk-200418';
    this.baseUrl = process.env.CTI_BOT_GEMINI_BASE_URL
      || process.env.CTI_GEMINI_BASE_URL
      || 'http://127.0.0.1:4000';
    this.cliPath = process.env.CTI_GEMINI_CLI_PATH || 'gemini';
    this.modelGroup = process.env.CTI_BOT_GEMINI_MODEL_GROUP || 'gemini-model';
    // 真实模型 ID：--model 必须传网关里实际存在的模型名（不能传 MODEL_GROUP 标签如 ArkV4F，
    // 否则报 Invalid model name）。读 config-center 渲染的 CTI_BOT_GEMINI_MODEL（真实 ID）。
    this.model = process.env.CTI_BOT_GEMINI_MODEL
      || process.env.CTI_GEMINI_MODEL
      || 'deepseek-v4-flash';
    const includeDirs = process.platform === 'win32'
      ? '--include-directories=C:\\\\,C:\\\\Users,C:\\\\D'
      : '--include-directories=/,/root,/opt,/tmp';
    this.acpArgs = ['--acp', '--yolo', '--model', this.model, includeDirs];
  }

  private async ensureClient(): Promise<GeminiAppServerClient> {
    if (this.client) {
      await this.client.prepare();
      return this.client;
    }
    const client = new GeminiAppServerClient({
      executable: this.cliPath,
      acpArgs: this.acpArgs,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
    });
    await client.prepare();
    this.client = client;
    return client;
  }

  async prepare(): Promise<void> {
    try { await this.ensureClient(); } catch (e) {
      console.warn(`[gemini] prepare failed:`, e);
    }
  }

  async resetSession(sessionKey?: string): Promise<void> {
    // gemini 跨消息靠 sessionKey → app-server 会话映射复用上下文；重置时清掉对应映射，
    // 下条消息（freshSession=true）会为新 sessionKey 开全新会话。
    if (sessionKey) {
      this.sessions.delete(sessionKey);
      rtLog(`[gemini] resetSession key=${sessionKey.slice(0, 8)} -> dropped, next msg opens fresh session`);
    } else {
      this.sessions.clear();
      rtLog(`[gemini] resetSession: all sessions dropped`);
    }
  }

  async interrupt(): Promise<void> {
    rtLog(`[gemini] interrupt: gems 由 app-server 管理，尽力取消`);
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
    let gotText = false; // 是否已流出正文（超时判定：有正文=内容已完成不报错）
    let wakeup: () => void = () => {};
    let wakeupP: Promise<void> = Promise.resolve();
    const poke = (): void => { wakeup(); };
    let settleResolve: () => void = () => {};
    const settledP = new Promise<void>((r) => { settleResolve = r; });

    let thinkingBuffer = '';

    // [2026-09-05 修复] 复用 app-server 会话：此前每次消息都新建 session 且不带 history，
    // 导致 bot 完全没有跨消息记忆（"你说得对，我确实没有你刚才那段话的上下文记忆"）。
    // 现在按 sessionKey 复用会话，跟 openclaw 同款——只有 /new（freshSession=true）或
    // 中断后才开新会话，正常轮次靠 app-server 会话自带上下文。
    const { sessionKey } = params;
    let session = this.sessions.get(sessionKey);

    if (this.sessions.size >= GeminiProvider.MAX_SESSIONS && !this.sessions.has(sessionKey)) {
      let oldestKey: string | null = null, oldestAt = Infinity;
      for (const [k, s] of this.sessions) if (s.lastUsed < oldestAt) { oldestAt = s.lastUsed; oldestKey = k; }
      if (oldestKey) this.sessions.delete(oldestKey);
    }

    if (!session || params.freshSession) {
      try {
        // 2026-08-30：session/new 加 120s 超时护栏（与 hermes 同款，防 app-server 挂起卡队列）
        const newSession = await Promise.race([
          client.call<{ sessionId: string }>('session/new', {
            cwd: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
            mcpServers: readCtiMcpServers('gemini'),
          }),
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error('session/new 超时 120s（app-server 无响应）')),
            120_000,
          )),
        ]);
        session = { sessionId: newSession.sessionId, lastUsed: Date.now(), personaInjected: false };
        this.sessions.set(sessionKey, session);
      } catch (e) {
        yield { type: 'error', message: `Gemini session/new 失败: ${e instanceof Error ? e.message : String(e)}` };
        yield { type: 'done' };
        return;
      }
    }

    const sessionId = session.sessionId;
    session.lastUsed = Date.now();
    rtLog(`[gemini] session ${params.freshSession ? 'CREATED' : 'REUSED'} ${sessionId.slice(0, 8)} key=${sessionKey.slice(0, 8)}`);

    // 人设：仅新会话首条消息注入；[2026-09-05] 中断保留历史：注入 bridge 存的 session.context。
    // /new（freshSession）清空白语义不注入；正常轮次靠 app-server 会话自带历史不注入。
    if (!session.personaInjected) {
      session.personaInjected = true;
    }

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
    // 结束时若有未合并的思考增量，立即刷出（保持顺序：须在 queue 排空前调用）
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
              queue.push({ type: 'text', text }); gotText = true;
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

    // 人设 + 上下文拼接：[2026-09-05] 新会话首条注入 systemPrompt；
    // 中断（sessionKey 首次出现时为 null，无法区分）仅靠 app-server 会话，故正常轮次不注入 history；
    // 但若 bridge 显式传了 history（/compact 摘要或中断保留），优先注入以保上下文。
    const historyText = params.history && params.history.length > 0
      ? params.history.map((m) => `[${m.role === 'user' ? '用户' : '助手'}]\n${m.content}`).join('\n\n')
      : '';
    const promptParts: string[] = [];
    if (params.systemPrompt) promptParts.push(params.systemPrompt);
    if (historyText) promptParts.push(historyText);
    promptParts.push(params.text);
    const fullPrompt = promptParts.join('\n\n---\n\n');

    // 发送 prompt（后台任务：gemini 的 session/prompt 响应只在 turn 结束返回，绝不能 await 它——
    // 否则流式事件（thought/tool/text）全堵死到 turn 结束才一次性吐出，卡片全程卡"思考中"、
    // 百分比不动。与 hermes 2026-08-31 同款修复：prompt 后台跑，消费循环立即启动）
    const promptTask = (async (): Promise<void> => {
    try {
      const result = await Promise.race([
        client.call<{ stopReason: string; _meta?: { quota?: { token_count?: { input_tokens?: number; output_tokens?: number } } } }>('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: fullPrompt }],
        }),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('[gemini] session/prompt 超时 600s（app-server 无响应，已释放队列）')),
          parseInt(process.env.CTI_GEMINI_PROMPT_TIMEOUT_MS || '600000', 10),
        )),
      ]);
      const usage = result._meta?.quota?.token_count;
      if (usage) {
        const u: UsageInfo = {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: 0,
        };
        queue.push({ type: 'usage', usage: u, sessionId });
      }
      if (result.stopReason !== 'end_turn') {
        settleErr = `Gemini 非正常结束: stopReason=${result.stopReason}`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/超时/.test(msg) && gotText) {
        // 2026-08-30 修复（老大实测）：内容早已流出完毕，但 app-server 忘发结束信号
        // ⇒ 超时触发时视为正常完成，不再报错吓人
        console.warn('[gemini] 结束信号超时，但正文已完整流出——按正常完成处理');
      } else {
        settleErr = `Gemini prompt 失败: ${msg}`;
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

export function createGeminiProvider(): GeminiProvider {
  return new GeminiProvider();
}
