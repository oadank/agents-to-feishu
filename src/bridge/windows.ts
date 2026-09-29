/**
 * 窗口单一真源（票 T-0019③ · 2026-09-29 dsh）
 *
 * 【治什么】这些"记多久就忘"的时间，原先散在 5 处硬编码、配置页看不见、也没人检查它们合不合理：
 *   auto-receipt.ts  RECEIPT_TTL=1h / 手动回执抑制=5min
 *   de-flow.ts       PENDING_TTL=30min
 *   index.ts         PENDING_IMG_TTL=10min / IMAGE_TTL=24h
 * 抄 agent-mailbox 的做法：一处收口 + **启动即自查不变量，对不上直接抛错**（它注释里叫"铁1"）。
 * 抛错在 nssm 下的表现 = 该 bot 服务起不来 + 日志点名是哪条不等式、当前值多少、怎么修。
 * 🔴 绝不静默回落默认值：静默降级正是"配置中心回写抹旧"那类事故的温床（2026-09-19 教训同型）。
 *
 * 【四条不变量及其物理解释】（checkInvariants 逐条判，全用毫秒）
 *   W1 清扫周期 < 最短存活  —— 内存表清得比条目过期慢，过期条目就长期赖在表里（判重依据失真）。
 *   W2 回声判重窗口 ≥ 待回执存活 —— 登记还活着而指纹先失效 ⇒ 同一份回执被当"新信"二次投递
 *      （agent-mailbox 铁1 的同型事故：回收窗口 ≥ 去重窗口时，重复信刚被放行那一刻复活陈旧原件）。
 *   W3 手动回执抑制窗 ≤ 待回执存活 —— 抑制窗比登记还长，会把正常的下一条真消息一起吞掉。
 *   W4 等补文本窗口 ≤ 图片磁盘保留 —— 内存登记先过期，磁盘清理不再认它在途，文件被删掉，
 *      用户后补的那句文字就只能对着一个不存在的路径。
 *
 * 【env 键】全部由配置中心 render.ts 渲染进 config.<bot>.env（键名同名），运行时页可看可改。
 *   CTI_RECEIPT_PENDING_TTL_MS / CTI_MANUAL_RECEIPT_WINDOW_MS / CTI_DE_PENDING_TTL_MS
 *   CTI_PENDING_IMG_TTL_MS / CTI_IMAGE_TTL_MS / CTI_ECHO_WINDOW_MS / CTI_ECHO_PRUNE_MS / CTI_ECHO_MODE
 */

/** 出厂默认值（毫秒）。改这里 = 改全局口径；render.ts 从这里取数下发，不在两处各写一遍。 */
export const WINDOW_DEFAULTS = {
  /** 待回执登记的存活时长：bot 收到派活后，桥在这段时间内记得"回复要转回给谁" */
  receiptPendingMs: 60 * 60_000,
  /** 该 bot 自己用 send_as_user 回执后，桥在这段窗口内不再自动转发（防双份送达） */
  manualReceiptMs: 5 * 60_000,
  /** /de 三选一卡片的存活时长 */
  dePendingMs: 30 * 60_000,
  /** 先发图后补文：图在这段窗口内等那句文字 */
  pendingImgMs: 10 * 60_000,
  /** 收图/TTS 落盘文件保留时长（0 = 永不自动清理，老大可用的逃生档） */
  imageMs: 24 * 60 * 60_000,
  /** 回声判重：同一条 bot 链路内容在这段窗口内第二次出现 = 回声 */
  echoWindowMs: 60 * 60_000,
  /** 回声指纹表的清扫周期（必须明显短于上面所有存活窗口） */
  echoPruneMs: 5 * 60_000,
} as const;

export type EchoMode = 'enforce' | 'shadow' | 'off';

export interface Windows {
  receiptPendingMs: number;
  manualReceiptMs: number;
  dePendingMs: number;
  pendingImgMs: number;
  imageMs: number;
  echoWindowMs: number;
  echoPruneMs: number;
  echoMode: EchoMode;
}

