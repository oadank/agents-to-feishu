/**
 * 自动压缩公共模块（2026-09-30 任务单 2 · 自 claude.ts 三层实现抽取）。
 *
 * 三层触发，桥只决定"何时"，压缩本体永远归各家 CLI/引擎（桥不自研摘要）：
 *  - 兜底层（硬保险，永不关）：轮末真实用量（input + cacheRead，即 hit+input）≥
 *    CTI_<BOT>_AUTOCOMPACT_RATIO（默认 0.70，可调不可关）× 上下文窗口 → 必须触发。
 *  - 预防层（CTI_<BOT>_AUTOCOMPACT=0 仅关本层）：轮数 ≥ CTI_<BOT>_AUTOCOMPACT_TURNS
 *    （默认 40）或距上次压缩 ≥ CTI_<BOT>_AUTOCOMPACT_HOURS（默认 24h）→ 提前压。
 *  - 手动层：用户 /compact（各家自己透传，桥不掺和）。
 *
 * 会话级压缩状态落盘 runtime/compact-state-<bot>.json（每 bot 独立文件、tmp+rename 原子写、
 * 惰性路径——P2-3 教训：模块加载早于 CTI_USER_HOME 灌入），重启恢复；/new 清账。
 * <BOT> 取 CTI_BOT 大写：claude bot 即 CTI_CLAUDE_*，与 09-30 claude 单家版 env 完全同名。
 *
 * 用量口径：usedTokens = inputTokens + cacheReadTokens（任务单 1 定义的 hit+input）。
 * 各家 provider 上报字段名不一（禁止照抄 claude），provider 负责把自己家字段映射成
 * UsageInfo 再喂 decision()；usage 全零/缺失的 bot 兜底层天然沉默（任务单 2 第 2 步
 * 按"轮数硬上限"降级，属 provider 侧策略，本模块只做三层原义）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CompactState {
  lastCompactAt: number;
  turnsSinceCompact: number;
  updatedAt: number;
  /** C 类（无压缩能力引擎）兜底告警防刷屏：已播过的 10% 用量段号（70%→7，80%→8…） */
  lastWarnedBand?: number;
}

/** 三层判定结论：label 进播报（自动·<label>），detail 进日志 */
export interface AutoCompactTrigger { kind: 'usage' | 'prevention'; label: string; detail: string }

/** provider 把自家 usage 映射成 UsageInfo 后传入；字段对不上/全零时兜底层自然沉默 */
export type UsageInput = { inputTokens?: number; cacheReadTokens?: number } | null;

/** usedTokens 口径唯一收口：hit + input（cacheWrite 不计——任务单 1 的定义，缓存写入下一轮就折进 cacheRead） */
export function usedTokensOf(usage: UsageInput): number {
  if (!usage) return 0;
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
}

export class AutoCompact {
  private states: Map<string, CompactState> | null = null;
  /** 最近一次 boundary 时刻（进程内）：预防层防抖——刚压完再压多半是白压。兜底层不设防抖。 */
  private lastBoundaryAt = 0;
  private readonly bot: string;
  private readonly file: () => string;
  private readonly log: (msg: string) => void;

  /**
   * @param bot   bot 名（默认 CTI_BOT）：决定状态文件名与 env 前缀
   * @param log   日志出口（provider 传自家 rtLog 包装，保持 [bot] 前缀习惯）
   */
  constructor(opts?: { bot?: string; log?: (msg: string) => void; file?: () => string }) {
    this.bot = opts?.bot || process.env.CTI_BOT || 'default';
    this.log = opts?.log ?? (() => {});
    // 惰性求值路径（P2-3 教训）：函数形式，首次用盘时才取 CTI_USER_HOME
    this.file = opts?.file ?? (() => path.join(
      process.env.CTI_USER_HOME || os.homedir(),
      '.agents-to-feishu', 'runtime', `compact-state-${this.bot}.json`,
    ));
  }

