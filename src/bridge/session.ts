/**
 * 会话模型 —— /new 的真正语义。
 *
 * 硬性要求：/new 必须「新建空白会话」，而不是只换路由表里的 id。
 * 实现方式：
 * - 桥接层：为该 chat 分配新的 sessionKey + 清除旧上下文 + 标记 fresh
 * - provider 层：resetSession() 杀掉底层进程/清空内存缓存（DSH 已实现）
 * - 下次消息必然走 freshSession=true → 全新空对话
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type SessionStatus = 'idle' | 'running' | 'interrupted' | 'error';

export interface Session {
  /** 会话唯一标识（每次 /new 都重新生成，绝不复用） */
  id: string;
  /** 飞书 chat_id（群/私聊） */
  chatId: string;
  /** 绑定的工作目录 */
  workdir: string;
  status: SessionStatus;
  /** 创建时间 / 最后活动时间 */
  createdAt: number;
  lastActiveAt: number;
  /** 上下文：桥接层记录的最近消息（供 CLI 型运行时回放） */
  context: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 该会话是否已被 /new 重置（下一条消息 fresh） */
  pendingFresh: boolean;
  /** 逻辑会话 id（状态栏显示用）：持久化、跨重启稳定，仅 /new 时重新生成（2026-08-31） */
  displayId?: string;
  /** usage 统计（实时缓存命中率/上下文） */
  usage: {
    /** 最近一轮请求的缓存命中 token */
    lastHit: number;
    /** 最近一轮请求的总输入 token（命中+未命中） */
    lastTotal: number;
    /** 累计命中 token */
    sumHit: number;
    /** 累计未命中 token */
    sumMiss: number;
    /** 请求次数 */
    requests: number;
    /** 累计输出 token */
    outputTokens: number;
  };
}

export interface SessionManagerOptions {
  /** 会话持久化文件（2026-08-31 重启保记忆）：设置后自动恢复+变更落盘 */
  persistFile?: string;
  defaultWorkdir: string;
  onSessionReset?: (chatId: string) => Promise<void>;
}

/** 会话注册表：chatId → Session（持久化到内存；重启后重新绑定） */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private opts: SessionManagerOptions;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
  }

  get(chatId: string): Session | undefined {
    return this.sessions.get(chatId);
  }

  /** 取或建会话：没有则用默认目录新建 */
  getOrCreate(chatId: string): Session {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      // 旧落盘会话无 displayId → 回填（跨重启保持不变）
      if (!existing.displayId) existing.displayId = existing.id;
      return existing;
    }
    const session: Session = {
      id: crypto.randomUUID(),
      chatId,
      workdir: this.opts.defaultWorkdir,
      status: 'idle',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      context: [],
      pendingFresh: false,
      usage: { lastHit: 0, lastTotal: 0, sumHit: 0, sumMiss: 0, requests: 0, outputTokens: 0 },
    };
    session.displayId = session.id; // 逻辑会话 id：随 persist 落盘，跨重启稳定，仅 /new 变
    this.sessions.set(chatId, session);
    return session;
  }

  /**
   * /new：真正新建空白会话。
   * - 生成全新 id + 清空上下文 + 标记 pendingFresh
   * - 回调 provider.resetSession() 杀底层进程
   */
  async reset(chatId: string): Promise<Session> {
    const session = this.getOrCreate(chatId);
    session.id = crypto.randomUUID();
    session.displayId = session.id; // /new = 新对话 → 状态栏 id 换新
    session.context = [];
    session.status = 'idle';
    session.usage = { lastHit: 0, lastTotal: 0, sumHit: 0, sumMiss: 0, requests: 0, outputTokens: 0 };
    session.pendingFresh = true;
    session.lastActiveAt = Date.now();
    if (this.opts.onSessionReset) {
      try { await this.opts.onSessionReset(chatId); } catch (e) {
        console.error(`[session] reset callback failed:`, e);
      }
    }
    return session;
  }

  /** 2026-08-31 重启保记忆：落盘全部会话（含 context 历史） */
  persist(): void {
    const file = this.opts.persistFile;
    if (!file) return;
    try {
      const data: Record<string, Session> = {};
      for (const [k, s] of this.sessions) data[k] = s;
      // 原子写：先写临时文件再 rename，防崩溃瞬间留下损坏 JSON（P2-1）
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('[session] persist failed:', e);
    }
  }

  /** 启动时恢复上次落盘的会话（含 context 历史） */
  restore(): void {
    const file = this.opts.persistFile;
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, Session>;
      let withCtx = 0;
      for (const [k, s] of Object.entries(data)) {
        // P0 修复：恢复的会话若有历史 context，标记 fresh——下次消息 fresh 注入 history 才生效
        if (Array.isArray(s.context) && s.context.length > 0) {
          s.pendingFresh = true;
          withCtx++;
        }
        this.sessions.set(k, s);
      }
      console.log(`[session] restored ${this.sessions.size} sessions from disk（${withCtx} 个带历史，已标记 fresh）`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[session] restore failed:', e);
    }
  }

    /** 消费 fresh 标记（取走并复位） */
  consumeFresh(session: Session): boolean {
    const fresh = session.pendingFresh;
    session.pendingFresh = false;
    return fresh;
  }

  /** /stop：中断当前任务 */
  async interrupt(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (session) {
      session.status = 'interrupted';
      session.lastActiveAt = Date.now();
    }
  }

  /** 记录一轮对话（context 最多保留 20 条） */
  appendContext(session: Session, userText: string, assistantText: string): void {
    session.context.push({ role: 'user', content: userText });
    session.context.push({ role: 'assistant', content: assistantText });
    if (session.context.length > 20) {
      session.context = session.context.slice(-20);
    }
  }

  /** 汇报 usage（流式事件里的 usage 累加） */
  recordUsage(
    session: Session,
    u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  ): void {
    // 未命中 = 非缓存输入 + 本次新写入缓存的量（后者通常才是大头）。
    // 现实背景（2026-08-29 实测）：henry-gao / Ark 等网关的 usage 里 input_tokens **恒为 0**，
    // 只报 cache_read_input_tokens 与 cache_creation_input_tokens。若 miss 只取 inputTokens，
    // /status 显示的命中率会恒等于 100%（纯属误导）。此处与 stats.ts recordStats 同口径。
    const hit = u.cacheReadTokens ?? 0;
    const miss = (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    // 本轮（覆盖式，代表最近一轮）
    session.usage.lastHit = hit;
    session.usage.lastTotal = hit + miss;
    // 累计（累加式）
    session.usage.sumHit += hit;
    session.usage.sumMiss += miss;
    session.usage.outputTokens += u.outputTokens ?? 0;
    session.usage.requests += 1;
  }

  /** 最近一轮缓存命中率（%） */
  lastCacheRate(session: Session): number {
    if (session.usage.lastTotal <= 0) return 0;
    return (session.usage.lastHit / session.usage.lastTotal) * 100;
  }

  /** 平均缓存命中率（%） */
  avgCacheRate(session: Session): number {
    const total = session.usage.sumHit + session.usage.sumMiss;
    if (total <= 0) return 0;
    return (session.usage.sumHit / total) * 100;
  }

  /** 全部会话（dashboard 用） */
  listAll(): Session[] {
    return [...this.sessions.values()];
  }

  /** 解析 /new 后绑定的目录：优先命令参数，其次默认目录 */
  resolveWorkdir(arg: string | undefined): string {
    if (!arg) return this.opts.defaultWorkdir;
    const abs = path.isAbsolute(arg) ? arg : path.join(this.opts.defaultWorkdir, arg);
    return abs;
  }
}
