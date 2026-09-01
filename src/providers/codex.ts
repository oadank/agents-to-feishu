/**
 * Codex Provider — 通过 CodexAppServerClient 接入 Codex CLI ACP（thread/turn/item 协议）。
 *
 * 协议：thread/new → turn/start → item 事件流（item/agentMessage/delta 等）→ turn/completed。
 * 由 agents-to-feishu 统一管理人设/记忆/模型。
 */

import fs from 'node:fs';
import { CodexAppServerClient, type CodexServerMessage } from './codex/codex-app-server-client.js';
import type { RuntimeProvider, StreamChatParams, StreamEvent, UsageInfo } from './types.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

type JsonRecord = Record<string, unknown>;

export class CodexProvider implements RuntimeProvider {
  readonly name = 'codex';

  private client: CodexAppServerClient | null = null;

  private async ensureClient(): Promise<CodexAppServerClient> {
    if (!this.client) {
      const c = new CodexAppServerClient();
      await c.prepare();
      this.client = c;
    } else {
      await this.client.prepare();
    }
    return this.client;
  }

  async prepare(): Promise<void> {
    try { await this.ensureClient(); } catch (e) {
      console.warn(`[codex] prepare failed:`, e);
    }
  }

  async resetSession(_key?: string): Promise<void> {
    rtLog(`[codex] resetSession called`);
  }

  async interrupt(): Promise<void> {
    rtLog(`[codex] interrupt: 由 app-server 管理，尽力取消`);
  }

  async dispose(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    const client = await this.ensureClient();
    let unsubscribe: (() => void) | null = null;

    const queue: StreamEvent[] = [];
    let settled = false;
    let doneErr: string | null = null;
    let wakeup: () => void = () => {};
    let wakeupP: Promise<void> = Promise.resolve();
    const poke = (): void => { wakeup(); };
    let settleResolve: () => void = () => {};
    const settledP = new Promise<void>((r) => { settleResolve = r; });

    // 创建 thread（codex 协议用 thread/start）
    let threadId: string;
    try {
      const thread = await client.call<{ thread?: { id?: string } }>('thread/start', {
        experimentalRawEvents: true,
        persistExtendedHistory: true,
        cwd: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
      });
      threadId = String((thread as any)?.thread?.id || '');
      if (!threadId) { throw new Error('thread/start: missing thread id'); }
    } catch (e) {
      yield { type: 'error', message: `Codex thread/start 失败: ${e instanceof Error ? e.message : String(e)}` };
      yield { type: 'done' };
      return;
    }
    rtLog(`[codex] thread created: ${threadId.slice(0, 8)}`);

    // 订阅 → push 事件
    unsubscribe = client.subscribe((message) => {
      // 只处理本 thread 的事件
      const itemParams = (typeof message.params === 'object' && message.params ? message.params as JsonRecord : {});
      const tId = extractThreadId(message);
      if (tId && tId !== threadId) return;
      if (message.kind === 'request') {
        // server request：当前最小实现不处理，其余忽略
        return;
      }

      switch (message.method) {
        case 'item/agentMessage/delta': {
          const d = itemParams.delta;
          if (typeof d === 'string' && d) { queue.push({ type: 'text', text: d }); poke(); }
          break;
        }
        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta': {
          const d = itemParams.delta;
          if (typeof d === 'string' && d) { queue.push({ type: 'thinking', text: d }); poke(); }
          break;
        }
        case 'thread/tokenUsage/updated': {
          const u = (itemParams.tokenUsage as JsonRecord | undefined)?.last as JsonRecord | undefined;
          if (u) {
            const usage: UsageInfo = {
              inputTokens: Number(u.inputTokens ?? u.input_tokens ?? 0),
              outputTokens: Number(u.outputTokens ?? u.output_tokens ?? 0),
              cacheReadTokens: Number(u.cachedInputTokens ?? u.cache_read_input_tokens ?? 0),
            };
            queue.push({ type: 'usage', usage, sessionId: threadId });
            poke();
          }
          break;
        }
        case 'item/toolCall/outputDelta':
        case 'item/tool_call/output_delta':
        case 'item/toolCall/output_delta':
        case 'item/tool_call/outputDelta': {
          const item = itemParams.item as JsonRecord | undefined;
          const status = String((item as JsonRecord | undefined)?.status || 'running');
          queue.push({
            type: 'tool',
            tool: String((item as JsonRecord | undefined)?.name || 'tool'),
            status: status === 'failed' || status === 'error' ? 'error' : status === 'completed' ? 'done' : 'running',
            input: JSON.stringify((item as JsonRecord | undefined)?.args ?? '').slice(0, 220),
          });
          poke();
          break;
        }
        case 'error': {
          doneErr = String((itemParams.error as JsonRecord | undefined)?.message || 'Codex 出错');
          break;
        }
        case 'turn/completed': {
          settled = true;
          settleResolve();
          break;
        }
        case 'thread/completed':
        case 'turn/interrupted': {
          settled = true;
          settleResolve();
          break;
        }
        default:
          break;
      }
    });

    // 发送 turn（codex 的 input 是消息序列）
    const fullPrompt = params.systemPrompt
      ? `${params.systemPrompt}\n\n${params.text}`
      : params.text;
    try {
      await client.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: fullPrompt }],
        ...(process.env.CTI_DEFAULT_WORKDIR ? { cwd: process.env.CTI_DEFAULT_WORKDIR } : {}),
      });
    } catch (e) {
      doneErr = `Codex turn/start 失败: ${e instanceof Error ? e.message : String(e)}`;
      settled = true;
      settleResolve();
    }
    rtLog(`[codex] turn started thread=${threadId.slice(0, 8)}`);

    // 消费队列
    try {
      while (true) {
        if (queue.length > 0) { yield queue.shift()!; continue; }
        if (settled) break;
        wakeupP = new Promise<void>((r) => { wakeup = r; });
        if (queue.length > 0 || settled) continue;
        await Promise.race([settledP, wakeupP]);
      }
    } finally {
      unsubscribe?.();
      if (doneErr) yield { type: 'error', message: doneErr };
      yield { type: 'done' };
    }
  }
}

function extractThreadId(msg: CodexServerMessage): string {
  const params = typeof msg.params === 'object' && msg.params ? msg.params as JsonRecord : {};
  const t = params.threadId ?? (params.thread as JsonRecord | undefined)?.id;
  return typeof t === 'string' ? t : '';
}

export function createCodexProvider(): CodexProvider {
  return new CodexProvider();
}
