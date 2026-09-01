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
import type { RuntimeProvider, StreamChatParams, StreamEvent, UsageInfo } from './types.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

type JsonRecord = Record<string, unknown>;

function extractSessionId(msg: HermesServerMessage): string {
  const params = typeof msg.params === 'object' && msg.params ? msg.params as JsonRecord : {};
  return typeof params.sessionId === 'string' ? params.sessionId : '';
}

export class HermesProvider implements RuntimeProvider {
  readonly name = 'hermes';

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

  async resetSession(_sessionKey?: string): Promise<void> {
    // hermes 每次 streamChat 都新建 session（app-server 模式），无需缓存清理
    rtLog(`[hermes] resetSession called`);
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
    const sessionIdPromise: Promise<string> = (async () => {
      // 2026-08-30 修复：session/new 也挂起过（app-server 无响应）——120s 超时护栏
      const newSession = await Promise.race([
        client.call<{ sessionId: string; models?: { currentModelId?: string } }>('session/new', {
        cwd: params.sessionKey ? process.env.CTI_DEFAULT_WORKDIR || process.cwd() : process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
        mcpServers: [], // 必传：hermes ACP 强制要求该字段（去掉会报 Invalid params）；与老项目 hermes-provider.ts:204 一致
        }),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('session/new 超时 120s（app-server 无响应）')),
          120_000,
        )),
      ]);
      return newSession.sessionId;
    })();

    let sessionId: string;
    try { sessionId = await sessionIdPromise; }
    catch (e) {
      yield { type: 'error', message: `Hermes session/new 失败: ${e instanceof Error ? e.message : String(e)}` };
      yield { type: 'done' };
      return;
    }
    rtLog(`[hermes] session created: ${sessionId.slice(0, 8)}`);

    // 首条消息注入人设
    let fullPrompt = params.text;
    if (params.systemPrompt) {
      fullPrompt = `${params.systemPrompt}\n\n${params.text}`;
    }

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
                if (thinkingText) { queue.push({ type: 'thinking', text: thinkingText }); }
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
          if (typeof text === 'string') { queue.push({ type: 'thinking', text }); poke(); }
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
