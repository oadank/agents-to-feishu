/**
 * DeepTutor Provider — HTTP/WS 接入 DeepTutor 常驻服务（默认 127.0.0.1:8001）。
 *
 * [2026-09-03] 老大拍板：走"陈丹的飞书 CLI"自建应用（cli_aad3d4bbaaf8dbb3）接入。
 *
 * 与其他 provider 的本质区别：**无子进程**。DeepTutor 本身是常驻 HTTP/WS 服务，
 * 这里每轮开一条短 WS 连接发 start_turn（protocol 2.0），收完 done 即关——
 * 无 ACP/CLI 的进程管理、环境隔离、LRU 回收问题。
 *
 * 默认值（老大定的，每轮显式带，不依赖会话状态）：
 *   - persona = 暴躁老青鱼（CTI_DEEPTUTOR_PERSONA 可覆盖）
 *   - capability = chat（聊天模式）
 *   - knowledge_bases = 全部（启动/定期拉 /api/knowledge-bases，缓存 10 分钟）
 *
 * 会话映射：sessionKey（飞书 chatId）→ DeepTutor session_id，落盘
 *   CTI_HOME/runtime/deeptutor-sessions.json。/new 由桥接调 resetSession 删除。
 *
 * 事件映射（DeepTutor protocol 2.0 → StreamEvent）：
 *   content      → text
 *   tool_call    → tool(running)
 *   tool_result  → tool(done)
 *   sources      → audio artifact（语音契约产物）→ 下载 mp3 → sha256 → 写入 dsh
 *                  内容寻址对象池（DSH_HOME/attachments/v1/objects/）→ 合成 tool
 *                  事件 output 带 `voiceId: sha256:<hex>` → engine 现有钩子零改动
 *                  投递飞书语音（sendVoiceObjectById）
 *   error        → error（必须透传，禁止静默卡住）
 *   done         → 收尾
 *
 * 语音闭环：飞书语音 → 桥接 ASR 转写（index.ts 传 attachments audio.text）→
 *   本 provider 拼 `[语音消息] <转写>` 作 content → DeepTutor 语音契约自动回语音。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type {
  RuntimeProvider,
  StreamChatParams,
  StreamEvent,
  UsageInfo,
} from './types.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

const HTTP_BASE = (process.env.CTI_DEEPTUTOR_BASE || 'http://127.0.0.1:8001').replace(/\/$/, '');
const WS_BASE = HTTP_BASE.replace(/^http/, 'ws') + '/ws';
const PERSONA = process.env.CTI_DEEPTUTOR_PERSONA || '暴躁老青鱼';
const KB_REFRESH_MS = 10 * 60 * 1000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000; // 单轮保护上限（DeepTutor 自身有租约看门狗）
const PROTOCOL = '2.0';

function homeDir(): string {
  return process.env.CTI_USER_HOME || os.homedir();
}

function ctiHome(): string {
  return process.env.CTI_HOME || path.join(homeDir(), '.agents-to-feishu');
}

/** chatId → DeepTutor session_id 持久化 */
class SessionMap {
  private map = new Map<string, string>();
  private file = path.join(ctiHome(), 'runtime', 'deeptutor-sessions.json');

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch { /* 首次/损坏 → 空表 */ }
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, sessionId: string): void {
    this.map.set(key, sessionId);
    this.flush();
  }

  delete(key: string): void {
    if (this.map.delete(key)) this.flush();
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2), 'utf-8');
    } catch (e) {
      // [2026-09-03] 落盘失败必须可见（rtLog 受 CTI_RT_LOG 开关，nssm 日志兜底）：
      // 映射丢了 restart 后 start_turn 不带 session_id → DeepTutor 新建会话丢上下文。
      console.warn(`[deeptutor] session 映射落盘失败: ${e instanceof Error ? e.message : String(e)}`);
      rtLog(`deeptutor session map flush failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

interface DsAttachment {
  type: string;
  url?: string;
  base64?: string;
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  transcript?: string;
}

export function createDeeptutorProvider(): RuntimeProvider {
  const sessions = new SessionMap();
  let kbCache: { ids: string[]; at: number } | null = null;
  let activeTurn: { ws: WebSocket; turnId: string; sessionId: string } | null = null;

  async function fetchKbIds(): Promise<string[]> {
    if (kbCache && Date.now() - kbCache.at < KB_REFRESH_MS) return kbCache.ids;
    try {
      const r = await fetch(`${HTTP_BASE}/api/knowledge-bases`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = (await r.json()) as Array<{ id?: string; name?: string }>;
      const ids = (Array.isArray(list) ? list : [])
        .map((kb) => String(kb.id || ''))
        .filter(Boolean);
      if (ids.length) {
        kbCache = { ids, at: Date.now() };
        rtLog(`deeptutor KB 刷新: ${ids.length} 个`);
        return ids;
      }
    } catch (e) {
      rtLog(`deeptutor KB 拉取失败（本轮不带 KB）: ${e instanceof Error ? e.message : String(e)}`);
    }
    return kbCache?.ids ?? [];
  }

  async function *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    // ── 组装 content：语音转写带 [语音消息] 前缀（触发 DeepTutor 语音契约）──
    // [2026-09-03 修] engine 传的 audio 标记 text 为空串（存在即语义），旧条件
    // `a.text` truthy 永远匹配不上 → 语音消息被 DeepTutor 当普通文字（实测）。
    let content = params.text || '';
    const isVoiceInput = (params.attachments ?? []).some((a) => a.type === 'audio');
    if (isVoiceInput && content && !content.startsWith('[语音消息]')) {
      content = `[语音消息] ${content}`;
    }

    // ── 会话映射 ──
    // [2026-09-03 修] 忽略 freshSession：SessionManager 把"重启后首条"也标记 fresh
    // （为无状态 CLI 注入 history 用），但 DeepTutor 是服务端有状态会话——restart
    // 后必须继续原 session（映射还在磁盘上），否则 DeepTutor 新建会话 = 丢上下文
    // （实测每次 bot 重启都断一次）。/new 的真重置走 onSessionReset → resetSession
    // （已删映射），不经过这个参数，所以 /new 语义不受影响。
    const sessionId0 = sessions.get(params.sessionKey);
    let sessionId: string | undefined = sessionId0;

    // [2026-09-03 修] 会话分支链：不带 parent_message_id 时 DeepTutor 把每轮 user
    // 消息挂在会话根 → 每轮成一条平行分支 → 网页端打开只显示最新分支，"之前的
    // 对话全没了"（实测）。这里取会话末条消息 id 作为本轮 parent，把分支串成线。
    let parentMessageId: number | undefined;
    if (sessionId) {
      try {
        const r = await fetch(`${HTTP_BASE}/api/sessions/${sessionId}`);
        if (r.ok) {
          const data = (await r.json()) as { messages?: Array<{ id?: number }> };
          const msgs = data.messages ?? [];
          const lastId = msgs.length ? Number(msgs[msgs.length - 1].id) : NaN;
          if (Number.isFinite(lastId) && lastId > 0) parentMessageId = lastId;
        }
      } catch (e) {
        rtLog(`deeptutor parent 链取取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const kbIds = await fetchKbIds();
    const startMsg: Record<string, unknown> = {
      type: 'start_turn',
      protocol_version: PROTOCOL,
      content,
      capability: 'chat',
      language: 'zh',
      persona: PERSONA,
      ...(kbIds.length ? { knowledge_bases: kbIds } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(parentMessageId ? { parent_message_id: parentMessageId } : {}),
    };

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(WS_BASE, { handshakeTimeout: 15_000 });
      sock.once('open', () => resolve(sock));
      sock.once('error', (err) => reject(new Error(`DeepTutor WS 连接失败: ${err.message}`)));
    });

    let turnId = '';
    let done = false;
    const eventQueue: StreamEvent[] = [];
    let wake: (() => void) | null = null;

    const push = (ev: StreamEvent) => {
      eventQueue.push(ev);
      wake?.();
      wake = null;
    };

    const nextEvent = async (): Promise<StreamEvent | null> => {
      for (;;) {
        if (eventQueue.length) return eventQueue.shift()!;
        if (done) return null;
        await new Promise<void>((r) => { wake = r; });
      }
    };

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const type = String(msg.type ?? '');
      const meta = (msg.metadata ?? {}) as Record<string, unknown>;

      // [2026-09-03 修] session_id 双保险抓取：每一帧顶层都带 session_id，不再只认
      // session 事件——实测首轮 session 事件分支有概率漏抓（原因未定），restart 后
      // 映射为空 → start_turn 不带 session_id → DeepTutor 新建会话，用户感知"丢上下文"。
      const frameSid = typeof msg.session_id === 'string' ? msg.session_id : '';
      if (frameSid && frameSid !== sessionId) {
        sessionId = frameSid;
        sessions.set(params.sessionKey, frameSid);
      }
      const frameTurnId = typeof msg.turn_id === 'string' ? msg.turn_id : '';
      if (frameTurnId && !turnId) {
        turnId = frameTurnId;
        if (sessionId) activeTurn = { ws, turnId, sessionId };
      }
      if (type === 'content' && typeof msg.content === 'string' && msg.content) {
        push({ type: 'text', text: msg.content });
        return;
      }
      if (type === 'tool_call' || type === 'tool_result') {
        // [2026-09-03] 工具卡全量透传——"暴露工具"是老大给桥接专门做的功能，
        // 内部工具调用（tts_speak 等）也照常显示。
        const toolName = String(meta.tool_name ?? meta.tool ?? msg.content ?? '');
        push({
          type: 'tool',
          tool: toolName || 'tool',
          status: type === 'tool_call' ? 'running' : 'done',
        });
        return;
      }
      if (type === 'sources') {
        const sources = (meta.sources ?? []) as DsAttachment[];
        for (const s of sources) {
          if (s.type !== 'artifact' || !s.url) continue;
          const mime = String(s.mime_type ?? '');
          if (mime.startsWith('audio/')) {
            // [2026-09-03 改] 老大拍板：飞书语音音色走控制中心统一管理。DeepTutor
            // 只产出口语稿（artifact.transcript，AI 自写的口语版），本 provider 把
            // 口语稿以 voice_reply 事件交桥接 → engine.sendVoiceReply 用控制中心
            // TTS 合成发声。不再下载 mp3 入 dsh 对象池（那是 dsh 音色路线）。
            const spoken = String(s.transcript ?? '').trim();
            if (spoken) push({ type: 'voice_reply', text: spoken });
          } else if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('application/')) {
            // [2026-09-03] 图片/视频/文件成品兜底：不依赖模型"知道要发"，代码自动
            // 投递飞书（engine 收尾下载→上传→发消息）。url 升级为完整地址。
            const filename = String(s.filename ?? 'file');
            push({
              type: 'media_send',
              url: `${HTTP_BASE}${s.url}`,
              mime_type: mime,
              filename,
            });
          }
        }
        return;
      }
      if (type === 'error') {
        push({ type: 'error', message: String(msg.content ?? 'DeepTutor 错误') });
        return;
      }
      if (type === 'done' || msg.status === 'completed' || msg.status === 'failed' || msg.status === 'cancelled') {
        const st = String(msg.status ?? (type === 'done' ? 'completed' : ''));
        if (st === 'failed') push({ type: 'error', message: String((meta as { error?: string }).error ?? '本轮执行失败') });
        done = true;
        wake?.();
        wake = null;
        return;
      }
      // 其余事件（stage_start/progress/thinking/result…）桥接层不需要，静默丢弃
    });

    ws.once('close', () => { done = true; wake?.(); wake = null; });
    ws.once('error', (err: Error) => {
      push({ type: 'error', message: `DeepTutor WS 错误: ${err.message}` });
      done = true;
      wake?.();
      wake = null;
    });

    ws.send(JSON.stringify(startMsg));

    const deadline = Date.now() + TURN_TIMEOUT_MS;
    try {
      for (;;) {
        if (Date.now() > deadline) {
          yield { type: 'error', message: 'DeepTutor 本轮超时（10 分钟保护）' };
          break;
        }
        const ev = await nextEvent();
        if (!ev) break;
        yield ev;
        if (ev.type === 'error') {
          // 错误后仍等 done（可能还有收尾事件），但防卡：错误即给一次机会后强收
          const tail = await Promise.race([nextEvent(), new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
          if (tail) yield tail;
          break;
        }
      }
      yield { type: 'done' };
    } finally {
      activeTurn = activeTurn && activeTurn.ws === ws ? null : activeTurn;
      try { ws.close(); } catch { /* 忽略 */ }
    }
  }

  return {
    name: 'deeptutor',

    async prepare(): Promise<void> {
      // 自检：DeepTutor 后端可达 + 飞书凭证之外的核心依赖就绪
      const r = await fetch(`${HTTP_BASE}/docs`);
      if (!r.ok) throw new Error(`DeepTutor 后端不可达: ${HTTP_BASE} HTTP ${r.status}`);
      rtLog('deeptutor provider 就绪');
    },

    streamChat,

    async resetSession(sessionKey?: string): Promise<void> {
      // /new：桥接按 chatId 调用；全清场景（极少）由桥接逐 chat 触发
      if (sessionKey) sessions.delete(sessionKey);
    },

    async interrupt(): Promise<void> {
      const at = activeTurn;
      if (!at) return;
      try {
        at.ws.send(JSON.stringify({
          type: 'cancel_turn',
          command_id: `cli-${Date.now()}`,
          turn_id: at.turnId,
        }));
        rtLog(`deeptutor interrupt 已发: turn=${at.turnId}`);
      } catch (e) {
        rtLog(`deeptutor interrupt 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    dispose(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** usage 兼容（DeepTutor result 事件带 cost_summary，桥接层可选展示） */
export type { UsageInfo };
