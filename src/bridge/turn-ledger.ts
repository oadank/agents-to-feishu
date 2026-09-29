/**
 * 在途轮次台账（票 T-0021 · 2026-09-29 dsh）
 *
 * 【治什么】2026-09-29 真实事故：dsh 一把梭 `nssm restart` 12 家，正撞 mimo 从 13:47 起在跑的一轮
 * （老大亲派的 Motrix 下载活）。`prompt sent id=103` 之后 rt.log 15 分钟无事件 ≠ 它卡住了——
 * **桥不把工具事件写进 rt.log，FINAL 走的是 stdout（out.log）**，所以从 rt.log 看就是"没动静"。
 * 重启把引擎连那一轮一起杀掉 ⇒ 那一轮永久没有回包 ⇒ 老大的表象是"mimo 挂了"。
 * 锅不在代码 bug，在**重启前没人看一眼各家锅里还炖着东西没**。本模块就是那只眼睛。
 *
 * 【为什么落盘而不是查内存】engine.isBusy 是内存态，precheck 是**另一个进程**（重启前跑的脚本），
 * 读不到运行中进程的内存。所以桥在自己这一轮的开始/心跳/结束时，把状态镜像成 logs/<bot>-turn.json；
 * 真源仍是桥里的 markBeat/clear（成对出现在同一处代码），不是第二套判定逻辑。
 *
 * 【两个时间戳缺一不可】
 *   startedAt   —— 这一轮炖了多久（长任务 70min 也正常，别拿它当死信）
 *   lastBeatAt  —— 进程上次亲口确认"我还在跑这轮"是什么时候（心跳写盘）
 * 判据：心跳还新 = 真在干活 = 🔴 先别重启；心跳停了 = 进程已死/刚被杀 = 这是**上次留下的现场**，
 * 该读它做取证（正是"被打断时留个条"），但不拦重启。
 *
 * 【写失败绝不打断会话】台账是观测面，不是数据面：落盘异常只 console.warn，
 * 与 T-0019③ 的 fail-loud 分工不同——那边是"配置非法就别起来"，这边是"记录失败也不能拖累用户那条消息"。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 一轮在途轮次的镜像记录 */
export interface InflightTurn {
  chatId: string;
  mid: string;
  /** 正文摘要（截断，够看出"在干什么"即可，不落敏感长文） */
  preview: string;
  startedAt: number;
  lastBeatAt: number;
}

/** logs/<bot>-turn.json 的结构 */
export interface TurnFile {
  bot: string;
  pid: number;
  /** 本文件每次写入的时刻（进程活着且在跑轮次时由心跳推动） */
  updatedAt: number;
  turns: InflightTurn[];
}

/** 心跳周期：turn 期间每 60s 刷一次 lastBeatAt（远小于任何合理单轮时长，又不至于狂写盘） */
const BEAT_MS = 60_000;
/** preview 长度上限（字符）：够辨认任务内容即可 */
const PREVIEW_LEN = 80;

/** bot 名（与 CTI_BOT 同源；测试可注入覆盖） */
let botName = process.env.CTI_BOT || 'unknown';
/** 覆盖 bot 名（单测用） */
export function setTurnBotName(name: string): void { botName = name || 'unknown'; }
export function turnBotName(): string { return botName; }

/**
 * 台账目录 = 与 rt.log 同目录（logs/）。
 * CTI_RT_LOG 未设时回落 <repo>/logs（与 index.ts 里票 claude-2 的兜底同一口径，不另发明规则）。
 */
export function turnLogFile(rtLog: string | undefined = process.env.CTI_RT_LOG, bot: string = botName): string {
  const dir = rtLog ? path.dirname(rtLog) : path.resolve(process.cwd(), 'logs');
  return path.join(dir, `${bot}-turn.json`);
}

/** chatId → 在途记录（同一会话串行，理论上一条；并发多会话则各记一条） */
const inflight = new Map<string, InflightTurn>();
/** chatId → 心跳定时器 */
const beatTimers = new Map<string, NodeJS.Timeout>();

function snapshot(): TurnFile {
  const now = Date.now();
  return { bot: botName, pid: process.pid, updatedAt: now, turns: [...inflight.values()].map((t) => ({ ...t })) };
}

/** 落盘（原子写：先 .tmp 再 rename，避免 precheck 读到半截 JSON）。失败只 warn，绝不打断会话。 */
function flush(): void {
  const file = turnLogFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn(`[turn-ledger] 落盘失败（不影响本轮对话）: ${(e as Error).message}`);
  }
}

