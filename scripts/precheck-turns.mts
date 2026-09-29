/**
 * precheck-turns.mts —— 重启 bot 服务前"先看锅里炖着没"（票 T-0021 · 2026-09-29 dsh）
 *
 * 【为什么需要它】2026-09-29 真实事故：dsh 一把梭 `nssm restart` 12 家，正撞 mimo 从 13:47 起在跑的
 * Motrix 下载轮次（老大亲派）。那一轮 `prompt sent id=103` 之后 rt.log 15 分钟无事件 ≠ 卡住——
 * **桥不把工具事件写进 rt.log，FINAL 走 stdout(out.log)**，所以肉眼看就是"没动静"。
 * 重启把引擎连那一轮一起杀掉 ⇒ 永久没有回包 ⇒ 老大的表象是"mimo 挂了"。
 *
 * 【第二版·同日老大当场纠正】第一版把「没台账 + 90min 内有日志动静」一律判"别动"，
 * 结果 claude/codex/mimo/workbuddy（静默 26~67min，**全都已完工**）被我误报成忙碌。
 * 根因是概念混用：90min 是**僵尸判定阈值**（台账心跳停了多久算死现场），不是"多久内有动静算在忙"。
 * 更要命的逻辑死结：**没台账恰恰是因为这些家还没装上新代码**——把它们一直拦着，就永远滚不动它们，
 * 判据永远拿不到。所以本版把"不可判定"与"确认在忙"分开：前者默认不拦（但要说明风险与补救办法）。
 *
 * 【判据真源】src/bridge/turn-ledger.ts（桥自己在每轮开始/心跳/结束时落盘 logs/<bot>-turn.json）。
 * 本脚本不写第二套逻辑：judgeTurns() 从模块 import，阈值从 windows.ts 取（turnStaleMs / precheckQuietMs）。
 *
 * 用法：
 *   npx tsx scripts/precheck-turns.mts                 # 查全部 bot
 *   npx tsx scripts/precheck-turns.mts mimo claude     # 只查这几家（滚某几家前）
 *   npx tsx scripts/precheck-turns.mts --json          # 机读（给门禁/自动化用）
 *   npx tsx scripts/precheck-turns.mts --strict        # 保守档：连"不可判定"也拦（升级运维时用）
 * 退出码：0 = 可滚；1 = 有"确认在忙/疑似在忙"的家；2 = 取证本身失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { judgeTurns, readTurnFile, turnLogFile, type TurnVerdict } from '../src/bridge/turn-ledger.js';
import { windows } from '../src/bridge/windows.js';

type State = 'idle' | 'running' | 'likely-busy' | 'stale-leftover' | 'unknown';
interface Row {
  bot: string;
  state: State;
  /** 判据来源：turn-file(权威) / quiet-window(日志静默启发) / no-log */
  via: string;
  detail: string;
}

const root = path.resolve(import.meta.dirname, '..');
const logsDir = path.join(root, 'logs');

/**
 * bot 名单：**权威 = 配置中心 `/api/agents` 的 id**，再用 logs/ 里的真实前缀做别名解析。
 * 🔴 三个坑都踩过（2026-09-29 同一张票里）：
 *   ① 凭记忆写 /api/state（不存在）→ 静默走兜底 → 不写 rt.log 的 workbuddy 凭空消失。
 *   ② 只信 id → `deeptutor` 与日志前缀 `deeptutor-bot` 不同名 → 那家变"取不到证"。
 *   ③ 只扫 logs 前缀 → 把 probe / service / dsh-acp-test 这类杂项日志当成 bot（19 家，6 家噪声）。
 *   ⇒ 正解：id 给范围（13 家），前缀给别名；配置中心不可用时退到"只认 *-rt.log"（桥独有，噪声小）。
 */
function prefixesFromLogs(): string[] {
  try {
    const set = new Set<string>();
    for (const f of fs.readdirSync(logsDir)) {
      const m = f.match(/^(.+?)-(?:rt|out|err|turn)(?:[-.].*)?$/);
      if (m?.[1] && !/^\d+$/.test(m[1])) set.add(m[1]);
    }
    return [...set];
  } catch {
    return [];
  }
}

/** 只认 *-rt.log 的窄兜底（配置中心连不上时用，避免把杂项日志当 bot） */
function rtPrefixes(): string[] {
  try {
    return [...new Set(fs.readdirSync(logsDir).filter((f) => f.endsWith('-rt.log')).map((f) => f.replace(/-rt\.log$/, '')))].sort();
  } catch {
    return [];
  }
}