/** env 名 ↔ 字段（同时用于 render.ts 下发与 fail-loud 报错点名） */
export const WINDOW_ENV_KEYS = {
  receiptPendingMs: 'CTI_RECEIPT_PENDING_TTL_MS',
  manualReceiptMs: 'CTI_MANUAL_RECEIPT_WINDOW_MS',
  dePendingMs: 'CTI_DE_PENDING_TTL_MS',
  pendingImgMs: 'CTI_PENDING_IMG_TTL_MS',
  imageMs: 'CTI_IMAGE_TTL_MS',
  echoWindowMs: 'CTI_ECHO_WINDOW_MS',
  echoPruneMs: 'CTI_ECHO_PRUNE_MS',
} as const;

type NumField = keyof typeof WINDOW_ENV_KEYS;

/** 人话名（报错与配置页共用） */
const CN: Record<NumField, string> = {
  receiptPendingMs: '待回执存活',
  manualReceiptMs: '手动回执抑制窗',
  dePendingMs: '/de 卡片存活',
  pendingImgMs: '等补文本窗口',
  imageMs: '图片磁盘保留',
  echoWindowMs: '回声判重窗口',
  echoPruneMs: '回声表清扫周期',
};

function parseMs(raw: string | undefined, field: NumField): number {
  if (raw === undefined || raw === '') return WINDOW_DEFAULTS[field];
  // 只收非负整数毫秒；任何畸形值都 fail-loud，绝不"悄悄用默认值"继续跑
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`窗口配置非法：${WINDOW_ENV_KEYS[field]}="${raw}"（${CN[field]}）必须是 ≥0 的整数毫秒。修法：改配置中心运行时页，或删掉这行回出厂默认 ${WINDOW_DEFAULTS[field]}。`);
  }
  const v = Number(raw.trim());
  if (!Number.isSafeInteger(v)) {
    throw new Error(`窗口配置溢出：${WINDOW_ENV_KEYS[field]}=${raw}（${CN[field]}）超出安全整数范围，请改小。`);
  }
  return v;
}

/** 读 env 合成窗口表（纯函数，不抛"不变量"错，只抛畸形值错；便于单测） */
export function readWindows(env: Record<string, string | undefined> = process.env): Windows {
  const w: Windows = {
    receiptPendingMs: parseMs(env[WINDOW_ENV_KEYS.receiptPendingMs], 'receiptPendingMs'),
    manualReceiptMs: parseMs(env[WINDOW_ENV_KEYS.manualReceiptMs], 'manualReceiptMs'),
    dePendingMs: parseMs(env[WINDOW_ENV_KEYS.dePendingMs], 'dePendingMs'),
    pendingImgMs: parseMs(env[WINDOW_ENV_KEYS.pendingImgMs], 'pendingImgMs'),
    imageMs: parseMs(env[WINDOW_ENV_KEYS.imageMs], 'imageMs'),
    echoWindowMs: parseMs(env[WINDOW_ENV_KEYS.echoWindowMs], 'echoWindowMs'),
    echoPruneMs: parseMs(env[WINDOW_ENV_KEYS.echoPruneMs], 'echoPruneMs'),
    echoMode: (() => {
      const m = (env.CTI_ECHO_MODE || 'enforce').trim();
      if (m !== 'enforce' && m !== 'shadow' && m !== 'off') {
        throw new Error(`回声档位非法：CTI_ECHO_MODE="${m}" 只能是 enforce（真吞）/ shadow（只记账）/ off（停用）。`);
      }
      return m as EchoMode;
    })(),
  };
  return w;
}

/** 秒显示（报错里给人看的，别让人自己除） */
const s = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : `${Math.round(ms / 1000)}s`);

/**
 * 逐条查不变量，返回违反项（空数组 = 全合格）。
 * 全用 `>=`/`<=` 显式写死方向，任一边界值都算违反 —— 相等意味着"同时过期"，那正是复活陈旧原件的时机。
 */