/**
 * 一轮开跑。幂等：同一 chat 重复调用只刷新（保留最早 startedAt，炖了多久要说实话）。
 * 心跳：turn 期间每 BEAT_MS 刷 lastBeatAt，证明"进程还活着且仍在跑这一轮"。
 */
export function markTurn(chatId: string, mid: string, text: string): void {
  const now = Date.now();
  const prev = inflight.get(chatId);
  inflight.set(chatId, {
    chatId,
    mid: mid || '',
    preview: (text || '').replace(/\s+/g, ' ').slice(0, PREVIEW_LEN),
    startedAt: prev ? prev.startedAt : now,
    lastBeatAt: now,
  });
  if (!beatTimers.has(chatId)) {
    const t = setInterval(() => {
      const cur = inflight.get(chatId);
      if (!cur) return; // 已被清理（理论到不了这里，双保险）
      cur.lastBeatAt = Date.now();
      flush();
    }, BEAT_MS);
    t.unref?.(); // 心跳定时器绝不能拖住进程退出
    beatTimers.set(chatId, t);
  }
  flush();
}

/** 一轮结束（正常收尾 / 异常 / 被取消都走这里）。 */
export function clearTurn(chatId: string): void {
  const had = inflight.delete(chatId);
  const timer = beatTimers.get(chatId);
  if (timer) { clearInterval(timer); beatTimers.delete(chatId); }
  if (had) flush();
}

/** 当前在途快照（内存态，供本进程自检/单测） */
export function inflightTurns(): InflightTurn[] {
  return [...inflight.values()].map((t) => ({ ...t }));
}

/** 读某家的台账（precheck 与启动取证共用）。文件缺失/畸形都返回 null，不抛。 */
export function readTurnFile(rtLog: string | undefined, bot: string): TurnFile | null {
  try {
    const file = turnLogFile(rtLog, bot);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TurnFile>;
    if (!raw || !Array.isArray(raw.turns)) return null;
    return {
      bot: raw.bot || bot,
      pid: typeof raw.pid === 'number' ? raw.pid : 0,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      turns: raw.turns.filter((t) => t && typeof t.chatId === 'string').map((t) => ({
        chatId: t.chatId,
        mid: t.mid || '',
        preview: t.preview || '',
        startedAt: typeof t.startedAt === 'number' ? t.startedAt : 0,
        lastBeatAt: typeof t.lastBeatAt === 'number' ? t.lastBeatAt : 0,
      })),
    };
  } catch {
    return null; // 台账读坏 = 当作没有，precheck 会另外点名"文件存在但解析失败"
  }
}

/** 判据口径（与 precheck 脚本共用同一函数，绝不在脚本里另写一套阈值） */
export interface TurnVerdict {
  state: 'idle' | 'running' | 'stale-leftover';
  /** 最长的一轮炖了多久（ms） */
  oldestMs: number;
  /** 心跳停了多久（ms）；running 判据用它 */
  beatAgoMs: number;
  turns: InflightTurn[];
}

/**
 * 心跳新鲜阈值：超过 2 个心跳周期 + 余量（3min）没刷新 = 这进程不再确认自己在跑。
 * 宁可略宽（Node 事件循环被长工具阻塞时心跳定时器可能延后），也别误报"空闲"。
 */
export const BEAT_FRESH_MS = 3 * 60_000;

/** 把一家台账判成三种状态之一（纯函数，单测直接打） */
export function judgeTurns(f: TurnFile | null, now: number, turnStaleMs: number): TurnVerdict {
  if (!f || f.turns.length === 0) return { state: 'idle', oldestMs: 0, beatAgoMs: 0, turns: [] };
  const oldest = Math.min(...f.turns.map((t) => t.startedAt));
  const newestBeat = Math.max(...f.turns.map((t) => t.lastBeatAt));
  const oldestMs = now - oldest;
  const beatAgoMs = now - newestBeat;
  if (beatAgoMs <= BEAT_FRESH_MS) return { state: 'running', oldestMs, beatAgoMs, turns: f.turns };
  // 心跳停了：要么进程死了，要么被杀了。超过信任期就不再当"新鲜现场"刷屏提醒。
  if (oldestMs > turnStaleMs) return { state: 'stale-leftover', oldestMs, beatAgoMs, turns: f.turns };
  return { state: 'stale-leftover', oldestMs, beatAgoMs, turns: f.turns };
}

/** 单测复位（清内存态 + 停心跳，不碰磁盘） */
export function resetTurnLedger(): void {
  for (const t of beatTimers.values()) clearInterval(t);
  beatTimers.clear();
  inflight.clear();
}
