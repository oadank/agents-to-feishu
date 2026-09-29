/**
 * 自我回声抑制（票 T-0019① · 2026-09-29 dsh · 抄 agent-mailbox 的 self-echo 语义）
 *
 * 【治什么】七家 bot 互刷"收到/好的"那场回执风暴。
 * 老规矩是靠嘴叮嘱（团队铁律第 1 条"别手工回执"），可模型不听话就照刷 —— 因为它**被叫醒**了就会回一句。
 * 本模块把纪律挪到门上：桥先认出来"这句只是回音、不是新事"，就**不叫醒引擎**，只在日志/台账留痕。
 *
 * 【怎么认出回声（全部是物理痕迹，不猜内容）】
 *   1) 没有 `(from-bot:X)` 尾注 ⇒ 判定为老大本人/人类 ⇒ **永不吞**（人类消息永远不拦，团队铁律）。
 *      bot 发的一律由 lark-tools 强制盖尾注（to 分支 + target_id 分支都盖，0920 后门盖戳票）。
 *   2) X === 本进程 CTI_BOT ⇒ 自己写给自己的门铃 ⇒ 吞（掐自环根）。
 *   3) 正文剥掉标记后只是一句纯确认（≤30 字且命中 ACK 词表）⇒ 吞 —— 这就是互刷的原子单位。
 *   4) 同一内容在窗口内第二次出现（归一化指纹）⇒ 吞 —— 回执原路弹回、重复投递都落这条。
 *   其余（带任务号、带结论、有一定长度的真交付）⇒ 放行：**发起方必须收到结果**，宁放勿吞。
 *
 * 【三档 CTI_ECHO_MODE】enforce=真吞（出厂）｜shadow=只记账不吞（灰度观察）｜off=完全停用。
 * 另有 CTI_ECHO_WAKE=1：判为回声但仍叫醒引擎，只在正文前打 `[回声]` 标记 —— 对齐 agent-mailbox
 * "opt-in 时给通知主题加 [echo] 前缀分清回声与真信"，用于排查"是不是误杀了真消息"。
 */
import { createHash } from 'node:crypto';
import type { Windows } from './windows.js';

