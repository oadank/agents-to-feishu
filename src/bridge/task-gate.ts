/**
 * task-gate —— 派活闸门（2026-09-20 老大拍板"注入+技能+闸门三层全上"）。
 *
 * 为什么必须有闸门：统一注入只是"提醒"，13 家里有前科（明禁仍调工具、拿臆想下结论）。
 * 按 09-18 定的三层分工 —— 技能=提醒、闸门=强制、人设=触发 —— 真要防重复派活/互相覆盖，
 * 只能在"派活那一刻"拦，不能指望 bot 自觉。
 *
 * 拦哪儿：lark_send_as_user 带 to= 的那条分支 —— 那是 bot→bot 派活的唯一通道，
 * 人类消息（老大的聊天、群里 @ 人）根本不走这儿，所以对人类聊天零误伤。
 *
 * 怎么判"像派活"（宁可少拦，别拦错）：
 *   ① 正文已带任务号 T-0007 → 放行（正确姿势）
 *   ② 正文显写 notask / 不用建账 → 放行并记豁免（自救阀，豁免涨太多=规则要收）
 *   ③ 命中任务动词表 且 正文够长 → 视为派活 → 按档位办
 *   ④ 其余（暪暄、传话、短问句）→ 放行，不干扰正常通讯
 * 档位存 config-store.settings.taskGate（配置中心「团队任务账」页可切）：
 *   enforce（默认）= 真拦并把过法回给 bot；observe = 只记账不拦；off = 全放。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStore } from '../config-center/store.js';

export type GateMode = 'off' | 'observe' | 'enforce';

/** 任务号格式：与 taskboard.ts 的 T-0001 对齐（至少 3 位，防误命中普通数字） */
const TASK_ID_RE = /\bT-\d{3,}\b/i;
/** 显式豁免（被误拦时的自救口，同时计数可观测） */
const EXEMPT_RE = /\bnotask\b|不用建账|无需任务号/i;

/** 派活特征词表：只收录强祾使/交付语义的词，宁可漏拦不误伤 */
const DISPATCH_HINTS = [
  '帮我', '你去', '请你', '麻烦你', '负责', '接手',
  '实现', '修复', '排查', '定位', '改一下', '改成', '加一个', '加个', '新增',
  '部署', '上线', '发版', '重跑', '回归', '测试', '验收', '审核', '审查',
  '生成', '调研', '整理', '统计', '汇总', '写一', '做完', '交付', '完成后',
];

/** 短于此长度的一律不当派活处理（传话/问句大多很短，先放过） */
const MIN_DISPATCH_LEN = 60;

export interface GateDecision {
  allow: boolean;
  mode: GateMode;
  taskId?: string;
  /** 为什么放行/拦下，原样回给 bot 看 */
  reason: string;
  /** 判定为派活但没号（无论拦没拦都计） */
  missingId: boolean;
  exempted: boolean;
}

export interface GateSample {
  at: string; from: string; to: string; mode: GateMode; action: string; title: string; taskId?: string;
}

export interface GateStats {
  mode: GateMode;
  checked: number;
  dispatchLike: number;
  blocked: number;
  exempted: number;
  withId: number;
  recent: GateSample[];
}

const stats: GateStats = {
  mode: 'enforce', checked: 0, dispatchLike: 0, blocked: 0, exempted: 0, withId: 0, recent: [],
};

function boardDir(): string {
  const home = process.env.CTI_USER_HOME || os.homedir();
  return path.join(home, '.agents-to-feishu', 'runtime', 'taskboard');
}

/** 🔴 每家 bot 各写自己那份计数：13 个桥进程共写一个文件必然互相覆盖（读-改-写抢不过）。
 *  要总账就加，谁也不碰谁的。 */
function statsPath(): string {
  return path.join(boardDir(), `gate-stats.${process.env.CTI_BOT || 'unknown'}.json`);
}