  private load(): Map<string, CompactState> {
    if (this.states) return this.states;
    const map = new Map<string, CompactState>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf-8')) as { sessions?: Record<string, CompactState> };
      const cutoff = Date.now() - 30 * 24 * 3_600_000;
      for (const [k, s] of Object.entries(raw.sessions ?? {})) {
        if (!s || typeof s.lastCompactAt !== 'number' || typeof s.turnsSinceCompact !== 'number') continue;
        if ((s.updatedAt ?? s.lastCompactAt) < cutoff) continue; // 30 天没动静的孤儿会话不复活
        map.set(k, { lastCompactAt: s.lastCompactAt, turnsSinceCompact: s.turnsSinceCompact, updatedAt: s.updatedAt ?? s.lastCompactAt });
      }
      this.log(`压缩状态从盘恢复: ${map.size} 个会话`);
    } catch { /* 首次运行/文件损坏：空表起步 */ }
    this.states = map;
    return map;
  }

  private save(): void {
    const map = this.states;
    if (!map) return;
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      const sessions: Record<string, CompactState> = {};
      for (const [k, s] of map) sessions[k] = s;
      const tmp = `${this.file()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, bot: this.bot, at: new Date().toISOString(), sessions }));
      fs.renameSync(tmp, this.file());
    } catch (e) {
      this.log(`压缩状态落盘失败（不影响对话，仅重启丢计数）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 取或建会话压缩状态：新会话 lastCompactAt=现在（新开的上下文没东西可压，24h 时钟从首轮起算） */
  stateFor(sessionKey: string): CompactState {
    const map = this.load();
    let st = map.get(sessionKey);
    if (!st) {
      st = { lastCompactAt: Date.now(), turnsSinceCompact: 0, updatedAt: Date.now() };
      map.set(sessionKey, st);
    }
    return st;
  }

  /** compact_boundary（手动或自动）唯一计数重置点：lastCompactAt=now、turnsSinceCompact=0 */
  markCompacted(sessionKey: string): void {
    if (!sessionKey) return;
    const st = this.stateFor(sessionKey);
    st.lastCompactAt = Date.now();
    st.turnsSinceCompact = 0;
    st.updatedAt = Date.now();
    this.lastBoundaryAt = Date.now();
    this.save();
  }

  /**
   * C 类（无压缩通道、CLI 也不自带的引擎）兜底告警判定：used ≥ RATIO×窗口 → 播一次。
   * 防刷屏：同会话每跨一个 10% 用量段只发一次（70% 段一次、80% 段再一次…），
   * 段号落盘（lastWarnedBand），/new 清账后重新起算。返回 null=本轮不播。
   * @param used 真实用量（各家 provider 把自家字段映射后的 hit+input 或 usage_update.used）
   * @param windowTokens 窗口：优先传 usage_update.size（各家白送），缺省回 env
   */
  floorWarning(sessionKey: string, used: number, windowTokens?: number): { pct: number; band: number; hoursDesc: string } | null {
    if (!sessionKey || used <= 0) return null;
    const win = windowTokens && windowTokens > 0
      ? windowTokens
      : (Number(process.env[`CTI_BOT_${this.bot.toUpperCase()}_CONTEXT_WINDOW`]) || 200_000);
    const ratioRaw = Number(process.env[`CTI_${this.bot.toUpperCase()}_AUTOCOMPACT_RATIO`]);
    const ratio = ratioRaw > 0 ? ratioRaw : 0.70;
    const pct = Math.min(100, Math.round((used / win) * 100));
    const floorPct = Math.round(ratio * 100);
    if (pct < floorPct) return null;
    const band = Math.floor(pct / 10);
    const st = this.stateFor(sessionKey);
    // 注意 ?? -1：段号从 0 起（ratio 调得很小时 pct 可能落 0 段），默认 0 会把首条告警吞掉
    if ((st.lastWarnedBand ?? -1) >= band) return null;
    st.lastWarnedBand = band;
    st.updatedAt = Date.now();
    this.save();
    const hours = (Date.now() - st.lastCompactAt) / 3_600_000;
    const hoursDesc = hours >= 1 ? `已 ${Math.round(hours)} 小时` : '从未';
    this.log(`兜底告警[${sessionKey.slice(0, 8)}] used=${used}/${win}=${pct}% ≥ 阈值 ${floorPct}%，播第 ${band} 段（防刷屏）`);
    return { pct, band, hoursDesc };
  }

  /** C 类告警文案统一收口（mimo/openclaw/opencode/deeptutor 共用，别各写各的） */
  static floorWarningText(pct: number, hoursDesc: string, engineLabel: string): string {
    const paren = hoursDesc === '从未' ? '本会话从未压缩' : `${hoursDesc}未压缩`;
    return `\n⚠️ 上下文已达 ${pct}%（${paren}），${engineLabel}无自动压缩能力——建议发 /new 释放上下文，否则长对话质量会逐渐劣化。\n`;
  }

  /** /new 归零：传 sessionKey 只清该会话；不传清全部（claude 的 CLI 上下文是全 bot 共享的常驻进程） */
  clear(sessionKey?: string): void {
    const map = this.load();
    if (sessionKey) { if (map.delete(sessionKey)) this.save(); return; }
    if (map.size > 0) { map.clear(); this.save(); }
  }

  /**
   * 三层触发判定（只在【一轮正常对话完全结束】后调；返回 null=不触发）。
   * 计数先自增再判——"第 N 轮"含刚刚结束的这一轮。
   * @param windowTokens 上下文窗口：缺省读 CTI_BOT_<BOT>_CONTEXT_WINDOW，再退 200k。
   *   claude 传 CLAUDE_CODE_MAX_CONTEXT_TOKENS 链保持原行为（窗口 env 一改阈值自动缩放）。
   */
  decision(sessionKey: string, usage: UsageInput, opts?: { windowTokens?: number }): AutoCompactTrigger | null {
    if (!sessionKey) return null;
    const st = this.stateFor(sessionKey);
    st.turnsSinceCompact += 1;
    st.updatedAt = Date.now();
    this.save();

    // ── 兜底层：永不关（比例可调不可关——任何配置组合下不允许"撑爆也没人压"）──
    const windowTokens = opts?.windowTokens
      ?? (Number(process.env[`CTI_BOT_${this.bot.toUpperCase()}_CONTEXT_WINDOW`]) || 200_000);
    const ratioRaw = Number(process.env[`CTI_${this.bot.toUpperCase()}_AUTOCOMPACT_RATIO`]);
    const ratio = ratioRaw > 0 ? ratioRaw : 0.70;
    const used = usedTokensOf(usage);
    if (usage && windowTokens > 0 && used >= Math.round(ratio * windowTokens)) {
      const pct = Math.min(100, Math.round((used / windowTokens) * 100));
      return { kind: 'usage', label: `用量 ${pct}%`, detail: `used=${used} ≥ ${ratio}×${windowTokens}` };
    }

    // ── 预防层：CTI_<BOT>_AUTOCOMPACT=0 仅关本层 ──
    if (process.env[`CTI_${this.bot.toUpperCase()}_AUTOCOMPACT`] === '0') return null;
    // 非法/缺省回默认（40 轮 / 24h）；env 设 0 = 单独关掉该维度（与 claude 单家版行为一致）
    const nl = Number(process.env[`CTI_${this.bot.toUpperCase()}_AUTOCOMPACT_TURNS`]);
    const hl = Number(process.env[`CTI_${this.bot.toUpperCase()}_AUTOCOMPACT_HOURS`]);
    const turnsLimit = Number.isFinite(nl) ? nl : 40;
    const hoursLimit = Number.isFinite(hl) ? hl : 24;
    const sinceHours = (Date.now() - st.lastCompactAt) / 3_600_000;
    const turnsHit = turnsLimit > 0 && st.turnsSinceCompact >= turnsLimit;
    const hoursHit = hoursLimit > 0 && sinceHours >= hoursLimit;
    if (!turnsHit && !hoursHit) return null;
    // 防抖（仅预防层）：刚压缩过再压多半白压（claude 家 CLI 会回 "Not enough messages to compact."）。
    if (this.lastBoundaryAt && Date.now() - this.lastBoundaryAt < 120_000) {
      this.log(`自动压缩[预防层] 达标（turns=${st.turnsSinceCompact} hours=${sinceHours.toFixed(1)}）但 ${Math.round((Date.now() - this.lastBoundaryAt) / 1000)}s 前刚压缩过，本轮跳过`);
      return null;
    }
    return { kind: 'prevention', label: `第 ${st.turnsSinceCompact} 轮/距上次 ${sinceHours.toFixed(1)} 小时`, detail: `turns=${st.turnsSinceCompact}≥${turnsLimit} 或 ${sinceHours.toFixed(1)}h≥${hoursLimit}h` };
  }
}