async function listBots(): Promise<string[]> {
  const prefixes = prefixesFromLogs();
  let ids: string[] = [];
  try {
    const res = await fetch('http://127.0.0.1:13600/api/agents', { signal: AbortSignal.timeout(5000) });
    const j = (await res.json()) as Array<{ id?: string }>;
    if (Array.isArray(j)) ids = j.map((a) => a.id).filter((n): n is string => !!n);
  } catch { /* 走窄兜底 */ }
  if (!ids.length) return rtPrefixes();
  return [...new Set(ids.map((id) => {
    if (prefixes.includes(id)) return id;
    const alias = prefixes.find((p) => p.startsWith(`${id}-`)); // deeptutor → deeptutor-bot
    return alias ?? id;
  }))].sort();
}

/** 从日志尾部反向找最后一条带 ISO 时间戳且匹配 pattern 的行 */
function lastStamp(file: string, pattern: RegExp): { at: number; line: string } | null {
  try {
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(pattern);
      if (m) {
        const at = Date.parse(m[1]);
        if (!Number.isNaN(at)) return { at, line: lines[i].trim().slice(0, 150) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

const mtime = (f: string): number => { try { return fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0; } catch { return 0; } };

/** 只读文件尾部（默认 64KB），避免为取几行把整份日志灌进内存 */
function tailText(file: string, bytes = 65536): string {
  try {
    if (!fs.existsSync(file)) return '';
    const st = fs.statSync(file);
    const len = Math.min(bytes, st.size);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * 这家跑的进程**有没有 turn 台账能力**（签名两路取，缺一不可）：
 *   rt.log 的 `[windows] … 在途信任期=`（rtLog 写的，T-0021 起）
 *   out.log 的 `窗口表 OK（… W1~W5/W1~W6）`（console.log 写的，T-0019 只有 W1~W4，故必须认 W1~W5 以上）
 * 🔴 为什么要两路：workbuddy 这类家**没配 CTI_RT_LOG**，rtLog 那行压根不存在；
 *    只查 rt.log 就把刚装上新代码的它当成"旧代码"，再叠上"重启刷新过 mtime"→ 误判"疑似在途"（09-29 连踩两次）。
 */
function hasLedgerCapability(rtFile: string, outFile: string): boolean {
  return tailText(rtFile).includes('在途信任期')
    || /窗口表 OK[^\n]*W1~W[5-9]/.test(tailText(outFile));
}

/**
 * 无台账的家怎么判。🔴 先分清两种"没有台账"，别再一律说成旧代码（09-29 被老大纠正后第二处修正）：
 *   A. **新代码在线但没台账文件** —— rt.log 最后一条 `[windows]` 行带"在途信任期"签名。
 *      新代码只要接一次活就会写台账，所以"没文件" = 这个进程起来后**从没处理过消息** ⇒ 判 `idle`（强证据）。
 *   B. **旧代码**（没有那行签名）—— 只能看日志静默：
 *      静默 ≤ precheckQuietMs（出厂 5min）→ `likely-busy` 🟠 拦（刚有动静，很可能正跑着）
 *      静默 > precheckQuietMs            → `unknown` ⚪ **不可判定，默认不拦**
 * 🔴 为什么 B 不学第一版"拿不准就当忙"：那会把所有没装新代码的家永久拦在门外，
 *    而装上台账才是让判据变可靠的唯一出路（09-29 我就被自己这条误判卡住，老大当场指出"其他全部完工了"）。
 *    残留风险（长轮次跑到静默期之后）用 --strict 档 + "动它前先问一句"兜。
 */
function judgeNoLedger(bot: string, now: number, quietMs: number): Row {
  const rtFile = path.join(logsDir, `${bot}-rt.log`);
  const outFile = path.join(logsDir, `${bot}-out.log`);
  if (!fs.existsSync(rtFile) && !fs.existsSync(outFile)) {
    return { bot, state: 'unknown', via: 'no-log', detail: 'rt.log 与 out.log 都没有：无法取证（服务名/日志前缀对不上？还是没起过？）' };
  }
  if (hasLedgerCapability(rtFile, outFile)) {
    return { bot, state: 'idle', via: 'signature(有台账能力·无台账=没接过活)', detail: '带 T-0021 台账签名的进程一接活就必写台账；现在没有台账 → 这个进程起来后没处理过任何消息，判空闲' };
  }
  const incoming = lastStamp(rtFile, /\[([0-9T:.Z-]+)Z?\].*(?:\[handleIncoming\]|prompt sent)/);
  const lastTouch = Math.max(incoming?.at ?? 0, mtime(rtFile), mtime(outFile));
  const quietMin = Math.round((now - lastTouch) / 60000);
  if (now - lastTouch <= quietMs) {
    return { bot, state: 'likely-busy', via: `quiet-window(静默≤${Math.round(quietMs / 60000)}min)`, detail: `${quietMin}min 内还有日志动静、且这台是旧代码（无签名无台账）→ 疑似在途，先别动：${incoming?.line ?? '(动静来自文件写入)'}` };
  }
  return {
    bot, state: 'unknown', via: `quiet-window(静默${quietMin}min>${Math.round(quietMs / 60000)}min)`,
    detail: `这台没有台账能力签名（rt.log 的"在途信任期"与 out.log 的"窗口表 OK…W1~W5+"都没见到）+ 已静默 ${quietMin}min → **不可判定**，默认不拦；动它前先问一句有无在途，或者干脆滚上新代码（滚完就有台账，判据立刻变权威）`
  };
}

const rows: Row[] = [];
const now = Date.now();
const w = windows();
const argBots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wantJson = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

const bots = argBots.length ? argBots : await listBots();
if (!bots.length) {
  console.error('取证失败：既连不上配置中心，也没在 logs/ 找到任何 *-rt.log');
  process.exit(2);
}

for (const bot of bots) {
  const f = readTurnFile(turnLogFile(path.join(logsDir, `${bot}-rt.log`), bot), bot);
  if (!f) { rows.push(judgeNoLedger(bot, now, w.precheckQuietMs)); continue; }
  const v: TurnVerdict = judgeTurns(f, now, w.turnStaleMs);
  if (v.state === 'running') {
    rows.push({ bot, state: 'running', via: 'turn-file(权威)', detail: `${v.turns.length} 轮在途，最长已炖 ${Math.round(v.oldestMs / 60000)}min（心跳 ${Math.round(v.beatAgoMs / 1000)}s 前）：${v.turns.map((t) => `"${t.preview}"`).join(' | ')}` });
  } else if (v.state === 'stale-leftover') {
    rows.push({ bot, state: 'stale-leftover', via: 'turn-file(权威)', detail: `${v.turns.length} 条未完成现场、心跳已停 ${Math.round(v.beatAgoMs / 60000)}min（进程已死/刚被杀）→ 不拦重启，但这是**上次被打断的现场**，先读它：${v.turns.map((t) => `"${t.preview}"`).join(' | ')}` });
  } else {
    rows.push({ bot, state: 'idle', via: 'turn-file(权威)', detail: '空闲（台账在、turns=0 = 上一轮已销账）' });
  }
}

const sure = rows.filter((r) => r.state === 'running' || r.state === 'likely-busy');
const unknown = rows.filter((r) => r.state === 'unknown');
const leftovers = rows.filter((r) => r.state === 'stale-leftover');
const blocked = strict ? [...sure, ...unknown] : sure;

if (wantJson) {
  console.log(JSON.stringify({ checkedAt: Date.now(), turnStaleMs: w.turnStaleMs, precheckQuietMs: w.precheckQuietMs, strict, blocked: blocked.length, sureBusy: sure.length, unknownCount: unknown.length, rows }, null, 2));
} else {
  console.log(`\n重启前在途检查 · 台账判据(src/bridge/turn-ledger.ts) 信任期 ${(w.turnStaleMs / 60000).toFixed(0)}min / 安静期 ${(w.precheckQuietMs / 60000).toFixed(0)}min${strict ? ' 【--strict：不可判定也拦】' : ''}`);
  console.log('─'.repeat(72));
  const icon: Record<State, string> = { running: '🔴 在忙', 'likely-busy': '🟠 疑似', 'stale-leftover': '🟡 现场', idle: '🟢 空闲', unknown: '⚪ 不可判' };
  for (const r of rows) console.log(`${icon[r.state]}  ${r.bot.padEnd(14)} [${r.via}] ${r.detail}`);
  console.log('─'.repeat(72));
  if (blocked.length) {
    console.log(`结论：${blocked.length} 家不该动 → ${blocked.map((r) => `${r.bot}${r.state === 'unknown' ? '(不可判)' : ''}`).join(' / ')}`);
  } else {
    console.log('结论：没有"确认在忙/疑似在忙"的家，可以滚（仍建议分批：先 1 家验活，再 3~4 家一批）。');
  }
  if (unknown.length && !strict) {
    console.log(`提示：${unknown.length} 家没有台账、只能判"不可判定"（${unknown.map((r) => r.bot).join(' / ')}）——`);
    console.log('      它们恰恰是**还没装 T-0021 新代码**的家；滚上新代码才会有台账，判据才从概率变权威。');
    console.log('      要连这批也拦住：加 --strict。');
  }
  if (leftovers.length) console.log(`提示：${leftovers.length} 家留有"上次被打断"的现场（${leftovers.map((r) => r.bot).join(' / ')}）→ 动手前先读 logs/<bot>-turn*.json。`);
}
process.exit(blocked.length ? 1 : 0);
