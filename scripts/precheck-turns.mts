/**
 * precheck-turns.mts —— 重启 bot 服务前"先看锅里炖着没"（票 T-0021 · 2026-09-29 dsh）
 *
 * 【为什么需要它】2026-09-29 真实事故：dsh 一把梭 `nssm restart` 12 家，正撞 mimo 从 13:47 起在跑的
 * Motrix 下载轮次（老大亲派）。那一轮 `prompt sent id=103` 之后 rt.log 15 分钟无事件 ≠ 卡住——
 * **桥不把工具事件写进 rt.log，FINAL 走 stdout(out.log)**，所以肉眼看就是"没动静"。
 * 重启把引擎连那一轮一起杀掉 ⇒ 永久没有回包 ⇒ 老大的表象是"mimo 挂了"。
 * 本脚本就是那条本该存在的前置检查：**谁在忙，就先别动谁**。
 *
 * 【判据真源】src/bridge/turn-ledger.ts（桥自己在每轮开始/心跳/结束时落盘 logs/<bot>-turn.json）。
 * 本脚本只读不算第二套逻辑：judgeTurns() 直接从模块 import，阈值从 windows.ts 取，绝不在这里写死毫秒。
 *
 * 用法：
 *   npx tsx scripts/precheck-turns.mts                # 查全部 bot
 *   npx tsx scripts/precheck-turns.mts mimo claude    # 只查这几家（滚某几家前）
 *   npx tsx scripts/precheck-turns.mts --json         # 机读（给别的自动化/门禁用）
 * 退出码：0 = 全部空闲，可以滚；1 = 有家在途，先别动它们；2 = 取证本身失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { judgeTurns, readTurnFile, turnLogFile, type TurnVerdict } from '../src/bridge/turn-ledger.js';
import { windows } from '../src/bridge/windows.js';

interface Row {
  bot: string;
  state: 'idle' | 'running' | 'stale-leftover' | 'unknown';
  /** 台账来源：turn-file（权威）/ heuristic（旧版本没台账时的兜底，仅供参考）/ no-file */
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