export function checkInvariants(w: Windows): string[] {
  const bad: string[] = [];
  const alive = [w.receiptPendingMs, w.dePendingMs, w.pendingImgMs, w.echoWindowMs].filter((v) => v > 0);
  const minAlive = alive.length ? Math.min(...alive) : 0;
  if (w.echoPruneMs <= 0 || (minAlive > 0 && w.echoPruneMs >= minAlive)) {
    bad.push(`W1 回声表清扫周期(${s(w.echoPruneMs)}) 必须 > 0 且 < 最短存活(${s(minAlive)})：清得比条目过期慢，过期条目会赖在表里让判重失真。`);
  }
  if (w.echoWindowMs < w.receiptPendingMs) {
    bad.push(`W2 回声判重窗口(${s(w.echoWindowMs)}) 必须 ≥ 待回执存活(${s(w.receiptPendingMs)})：登记还活着而指纹先失效，同一份回执会被当新信二次投递（agent-mailbox 铁1 同型）。`);
  }
  if (w.manualReceiptMs > w.receiptPendingMs) {
    bad.push(`W3 手动回执抑制窗(${s(w.manualReceiptMs)}) 必须 ≤ 待回执存活(${s(w.receiptPendingMs)})：抑制窗比登记长，会把登记失效后那条真消息一起吞掉。`);
  }
  if (w.imageMs > 0 && w.pendingImgMs > w.imageMs) {
    bad.push(`W4 等补文本窗口(${s(w.pendingImgMs)}) 必须 ≤ 图片磁盘保留(${s(w.imageMs)})：内存登记先过期，磁盘清理不再认它在途，图被删，后补的文字只能对着不存在的路径。`);
  }
  return bad;
}

let cached: Windows | null = null;

/**
 * 启动闸门：读 env → 查不变量 → 不合格当场抛错（服务起不来，日志点名）。
 * 合格则缓存一份，全桥共用同一张表（谁都不再自己算窗口）。
 */
export function assertWindows(env: Record<string, string | undefined> = process.env): Windows {
  const w = readWindows(env);
  const bad = checkInvariants(w);
  if (bad.length) {
    throw new Error(
      `【窗口不变量校验失败，桥拒绝启动】\n${bad.map((b) => `  ✗ ${b}`).join('\n')}\n` +
      `修法：改配置中心「运行时管理」里该 bot 的启动环境（或直接改 config.<bot>.env 对应行），` +
      `出厂合格值见 src/bridge/windows.ts WINDOW_DEFAULTS。`
    );
  }
  cached = w;
  return w;
}

/** 已校验过的窗口表（未初始化则就地校验，仍 fail-loud） */
export function windows(): Windows {
  return cached ?? assertWindows();
}

/** 供 render.ts 下发出厂值用（键名 → 值字符串），单一真源在这里 */
export function factoryEnvLines(): string[] {
  return [
    `CTI_ECHO_MODE=enforce`,
    ...Object.entries(WINDOW_ENV_KEYS).map(([field, key]) => `${key}=${WINDOW_DEFAULTS[field as NumField]}`),
  ];
}

/** 中文说明（server.ts ENV_LABELS 复用，避免两处各写一遍） */
export const WINDOW_LABELS: Record<string, string> = {
  CTI_ECHO_MODE: '回声抑制档：enforce=真吞 / shadow=只记账不吞 / off=停用',
  [WINDOW_ENV_KEYS.receiptPendingMs]: CN.receiptPendingMs + '（毫秒）：桥记得"回复该转回给谁"多久',
  [WINDOW_ENV_KEYS.manualReceiptMs]: CN.manualReceiptMs + '（毫秒）：自己回执后这段时间不再自动转发',
  [WINDOW_ENV_KEYS.dePendingMs]: CN.dePendingMs + '（毫秒）：/de 三选一卡片可点时长',
  [WINDOW_ENV_KEYS.pendingImgMs]: CN.pendingImgMs + '（毫秒）：先发图后补文字，图等多久',
  [WINDOW_ENV_KEYS.imageMs]: CN.imageMs + '（毫秒，0=永不清理）：收图/TTS 落盘保留',
  [WINDOW_ENV_KEYS.echoWindowMs]: CN.echoWindowMs + '（毫秒）：同内容二现判回声，须 ≥ 待回执存活',
  [WINDOW_ENV_KEYS.echoPruneMs]: CN.echoPruneMs + '（毫秒）：回声指纹表清扫周期，须 < 最短存活',
};
