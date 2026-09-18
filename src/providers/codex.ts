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

/**
 * [绕过·非修复] 桥接直调 openmem MCP（streamable-http :3466）。
 * codex 模型侧 mcp__openmem__* 路由 unsupported call 未修通前的兜底。
 */
async function callOpenmemBypass(userText: string): Promise<string> {
  const url = process.env.CTI_OPENMEM_MCP_URL || 'http://127.0.0.1:3466/mcp';
  const q = (userText.replace(/\s+/g, ' ').trim()).slice(0, 200) || 'openmem 接入';
  const preferTool = /mh_tool|成品答案|偏好|服务与端口|花名册/i.test(userText) ? 'mh_tool'
    : /mh_tools_list/i.test(userText) ? 'mh_tools_list'
    : /mh_status/i.test(userText) ? 'mh_status'
    : 'mh_search';
  const args: JsonRecord = preferTool === 'mh_search'
    ? { query: q, top_k: 3 }
    : preferTool === 'mh_tool'
      ? { name: /GitHub|github/i.test(userText) ? 'GitHub 访问通道' : /端口|服务/i.test(userText) ? '老大的服务与端口' : 'agent 花名册' }
      : {};
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: preferTool, arguments: args },
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    // streamable-http 可能是 SSE：取 data: 行
    let payload = text;
    if (text.includes('data:')) {
      payload = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    }
    try {
      const j = JSON.parse(payload) as JsonRecord;
      const result = j.result as JsonRecord | undefined;
      const content = (result?.content as Array<{ text?: string }> | undefined) || [];
      const joined = content.map((c) => c.text || '').join('\n').trim();
      return (joined || payload).slice(0, 4000);
    } catch {
      return payload.slice(0, 4000);
    }
  } catch (e) {
    return `openmem 桥接代调失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export class CodexProvider implements RuntimeProvider {
  readonly name = 'codex';

  private client: CodexAppServerClient | null = null;
  /** [2026-09-02] 会话线程映射：sessionKey → codex threadId，实现跨消息真连续（thread/resume）。 */
  private threadIds = new Map<string, string>();

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

  async resetSession(sessionKey?: string): Promise<void> {
    // [2026-09-02] /new 时 bridge 会调这里（带 key）并标 freshSession：双保险丢弃旧线程映射，
    // 下一条消息 thread/start 开全新对话。清空 key 对应映射即可，其他会话不受影响。
    if (sessionKey) this.threadIds.delete(sessionKey);
    else this.threadIds.clear();
    rtLog(`[codex] resetSession: thread mapping cleared (key=${sessionKey ? 'yes' : 'all'})`);
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

    // [2026-09-02] 线程连续性：同一飞书会话复用同一 codex thread（thread/resume，
    // 原生全量上下文=真记忆）；/new（freshSession）丢弃旧线程开新对话；
    // resume 失败回退 thread/start + history 注入（保底，与 claude.ts 同款）。
    const sessionKey = params.sessionKey || '';
    if (params.freshSession) this.threadIds.delete(sessionKey);
    const prevThreadId = this.threadIds.get(sessionKey);
    let threadId = '';
    let resumed = false;
    if (prevThreadId) {
      try {
        const r = await client.call<{ thread?: { id?: string } }>('thread/resume', {
          experimentalRawEvents: true,
          persistExtendedHistory: true,
          cwd: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
          threadId: prevThreadId,
        });
        threadId = String((r as any)?.thread?.id || '') || prevThreadId;
        resumed = true;
      } catch (e) {
        rtLog(`[codex] thread/resume failed, fallback to start: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
        threadId = '';
      }
    }
    if (!threadId) {
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
    }
    // 简单防膨胀：映射超过 64 个会话时整体清空（丢失的只是续聊能力，可自愈重建）
    if (this.threadIds.size > 64) this.threadIds.clear();
    this.threadIds.set(sessionKey, threadId);
    rtLog(`[codex] thread ${resumed ? 'resumed' : 'created'}: ${threadId.slice(0, 8)} (session=${sessionKey.slice(0, 12)})`);

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
        // [2026-09-17 修复 codex 0.154 协议适配] 工具调用改走 item/started + item/completed：
        // item.type=commandExecution（键含 command/cwd/status/aggregatedOutput）。
        // 旧代码只认 item/toolCall/outputDelta（4 个变体），0.154 已不再发 → 工具块从卡片消失。
        // 注意：item/commandExecution/outputDelta 是「输出增量」且不带 item，不能当工具事件用（会刷屏）。
        case 'item/started':
        case 'item/completed': {
          const item = itemParams.item as JsonRecord | undefined;
          if (!item) break;
          const itype = String(item.type ?? '');
          if (!/commandExecution|mcpToolCall|toolCall|exec/i.test(itype)) break;
          const statusStr = String(item.status ?? '');
          const failed = /failed|error/i.test(statusStr);
          const done = message.method === 'item/completed' || /completed|success/i.test(statusStr);
          const cmd = String(item.command ?? '');
          queue.push({
            type: 'tool',
            tool: cmd ? cmd.slice(0, 60) : (String(item.name ?? itype) || 'tool'),
            status: failed ? 'error' : done ? 'done' : 'running',
            input: (cmd || JSON.stringify(item.arguments ?? '')).slice(0, 220),
          });
          poke();
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
    // [2026-09-01] 跨消息记忆修复：codex provider 此前每条消息 thread/start 新线程
    // 且无视 params.history，导致 bot 完全没有跨消息记忆（对齐 claude.ts 的
    // historyText 注入格式）。fresh 会话时把 bridge 存的会话上下文拼进 prompt。
    const historyText = params.freshSession && params.history && params.history.length > 0
      ? params.history.map((m) => `[${m.role === 'user' ? '用户' : '助手'}]\n${m.content}`).join('\n\n')
      : '';
    // [绕过·非修复 2026-09-18 缺口B] codex→LiteLLM→qwen 展平后模型可见 mcp__openmem__*，
    // 但 codex router 仍报 unsupported call（回程 namespace/name 未对齐）。在修通前：
    // 桥接代调 openmem，把结果注入本轮 prompt；人设/闸门同时写明 curl 兜底。
    let bridgeOpenmem = '';
    if (/mh_(search|tool|tools_list|ask|status|get|write)|openmem|统一记忆|查记忆/i.test(params.text || '')) {
      bridgeOpenmem = await callOpenmemBypass(params.text || '');
    }
    const promptParts: string[] = [];
    if (params.systemPrompt) {
      promptParts.push(
        params.systemPrompt +
        '\n\n【openmem 使用 · 这是绕过不是修复】\n' +
        '本会话模型侧 MCP 工具可能报 unsupported call。记忆一律优先用下方桥接代调结果；' +
        '若下方为空且你需要查 openmem，用 shell 调：' +
        'POST http://127.0.0.1:3466/mcp body={"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mh_search","arguments":{"query":"..."}}}（Accept: application/json, text/event-stream）。\n' +
        '协议层也可用 app-server mcpServer/tool/call(server=openmem, tool=mh_search)。'
      );
    }
    if (historyText) promptParts.push(historyText);
    if (bridgeOpenmem) {
      promptParts.push(
        '【桥接代调 openmem · 这是绕过不是修复】\n' +
        '下列内容由桥接直接调用 openmem MCP 得到，可直接引用，不要再假装调用 mh_*：\n' +
        bridgeOpenmem
      );
    }
    promptParts.push(params.text);
    const fullPrompt = promptParts.join('\n\n---\n\n');
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