/** 抓日志尾部最后一条带 ISO 时间戳的行（rt.log 用 [2026-...Z]，out.log 里 FINAL 走 console.log 无戳） */
function lastStamp(file: string, pattern: RegExp): { at: number; line: string } | null {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(pattern);
      if (m) {
        const at = Date.parse(m[1]);
        if (!Number.isNaN(at)) return { at, line: lines[i].trim().slice(0, 160) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 兜底启发式（仅用于**还没带 T-0021 代码的旧进程**）。
 * 🔴 方向性铁律：宁可多拦一次重启，绝不放行打断别家在途的活（09-29 出的就是"放行"那次事故）。
 * 旧进程拿不到可靠收尾证据：FINAL 走 stdout 且不带时间戳，out.log 的 mtime 会被任何 console 输出刷新
 * —— 我第一版正是拿 mtime 当"有收尾迹象"，把还在跑 Motrix 那轮的 mimo 报成了"空闲"（假阴性）。所以：
 *   - 最后接活早于信任期 → idle（不可能还在跑）
 *   - 信任期内接过活   → **按在途对待**（保守拦，并明说是启发式不是台账）
 * 有 turn.json 时一律以它为准，本函数不参与。
 */
function heuristicRunning(bot: string, now: number, staleMs: number): Row {
  const rtFile = path.join(logsDir, `${bot}-rt.log`);
  const incoming = lastStamp(rtFile, /\[([0-9T:.Z-]+)Z?\].*(?:\[handleIncoming\]|prompt sent)/);
  // 🔴 没有 rt.log ≠ 空闲：workbuddy 这类家压根没配 CTI_RT_LOG（只有 out.log）。
  // 若把它读成"无接活痕迹 → 空闲"，就是拿"我没看见"当"它没在干"——正是 09-29 那次打断的同型错。
  if (!fs.existsSync(rtFile)) {
    const outFile = path.join(logsDir, `${bot}-out.log`);
    if (!fs.existsSync(outFile)) return { bot, state: 'unknown', via: 'no-log', detail: 'rt.log 与 out.log 都没有，无法取证（该家没起过？名字不对？）' };
    const ageMin = Math.round((now - fs.statSync(outFile).mtimeMs) / 60000);
    if (now - fs.statSync(outFile).mtimeMs > staleMs) {
      return { bot, state: 'idle', via: 'heuristic(out.log mtime)', detail: `无 rt.log；out.log 已 ${ageMin}min 没被写过，超过信任期 → 判空闲` };
    }
    return { bot, state: 'running', via: 'heuristic(无 rt.log，out.log 仍在被写，保守当在途)', detail: `out.log ${ageMin}min 前还被写过（该家不写 rt.log，无法确认收尾）→ 按在途对待` };
  }
  if (!incoming) return { bot, state: 'idle', via: 'heuristic(无在途台账)', detail: 'rt.log 存在但没有任何接活痕迹' };
  const ageMin = Math.round((now - incoming.at) / 60000);
  if (now - incoming.at > staleMs) {
    return { bot, state: 'idle', via: 'heuristic(无在途台账)', detail: `最后接活 ${ageMin}min 前，已超信任期 ${(staleMs / 60000).toFixed(0)}min → 不可能还在跑` };
  }
  return {
    bot, state: 'running', via: 'heuristic(无在途台账，保守当在途)',
    detail: `${ageMin}min 前接过活，而这家没有 turn 台账（还没接活，或仍跑旧代码）、无法确认是否已收尾 → 按在途对待：${incoming.line}`
  };
}

const rows: Row[] = [];
const now = Date.now();
const staleMs = windows().turnStaleMs;
const argBots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wantJson = process.argv.includes('--json');

const bots = argBots.length ? argBots : await listBots();
if (!bots.length) {
  console.error('取证失败：既连不上配置中心，也没在 logs/ 找到任何 *-rt.log');
  process.exit(2);
}

for (const bot of bots) {
  // 台账路径与桥同源：CTI_RT_LOG 各家不同，这里按 <repo>/logs/<bot>-rt.log 推
  const f = readTurnFile(turnLogFile(path.join(logsDir, `${bot}-rt.log`), bot), bot);
  if (f) {
    const v: TurnVerdict = judgeTurns(f, now, staleMs);
    if (v.state === 'running') {
      rows.push({ bot, state: 'running', via: 'turn-file(权威)', detail: `${v.turns.length} 轮在途，最长已炖 ${Math.round(v.oldestMs / 60000)}min（心跳 ${Math.round(v.beatAgoMs / 1000)}s 前）：${v.turns.map((t) => `"${t.preview}"`).join(' | ')}` });
    } else if (v.state === 'stale-leftover') {
      rows.push({ bot, state: 'stale-leftover', via: 'turn-file(权威)', detail: `有 ${v.turns.length} 条未完成现场但心跳停了 ${Math.round(v.beatAgoMs / 60000)}min（进程已死/刚被杀）→ 不拦重启，但这是**上次被打断的现场**，先读它：${v.turns.map((t) => `"${t.preview}"`).join(' | ')}` });
    } else {
      rows.push({ bot, state: 'idle', via: 'turn-file(权威)', detail: '空闲（台账在、无在途轮次）' });
    }
    continue;
  }
  rows.push(heuristicRunning(bot, now, staleMs));
}

const running = rows.filter((r) => r.state === 'running');
const leftovers = rows.filter((r) => r.state === 'stale-leftover');
// 🔴 无法取证（unknown）与"确认在途"同等对待：拿不准就当它在忙。
// 放行的代价是打断别家在途的活（09-29 已付过一次），拦下的代价只是我多等一会儿。
const blocked = rows.filter((r) => r.state === 'running' || r.state === 'unknown');

if (wantJson) {
  console.log(JSON.stringify({ checkedAt: Date.now(), turnStaleMs: staleMs, running: running.length, leftovers: leftovers.length, blocked: blocked.length, rows }, null, 2));
} else {
  console.log(`\n重启前在途检查（判据：src/bridge/turn-ledger.ts，信任期 ${(staleMs / 60000).toFixed(0)}min）`);
  console.log('─'.repeat(72));
  for (const r of rows) {
    const icon = r.state === 'running' ? '🔴 别动' : r.state === 'stale-leftover' ? '🟡 现场' : r.state === 'idle' ? '🟢 空闲' : '⚪ 取不到证';
    console.log(`${icon}  ${r.bot.padEnd(15)} [${r.via}] ${r.detail}`);
  }
  console.log('─'.repeat(72));
  if (blocked.length) {
    console.log(`结论：${blocked.length} 家不该动 → ${blocked.map((r) => `${r.bot}${r.state === 'unknown' ? '(取不到证)' : ''}`).join(' / ')}`);
    console.log('      先别 nssm restart 它们；等交完活再滚，或先滚别的家。');
  } else if (leftovers.length) {
    console.log(`结论：没有在途；${leftovers.length} 家留有"上次被打断"的现场（${leftovers.map((r) => r.bot).join(' / ')}）→ 可以滚，但先读现场再动手。`);
  } else {
    console.log('结论：全部空闲，可以滚（仍建议分批：先 1 家验活，再 3~4 家一批）。');
  }
}
process.exit(blocked.length ? 1 : 0);
