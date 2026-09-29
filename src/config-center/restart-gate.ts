/**
 * 重启门禁（票 T-0022 · 2026-09-29 codex）—— 让「重启」这个动作自己先看锅里炖着没。
 *
 * 【治什么】T-0021 已把判据做出来（logs/<bot>-turn.json 在途台账 + scripts/precheck-turns.mts），
 *   但那只眼睛长在**人手上**：只有人记得跑脚本才看得见。配置中心的「重启服务」按钮
 *   （POST /api/agents/:id/restart）与 apply 自动重启（restartAgentProcess）两条真重启路径全绕过它
 *   ⇒ 2026-09-29 打断 mimo 下载活那种事故，点个按钮照样会再来一次。本模块把门禁焊死在动作上。
 *
 * 【判据只有一份（本票第一原则）】
 *   state 由**现跑** scripts/precheck-turns.mts --json <bot> 得出 —— 不在这抄第二套五态机。
 *   现场明细（几轮在途 / 炖了多久 / 心跳几秒前）用 readTurnFile() + judgeTurns() 算 —— 不在这抄第二套判据。
 *   阈值取自**目标那一家自己的** config.<bot>.env —— 不在这抄第二套默认值。
 *
 * 【为什么阈值必须从目标家 env 取（dsh 09-29 点出的坑一）】
 *   precheck 脚本内部调 windows()，读的是**它自己进程**的 env。被配置中心 spawn 时它看到的是
 *   config-center 的环境（基本没设 CTI_TURN_STALE_MS / CTI_PRECHECK_QUIET_MS ⇒ 出厂 90min/5min），
 *   而目标家装的是 config.<bot>.env 里的覆盖值。有人一改某家窗口，门禁就拿出厂值判那一家 —— 口径分家。
 *   修法：spawn 时把**该家那两个键的覆盖值**显式注入子进程 env，脚本内 windows() 自动吃到正确阈值；
 *   配置中心侧全程不写任何默认数字（出厂值仍由 src/bridge/windows.ts 单一真源兜）。
 *
 * 【为什么拦在 server.ts 两条路径、不拦 process-manager.restartAgent 下游】
 *   下游只有 agentId，拿不到"是谁、为什么重启"，force 留痕会断；且 apply 链路走到下游时配置已写盘，
 *   拦在那儿会留下"配置已下发、进程还是旧的"静默漂移。所以门禁放在**动盘之前**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judgeTurns, readTurnFile, turnLogFile, type TurnVerdict } from '../bridge/turn-ledger.js';
import { readWindows, WINDOW_ENV_KEYS } from '../bridge/windows.js';
import { parseEnvFile } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 本文件在 src/config-center/，上溯两级 = 项目根（与 syntax-check.ts 同一口径） */
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const TSX_CLI = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PRECHECK_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'precheck-turns.mts');

/** 五态沿用 precheck-turns 的 State；no-evidence = 脚本跑不起来且无台账（不拦，但要点名） */
export type GateState = 'idle' | 'running' | 'likely-busy' | 'stale-leftover' | 'unknown' | 'no-evidence';

/** 拦人集合 = precheck 的 sure（running + likely-busy），不自己扩 */
const BLOCKING: readonly GateState[] = ['running', 'likely-busy'];
export function isBlockingState(s: GateState): boolean { return BLOCKING.includes(s); }

export interface TurnBrief {
  chatId: string;
  mid: string;
  preview: string;
  /** 这一轮炖了多久（= now - startedAt，纯算术，不是新阈值） */
  inflightMs: number;
  /** 心跳距今多久 */
  beatAgoMs: number;
}

export interface TurnStatus {
  /** 日志前缀（可能与 agent id 不同名：deeptutor → deeptutor-bot） */
  bot: string;
  agentId: string;
  state: GateState;
  /** 判据来源，与 precheck 同口径：turn-file(权威) / quiet-window(...) / signature(...) / no-log */
  via: string;
  detail: string;
  turns: TurnBrief[];
  /** 本次判定真正用的阈值（来自目标家 env；写进响应，让"按哪个口径判的"可核） */
  thresholds: { turnStaleMs: number; precheckQuietMs: number };
  checkedAt: number;
  /** 阈值取自哪个文件；缺文件 = 走 windows.ts 出厂默认 */
  thresholdsFrom: string;
}
/** 与 render.ts:702 / config.ts:108 同一条 config.<bot>.env 路径口径，不另发明 */
function configHome(): string {
  return process.env.CTI_HOME
    || path.join(process.env.CTI_USER_HOME || process.env.USERPROFILE || process.env.HOME || '.', '.agents-to-feishu');
}