/** `(from-bot:X · …)` 尾注解析（与 index.ts 现有口径同一个正则族） */
export function parseFromBot(text: string): string | null {
  const m = /\(from-bot:([a-zA-Z0-9_-]+)/.exec(text);
  return m && m[1] ? m[1] : null;
}

/** 剥掉链路标记与排版噪声，得到可比对的正文 */
export function normalizeBody(text: string): string {
  return text
    .replace(/\(from-bot:[^)]*\)/g, ' ')
    .replace(/（自动回执）/g, ' ')
    .replace(/^\s*\[[^\]\n]{1,24}\]\s*/, ' ')
    .replace(/[*_`>#]/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 归一化指纹（sha1 前 16 位，够判重、不进日志全文） */
export function fingerprint(text: string): string {
  return createHash('sha1').update(normalizeBody(text)).digest('hex').slice(0, 16);
}

/** 纯确认词表：命中即"这句没有信息量"。长度上限另判（见 classifyEcho）。 */
const ACK_WORD =
  '^(?:收到|好的|好嘞|好滴|好|嗯+|嗯哈|明白|明白了|了解|知道了|知道|行|没问题|OK|ok|Ok|okay|okk+|已收到|已处理|已完成|完成|辛苦|辛苦了|谢谢|感谢|thanks|Thanks|thx|👍|👌|✓|✅)$';
const ACK_TOKEN = new RegExp(ACK_WORD);
const ACK_PUNCT = /^[。.!！~～、，,;；:：\s]*$/;

/** 正文是否为"一串纯确认词"（只隔空白/标点，最多 4 段）。
 *  🔴 切分必须把标点当分隔符剥掉：实测 "收到，收到" 若按标点前后切会留下带逗号的残片而判否，
 *  于是"连点两次头"这种最常见的互刷形态漏网（0929 回归实拍）。 */
export function isAckOnly(body: string): boolean {
  if (body.length > 30) return false; // 有一点长度的话就不是纯点头，放行
  const toks = body.split(/[\s。.!！~～、，,;；:：]+/).filter((t) => t !== '');
  if (toks.length === 0 || toks.length > 4) return false;
  return toks.every((t) => ACK_TOKEN.test(t));
}

export interface EchoVerdict {
  suppress: boolean;
  reason: string;
  fromBot: string | null;
  fp: string;
  mode: Windows['echoMode'];
}

const PASS = (reason: string, v: Omit<EchoVerdict, 'suppress' | 'reason'>): EchoVerdict => ({ suppress: false, reason, ...v });

export interface EchoInput {
  /** 消息原文（未剥标记） */
  text: string;
  /** 本进程 bot 名（process.env.CTI_BOT） */
  me: string;
  /** 指纹表：命中判重要用，放行时登记（同一张表跨调用活着） */
  seen?: Map<string, number>;
  /** 当前时间（可注入便于单测） */
  now?: number;
}

let stats = { enforce: 0, shadow: 0, wake: 0, pass: 0 };

export function echoStats(): typeof stats & { total: number } {
  return { ...stats, total: stats.enforce + stats.shadow + stats.wake + stats.pass };
}
export function markWake(): void {
  stats.wake++;
}
export function resetEchoState(): void {
  stats = { enforce: 0, shadow: 0, wake: 0, pass: 0 };
}

/**
 * 判一条消息是否回声。
 * ⚠️ 纯判定优先：本函数只在传了 seen 时才写指纹表（放行时登记），方便单测逐条独立判。
 */
export function classifyEcho(input: EchoInput, w: Windows): EchoVerdict {
  const now = input.now ?? Date.now();
  const fromBot = parseFromBot(input.text);
  const fp = fingerprint(input.text);
  const base = { fromBot, fp, mode: w.echoMode };
  const seen = input.seen;

  // 1) 无尾注 = 人类本人发的，永远放行（团队铁律：闸门只拦 bot→bot）
  if (!fromBot) {
    if (seen) { seen.set(fp, now); prune(seen, w, now); }
    return PASS('human-no-trailer', base);
  }
  // 2) 自己给自己（模型 to=自己，或回执原路弹回本进程）= 自环根，掐掉
  if (fromBot === input.me) {
    return verdict(base, 'self-addressed', w, stats, 'enforce');
  }
  // 3) 纯点头（互刷风暴的原子单位）
  if (isAckOnly(normalizeBody(input.text))) {
    return verdict(base, 'ack-only', w, stats, 'enforce');
  }
  // 4) 窗口内二现 = 重复投递/回声弹回。
  //    ⚠️ 只在「回执件」或「短句」上启用判重：老大若真把同一条长派活重发一遍，必须放行
  //    ——宁可让 bot 重复执行一次，也不能把任务吞掉（吞任务的代价远大于重复）。
  const body = normalizeBody(input.text);
  const dupEligible = input.text.includes('（自动回执）') || body.length <= 40;
  if (dupEligible && seen && seen.has(fp)) {
    return verdict(base, 'dup-fingerprint', w, stats, 'enforce');
  }
  // 放行：登记指纹（后续同一句再来才认得出是二现）
  if (seen) { seen.set(fp, now); prune(seen, w, now); }
  stats.pass++;
  return PASS('fresh', base);
}

function verdict(base: Omit<EchoVerdict, 'suppress' | 'reason'>, reason: string, w: Windows, st: typeof stats, _k: string): EchoVerdict {
  if (w.echoMode === 'off') {
    st.pass++;
    return { suppress: false, reason: `${reason}(mode-off)`, ...base };
  }
  if (w.echoMode === 'shadow') {
    st.shadow++;
    return { suppress: false, reason: `${reason}(shadow)`, ...base };
  }
  st.enforce++;
  return { suppress: true, reason, ...base };
}

/** 清扫：条目存活超过 echoWindowMs 就扔；清扫周期本身由调用方按 echoPruneMs 定时驱动 */
export function prune(seen: Map<string, number>, w: Windows, now = Date.now()): void {
  for (const [k, at] of seen) if (now - at > w.echoWindowMs) seen.delete(k);
  // 容量兜底：进程长跑不炸内存（LRU 语义：先登记的先扔）。
  // 🔴 必须循环删到上限：原先只删一条，实测一次涨 1000 条后表停在 5999 不降（0929 回归实拍）。
  while (seen.size > 5000) {
    const first = seen.keys().next().value;
    if (first === undefined) break;
    seen.delete(first);
  }
}

/** 新建一张回声指纹表（index.ts 启动时调一次；清扫周期用 windows().echoPruneMs 驱动） */
export function newEchoLedger(): Map<string, number> {
  return new Map<string, number>();
}