/** 聚合全部 bot 的计数（配置中心页面 / 巡检用） */
export function readAllGateStats(): { totals: Omit<GateStats, 'recent' | 'mode'>; perBot: Record<string, GateStats>; recent: GateSample[] } {
  const perBot: Record<string, GateStats> = {};
  try {
    for (const f of fs.readdirSync(boardDir())) {
      const m = f.match(/^gate-stats\.(.+)\.json$/);
      if (!m) continue;
      try { perBot[m[1]] = JSON.parse(fs.readFileSync(path.join(boardDir(), f), 'utf-8')) as GateStats; } catch { /* 单份坏不拖总账 */ }
    }
  } catch { /* 目录还没建 = 还没人写过 */ }
  const totals = { checked: 0, dispatchLike: 0, blocked: 0, exempted: 0, withId: 0 };
  for (const s of Object.values(perBot)) {
    totals.checked += s.checked || 0;
    totals.dispatchLike += s.dispatchLike || 0;
    totals.blocked += s.blocked || 0;
    totals.exempted += s.exempted || 0;
    totals.withId += s.withId || 0;
  }
  const recent = Object.entries(perBot)
    .flatMap(([bot, s]) => (s.recent || []).map((r) => ({ ...r, from: r.from || bot })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 40);
  return { totals, perBot, recent };
}

/** 启动时回读自己那份历史计数（桥进程重启不丢账；读坏用零起点，结对不抛） */
(function loadStats() {
  try {
    const p = statsPath();
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<GateStats>;
    Object.assign(stats, {
      checked: Number(j.checked) || 0, dispatchLike: Number(j.dispatchLike) || 0,
      blocked: Number(j.blocked) || 0, exempted: Number(j.exempted) || 0, withId: Number(j.withId) || 0,
      recent: Array.isArray(j.recent) ? j.recent.slice(0, 30) : [],
    });
  } catch { /* 计数是观测物，读不到就算了 */ }
})();

let lastPersist = 0;
function persistStats(): void {
  const nowMs = Date.now();
  if (nowMs - lastPersist < 3000) return; // 节流：闸门在发送热路径上，别每步都落盘
  lastPersist = nowMs;
  try {
    const p = statsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...stats, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  } catch { /* 同上 */ }
}

// 档位缓存：config-store.json 不小，别每条 bot 间消息都磁盘读一遍
let modeCache: { v: GateMode; at: number } | null = null;

/** 档位来源：config-store.settings.taskGate；读不到一律按最硬的 enforce（老大拍板就是"上闸门"） */
export function currentMode(): GateMode {
  if (modeCache && Date.now() - modeCache.at < 5000) return modeCache.v;
  let v: GateMode = 'enforce';
  try {
    const s = readStore().settings as { taskGate?: string } | undefined;
    const raw = String(s?.taskGate ?? 'enforce').toLowerCase();
    v = raw === 'off' || raw === 'observe' ? raw : 'enforce';
  } catch {
    v = 'enforce';
  }
  modeCache = { v, at: Date.now() };
  stats.mode = v;
  return v;
}

/** 纯判定函数（自测直接喂样本，不碰网络不碰磁盘） */
export function decideDispatch(text: string): { like: boolean; taskId?: string; exempted: boolean } {
  const mTask = text.match(TASK_ID_RE);
  if (mTask) return { like: true, taskId: mTask[0].toUpperCase(), exempted: false };
  const exempted = EXEMPT_RE.test(text);
  const like = text.length >= MIN_DISPATCH_LEN && DISPATCH_HINTS.some((h) => text.includes(h));
  return { like, exempted };
}

/**
 * 派活前的一刀。返回 allow=false 时调用方必须拒发并把 reason 原样回给 bot。
 * 本函数结对不抛异常：闸门自身出问题不能把飞书发送链路带崩（fail-open 放行 + 记一条）。
 */
export function gateBotDispatch(input: { to: string; text: string; fromBot: string }): GateDecision {
  const mode = currentMode();
  stats.checked += 1;
  const pass = (reason: string, extra?: Partial<GateDecision>): GateDecision =>
    ({ allow: true, mode, reason, missingId: false, exempted: false, ...extra });
  try {
    const { like, taskId, exempted } = decideDispatch(input.text);
    if (taskId) {
      stats.withId += 1;
      push('pass-with-id', input, taskId);
      return pass(`已带任务号 ${taskId}`, { taskId });
    }
    if (!like) return pass('不像派活，放行');

    stats.dispatchLike += 1;
    if (exempted) {
      stats.exempted += 1;
      push('exempt', input);
      return pass('显式豁免（notask），放行 —— 已记一笔，豁免太多说明规则要收紧', { missingId: true, exempted: true });
    }
    if (mode === 'off') { push('pass-mode-off', input); return pass('闸门已关闭，放行', { missingId: true }); }
    if (mode === 'observe') { push('observe-miss', input); return pass('观察模式：像派活但没任务号，本次放行并已记录', { missingId: true }); }

    stats.blocked += 1;
    push('blocked', input);
    return {
      allow: false, mode, missingId: true, exempted: false,
      reason: [
        '派活被闸门拦下：这条消息就是给人派活，但没带任务号 —— 重复派活、两家改同一处互相覆盖，全从这儿来。',
        '怎么办（三选一）：',
        `① 正规：先建账拿号（配置中心 POST /api/tasks，body: {title,intent,shard:"<要动的地盘>",owner:"${input.to}",dedupeKey:"<同一件事的幂等号>"}），拿到 T-000X 把号写进消息重发；`,
        '② 这事已经建过账：直接把那条的号（T-XXXX）写进消息重发，别再新建（带同样的 dedupeKey 也不会新建）；',
        '③ 真的不是派活（纯传话/闲聊/回执）：消息里加 notask 重发 —— 会放行，但豁免计数会上涨，老大看得见。',
        '配置中心 →「团队任务账」页能建账，也能切闸门档位（enforce/observe/off）。',
      ].join('\n'),
    };
  } catch (e) {
    push('gate-error', input);
    return pass(`闸门自身异常已放行（不拦链路）：${e instanceof Error ? e.message : String(e)}`);
  }
}

function push(action: string, input: { to: string; fromBot: string; text: string }, taskId?: string): void {
  stats.recent = [
    {
      at: new Date().toISOString(), from: input.fromBot, to: input.to, mode: stats.mode, action,
      title: input.text.replace(/\s+/g, ' ').slice(0, 90), taskId,
    },
    ...stats.recent,
  ].slice(0, 30);
  persistStats();
}

export function gateStats(): GateStats { return { ...stats, recent: stats.recent.slice(0, 30) }; }

/** 自测用：绕过磁盘档位直接试三种模式（不影响线上判定，线上只认 currentMode()） */
export function __setModeForTest(m: GateMode): void { modeCache = { v: m, at: Date.now() + 600_000 }; }