/**
 * 读目标那一家 config.<bot>.env 里的两个窗口键（只取这两个，别把整份 env 灌进子进程）。
 * 文件不存在 / 键没设 → 返回空对象 = 让 windows.ts 的 WINDOW_DEFAULTS 兜底（出厂值单一真源在那）。
 */
export function agentWindowEnv(agentId: string): { env: Record<string, string>; from: string; present: boolean } {
  const file = path.join(configHome(), `config.${agentId}.env`);
  const out: Record<string, string> = {};
  let present = false;
  try {
    const parsed = parseEnvFile(fs.readFileSync(file, 'utf-8'));
    present = true;
    for (const key of [WINDOW_ENV_KEYS.turnStaleMs, WINDOW_ENV_KEYS.precheckQuietMs]) {
      const v = parsed[key];
      if (v !== undefined && v !== '') out[key] = v;
    }
  } catch { /* 读不到 = 不注入，脚本内 windows() 自会回落出厂值 */ }
  return { env: out, from: file, present };
}

/**
 * agent id → 日志前缀。precheck 对**显式传入**的 bot 名不做别名解析（argBots 直用），
 * 而 deeptutor 的日志前缀是 deeptutor-bot（服务名不同名）⇒ 必须在调用方先换算别名，
 * 否则那一家永远"取不到证"（T-0021 注释里的坑二，这里按同一口径解掉）。
 */
function logPrefix(bot: string): string {
  if ([`${bot}-rt.log`, `${bot}-out.log`].some((f) => fs.existsSync(path.join(LOGS_DIR, f)))) return bot;
  try {
    const esc = bot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const m = f.match(new RegExp(`^${esc}-(.+?)-(?:rt|out)\\.log$`));
      if (m?.[1]) return `${bot}-${m[1]}`;
    }
  } catch { /* logs 读不到就算了 */ }
  return bot;
}

export interface PrecheckRow { state: GateState; via: string; detail: string; }

/**
 * 现跑现成脚本取 state（唯一判据）。固定带 bot 名：不带参数会走脚本里的 listBots()
 *   回调 GET /api/agents —— 配置中心在自己处理请求时再打自己一次（dsh 09-29 提醒，不死但白搭一跳）。
 * 失败/超时返回 null，由调用方降级到"只读台账"，绝不因为门禁自己坏了就锁死所有重启。
 */
export function runPrecheck(prefix: string, winEnv: Record<string, string>, timeoutMs = 15_000): Promise<PrecheckRow | null> {
  return new Promise((resolve) => {
    if (!fs.existsSync(TSX_CLI) || !fs.existsSync(PRECHECK_SCRIPT)) return resolve(null);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [TSX_CLI, PRECHECK_SCRIPT, '--json', prefix], {
        cwd: PROJECT_ROOT, env: { ...process.env, ...winEnv }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { return resolve(null); }
    let out = '';
    let done = false;
    const finish = (r: PrecheckRow | null): void => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } finish(null); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', () => { /* 脚本自身告警不参与判分 */ });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { rows?: Array<PrecheckRow & { bot: string }> };
        const row = (j.rows || []).find((r) => r.bot === prefix);
        finish(row ? { state: row.state, via: row.via, detail: row.detail } : null);
      } catch { finish(null); }
    });
  });
}

const dur = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : `${Math.round(ms / 1000)}s`);

/**
 * 一家现在的在途现场（只读，零副作用）。
 * state 优先用脚本结论；脚本不可用时降级用台账 judgeTurns()（有台账 = 仍是权威判据）。
 */
