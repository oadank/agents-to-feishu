/**
 * test-restart-gate.mts —— 票 T-0022 重启门禁判据单测（本地跑，不碰任何服务）
 *
 * 验五件事：
 *   1) 台账 running → 拦，且现场带 preview / 炖了多久 / 心跳几秒前；force=1 放行
 *   2) 台账 idle（turns=0）→ 放行
 *   3) 🔴 阈值取自**目标那家**的 config.<bot>.env（不是配置中心自己的 env）—— dsh 点出的坑一
 *   4) 旧代码 + 日志静默超安静期 → 不可判定，默认不拦（沿用 T-0021 第二版口径）
 *   5) 该家窗口值写畸形 → 门禁不炸，退回出厂口径并点名原因
 *
 * 用法：npx tsx scripts/test-restart-gate.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateAgent, turnStatus, agentWindowEnv, isBlockingState } from '../src/config-center/restart-gate.js';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); } else { fail++; console.log(`  \u2717 ${name}${extra ? ' :: ' + extra : ''}`); }
};

const HOME = process.env.CTI_HOME || path.join(os.homedir(), '.agents-to-feishu');
const LOGS = path.resolve(import.meta.dirname, '..', 'logs');
const BOT = 'gate-selftest'; // 临时家：不会与任何真 bot / 服务同名
const F_TURN = path.join(LOGS, `${BOT}-turn.json`);
const F_RT = path.join(LOGS, `${BOT}-rt.log`);
const F_OUT = path.join(LOGS, `${BOT}-out.log`);
const F_ENV = path.join(HOME, `config.${BOT}.env`);

/** 造现场：临时台账 + 临时 config env + 带台账签名的 rt.log（测完全删） */
function fixture(turns: unknown[] | null, envText: string, sig = true): void {
  if (turns) fs.writeFileSync(F_TURN, JSON.stringify({ bot: BOT, pid: 999999, updatedAt: Date.now(), turns }, null, 2));
  else fs.rmSync(F_TURN, { force: true });
  fs.writeFileSync(F_RT, sig ? `[${new Date().toISOString()}] [windows] 启动校验通过：在途信任期=5400000ms 安静期=300000ms\n` : '[no-ts] plain old log line\n');
  fs.writeFileSync(F_ENV, envText);
}
try {
  const now = Date.now();
  console.log('[1] 在途 running 必须拦住');
  fixture([{ chatId: 'oc_test', mid: 'om_test', preview: '正在下载 132MB 安装包', startedAt: now - 5 * 60_000, lastBeatAt: now - 20_000 }], 'CTI_TURN_STALE_MS=5400000\n');
  const g = await gateAgent(BOT, false);
  ok('state=running', g.status.state === 'running', g.status.state + ' via=' + g.status.via);
  ok('block=true', g.block === true);
  ok('isBlockingState(running)', isBlockingState('running'));
  ok('人话含 preview', g.reason.includes('正在下载 132MB 安装包'), g.reason.slice(0, 120));
  ok('人话含炖了多久', g.reason.includes('已炖 5min'), g.reason.slice(0, 120));
  ok('人话含心跳几秒前', /心跳 \d+s 前/.test(g.reason), g.reason.slice(0, 120));
  ok('force=1 放行', (await gateAgent(BOT, true)).block === false);

  console.log('[2] 空闲放行');
  fixture([], 'CTI_TURN_STALE_MS=5400000\n');
  const idle = await gateAgent(BOT, false);
  ok('state=idle', idle.status.state === 'idle', idle.status.state);
  ok('block=false', idle.block === false);

  console.log('[3] 阈值取自目标家 env（坑一）');
  fixture([], 'CTI_TURN_STALE_MS=7200000\nCTI_PRECHECK_QUIET_MS=60000\n');
  const aw = agentWindowEnv(BOT);
  ok('读到该家两键', aw.env.CTI_TURN_STALE_MS === '7200000' && aw.env.CTI_PRECHECK_QUIET_MS === '60000' && aw.present, JSON.stringify(aw));
  const st = await turnStatus(BOT);
  ok('信任期=该家 7200000', st.thresholds.turnStaleMs === 7200000, JSON.stringify(st.thresholds));
  ok('安静期=该家 60000', st.thresholds.precheckQuietMs === 60000, JSON.stringify(st.thresholds));
  ok('对照：本进程未设该键（排除巧合）', process.env.CTI_TURN_STALE_MS === undefined, String(process.env.CTI_TURN_STALE_MS));

  console.log('[4] 旧代码 + 静默超安静期 → 不可判定，不拦');
  fixture(null, 'CTI_TURN_STALE_MS=5400000\nCTI_PRECHECK_QUIET_MS=60000\n', false);
  fs.rmSync(F_OUT, { force: true });
  const quiet = new Date(now - 30 * 60_000); // 造旧：静默 30min 远超 60s 安静期（刚写的会正当判 likely-busy）
  fs.utimesSync(F_RT, quiet, quiet);
  const un = await turnStatus(BOT);
  ok('不误拦（unknown 或 idle）', !isBlockingState(un.state), un.state + ' via=' + un.via);

  console.log('[5] 该家阈值写畸形 → 门禁不炸，退回出厂并点名');
  fixture([], 'CTI_TURN_STALE_MS=abc\n');
  const bad = await turnStatus(BOT);
  ok('仍返回（不抛）', typeof bad.state === 'string', bad.state);
  ok('detail 点名非法', bad.detail.includes('非法'), bad.detail.slice(0, 140));
  ok('阈值回落出厂 90min', bad.thresholds.turnStaleMs === 90 * 60_000, String(bad.thresholds.turnStaleMs));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  // 🔴 用 exitCode 不用 process.exit()：后者会立刻终止进程、跳过 finally ⇒ 夹具文件留在现网，
  // 下一个人会以为多出个 14 号幽灵家（09-29 我这轮就真留下了 gate-selftest 三个文件）。
  process.exitCode = fail ? 1 : 0;
} finally {
  for (const f of [F_TURN, F_RT, F_OUT, F_ENV]) { try { fs.rmSync(f, { force: true }); } catch { /* 临时文件 */ } }
}