export async function turnStatus(agentId: string): Promise<TurnStatus> {
  const bot = logPrefix(agentId);
  const { env: winEnv, from, present } = agentWindowEnv(agentId);
  const now = Date.now();
  const thresholdsFrom = present ? from : '(config env 缺失→出厂默认)';
  // readWindows 是纯函数：拿"配置中心 env + 该家两个覆盖键"合成阈值。
  // 🔴 不用 windows() —— 那是本进程启动时缓存的**配置中心自己的**口径，正是坑一。
  let w: ReturnType<typeof readWindows>;
  try {
    w = readWindows({ ...process.env, ...winEnv });
  } catch (e) {
    // 该家窗口值写畸形（那一家桥本身也起不来）：退回出厂口径继续取证，但把原因写进 detail。
    w = readWindows({});
    const msg = e instanceof Error ? e.message : String(e);
    const row = await runPrecheck(bot, {});
    return {
      bot, agentId, state: row?.state ?? 'no-evidence', via: `thresholds-invalid(${row?.via ?? 'no-evidence'})`,
      detail: `该家窗口配置非法（本次按出厂默认判定）：${msg}${row ? ` | 脚本判定：${row.detail}` : ''}`,
      turns: [], thresholds: { turnStaleMs: w.turnStaleMs, precheckQuietMs: w.precheckQuietMs },
      checkedAt: now, thresholdsFrom,
    };
  }
  const f = readTurnFile(turnLogFile(path.join(LOGS_DIR, `${bot}-rt.log`), bot), bot);
  const v: TurnVerdict = judgeTurns(f, now, w.turnStaleMs);
  const turns: TurnBrief[] = v.turns.map((t) => ({
    chatId: t.chatId, mid: t.mid, preview: t.preview, inflightMs: now - t.startedAt, beatAgoMs: now - t.lastBeatAt,
  }));
  const row = await runPrecheck(bot, winEnv);
  const state: GateState = row?.state ?? (f ? v.state : 'no-evidence');
  const via = row?.via ?? (f ? 'turn-file(权威·脚本不可用降级)' : 'no-evidence');
  const detail = row?.detail ?? (f
    ? `precheck 脚本跑不起来（node/tsx/脚本缺失或超时），本轮按台账直判：${v.state}`
    : '既跑不起 precheck 脚本、也没有台账文件 = 取不到证（不拦重启，但动手前建议问一句）');
  return {
    bot, agentId, state, via, detail, turns,
    thresholds: { turnStaleMs: w.turnStaleMs, precheckQuietMs: w.precheckQuietMs },
    checkedAt: now, thresholdsFrom,
  };
}

/**
 * 把拒绝理由说成人话（老大一眼看懂"这家正在炖什么"）。
 * 🔴 别只甩 409：这个字符串就是前端要显示的 error 正文。
 */
export function humanReason(s: TurnStatus): string {
  const busy = s.turns
    .map((t) => `「${t.preview || '(无摘要)'}」已炖 ${dur(t.inflightMs)}（心跳 ${dur(t.beatAgoMs)} 前）`)
    .join('；');
  const th = `信任期 ${dur(s.thresholds.turnStaleMs)} / 安静期 ${dur(s.thresholds.precheckQuietMs)}`;
  switch (s.state) {
    case 'running':
      return `⛔ ${s.bot} 正在干活：${busy}。判据 ${s.via}（${th}，取自 ${s.thresholdsFrom}）。`
        + '现在重启会把这一轮连引擎一起杀掉 ⇒ 发出去那条永久没有回包（09-29 mimo 下载活就是这么打断的）。'
        + '等它交付完再重启；确认可打断就带 force=1。';
    case 'likely-busy':
      return `⚠️ ${s.bot} 疑似在途：${s.detail}。这台还没有台账能力（旧代码），拿不到权威信号，只能按日志静默概率判`
        + `（安静期 ${dur(s.thresholds.precheckQuietMs)}）。确认可动就带 force=1；`
        + '或先 apply 把它滚上新代码——装上台账后判据才从概率变权威。';
    case 'stale-leftover':
      return `${s.bot} 台账挂着 ${s.turns.length} 条未完成现场、心跳已停（进程已死/上次被杀）→ 不拦重启，但这是上次被打断的现场，先读：${busy}`;
    case 'unknown':
      return `${s.bot} 取不到在途证据（${s.detail}）→ 默认放行。动它前最好问一句有没有在途。`;
    case 'no-evidence':
      return `${s.bot} 门禁取证失败（${s.detail}）→ 默认放行，但这次重启没有"锅里没炖东西"的保证。`;
    default:
      return `${s.bot} 空闲，可以重启。`;
  }
}

export interface GateVerdict { block: boolean; status: TurnStatus; reason: string; }

/**
 * 重启前的门禁判定。force=1 一律放行，但调用方必须把 reason 写进日志留痕（谁强行放的、当时锅里是什么）。
 */
export async function gateAgent(agentId: string, force: boolean): Promise<GateVerdict> {
  const status = await turnStatus(agentId);
  const reason = humanReason(status);
  const block = !force && isBlockingState(status.state);
  return { block, status, reason };
}
