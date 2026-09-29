/**
 * 票 T-0019 回归测试（2026-09-29 dsh · 不依赖飞书/nssm，全内存跑）
 *   npx tsx scripts/test-echo-windows.mts
 *
 * 覆盖两件事：
 * ③ 窗口单一真源：默认值合格；每条不变量被破坏都要点名；畸形 env 必须抛（不许静默回落默认值）
 * ① 自我回声抑制：人类消息永不吞 / 自环吞 / 纯点头吞 / 重复投递吞 / **真交付与长派活绝不吞** /
 *    shadow·off 两档只记账不吞
 */
import {
  WINDOW_DEFAULTS, readWindows, checkInvariants, assertWindows, factoryEnvLines, type Windows,
} from '../src/bridge/windows.js';
import { classifyEcho, newEchoLedger, normalizeBody, fingerprint, isAckOnly, prune, resetEchoState } from '../src/bridge/echo-guard.js';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const envOf = (over: Partial<Record<string, string>>): Record<string, string | undefined> => ({ ...over });
const wOf = (over: Partial<Windows>): Windows => ({ ...WINDOW_DEFAULTS, echoMode: 'enforce', ...over }) as Windows;

// ───────────────────────── ③ 窗口单一真源 ─────────────────────────
console.log('\n[1] 出厂默认值必须自己过得了五条不变量');
{
  const w = readWindows(envOf({}));
  ok('默认值无违反项', checkInvariants(w).length === 0, JSON.stringify(checkInvariants(w)));
  ok('assertWindows 不抛', (() => { try { assertWindows(envOf({})); return true; } catch { return false; } })());
  ok('factoryEnvLines 下发 9 键（含 CTI_TURN_STALE_MS）', factoryEnvLines().length === 9, `实际 ${factoryEnvLines().length}`);
  ok('下发键都能被读回（无孤儿键）', factoryEnvLines().every((l) => {
    const [k, v] = l.split('=');
    return readWindows(envOf({ [k]: v, CTI_ECHO_MODE: 'enforce' })) !== null;
  }));
}

console.log('\n[2] 破坏 W1：清扫周期 ≥ 最短存活 → 必须点名');
{
  const bad = checkInvariants(wOf({ echoPruneMs: 30 * 60_000 })); // 30min ≥ 等补文 10min
  ok('W1 命中', bad.some((b) => b.startsWith('W1')), JSON.stringify(bad));
  const zero = checkInvariants(wOf({ echoPruneMs: 0 }));
  ok('W1 也拦清扫关闭(=0)', zero.some((b) => b.startsWith('W1')));
}

console.log('\n[3] 破坏 W2：判重窗口 < 待回执存活（agent-mailbox 铁1 同型）→ 必须点名');
{
  const bad = checkInvariants(wOf({ echoWindowMs: 10 * 60_000, receiptPendingMs: 60 * 60_000 }));
  ok('W2 命中', bad.some((b) => b.startsWith('W2')), JSON.stringify(bad));
  const eq = checkInvariants(wOf({ echoWindowMs: 60 * 60_000, receiptPendingMs: 60 * 60_000 }));
  ok('W2 相等算合格（≥ 语义）', !eq.some((b) => b.startsWith('W2')));
}

console.log('\n[4] 破坏 W3：抑制窗 > 待回执存活 → 必须点名');
{
  const bad = checkInvariants(wOf({ manualReceiptMs: 2 * 60 * 60_000, receiptPendingMs: 60 * 60_000 }));
  ok('W3 命中', bad.some((b) => b.startsWith('W3')), JSON.stringify(bad));
}

console.log('\n[5] 破坏 W4：等补文本 > 图片磁盘保留 → 必须点名；image=0（永不清理）豁免');
{
  const bad = checkInvariants(wOf({ pendingImgMs: 60 * 60_000, imageMs: 10 * 60_000 }));
  ok('W4 命中', bad.some((b) => b.startsWith('W4')), JSON.stringify(bad));
  const off = checkInvariants(wOf({ pendingImgMs: 10 * 60_000, imageMs: 0 }));
  ok('W4 在 image=0 时豁免', !off.some((b) => b.startsWith('W4')), JSON.stringify(off));
}

console.log('\n[5b] 破坏 W5（票 T-0021）：在途信任期 < 待回执存活 → 必须点名');
{
  // 待回执还活着 = 这条派活仍在等回复；信任期更短就会在这时候判僵尸并放行重启 = 亲手打断别家的活
  const bad = checkInvariants(wOf({ turnStaleMs: 10 * 60_000, receiptPendingMs: 60 * 60_000 }));
  ok('W5 命中', bad.some((b) => b.startsWith('W5')), JSON.stringify(bad));
  const eq = checkInvariants(wOf({ turnStaleMs: 60 * 60_000, receiptPendingMs: 60 * 60_000 }));
  ok('W5 相等算合格（≥ 语义）', !eq.some((b) => b.startsWith('W5')), JSON.stringify(eq));
  ok('出厂 turnStale 覆盖实测最长轮次(70min)', WINDOW_DEFAULTS.turnStaleMs >= 70 * 60_000, `实际 ${WINDOW_DEFAULTS.turnStaleMs / 60000}min`);
}

console.log('\n[6] 畸形 env 必须当场抛（🔴 绝不静默回落默认值）');
for (const [key, raw] of [['CTI_ECHO_WINDOW_MS', 'abc'], ['CTI_RECEIPT_PENDING_TTL_MS', '-1'], ['CTI_IMAGE_TTL_MS', '1.5h'], ['CTI_ECHO_MODE', 'ture'], ['CTI_TURN_STALE_MS', '1h']]) {
  let threw = '';
  try { readWindows(envOf({ [key]: raw })); } catch (e) { threw = (e as Error).message; }
  ok(`${key}="${raw}" 被拒`, threw.includes(key) || threw.includes('回声档位'), threw.slice(0, 60));
}
{
  let threw = '';
  try { assertWindows(envOf({ CTI_ECHO_WINDOW_MS: '60000' })); } catch (e) { threw = (e as Error).message; }
  ok('不变量不合格 → assertWindows 抛且给修法', threw.includes('窗口不变量校验失败') && threw.includes('修法'), threw.slice(0, 80));
}

// ───────────────────────── ① 自我回声抑制 ─────────────────────────
const W = wOf({});
const me = 'dsh';
const T = 1_700_000_000_000;

console.log('\n[7] 人类消息（无 from-bot 尾注）永不吞 —— 铁律');
{
  const seen = newEchoLedger();
  for (const t of ['开搞', '收到', '好的', '嗯嗯 👍', '把那条重发一遍']) {
    const v = classifyEcho({ text: t, me, seen, now: T }, W);
    ok(`人类"${t}"放行`, !v.suppress && v.reason === 'human-no-trailer', v.reason);
  }
}

console.log('\n[8] bot 链路上的四种回声都要被认出来');
{
  const cases: Array<[string, string, string]> = [
    [`(from-bot:dsh · 直接回复本消息即可)\n好的`, 'self-addressed', '自己写给自己的门铃'],
    [`[claude] 收到\n\n(from-bot:claude · 程序代发)`, 'ack-only', '对面只点了个头'],
    [`[codex]（自动回执）\n搞定了，T-0019 已交`, 'fresh', '真结果必须叫醒发起方'],
  ];
  for (const [text, want, why] of cases) {
    const seen = newEchoLedger();
    const v = classifyEcho({ text, me, seen, now: T }, W);
    if (want === 'fresh') ok(`${why} → 放行`, !v.suppress, v.reason);
    else ok(`${why} → 吞（${want}）`, v.suppress && v.reason.startsWith(want), v.reason);
  }
}

console.log('\n[9] 重复投递：同一句回执二现即吞；长派活重发绝不吞');
{
  const seen = newEchoLedger();
  const ack = `[codex]（自动回执）\n收到\n\n(from-bot:codex · 程序代发)`;
  const v1 = classifyEcho({ text: ack, me, seen, now: T }, W);
  ok('首次回执放行（ack-only 先判）或登记', v1.suppress ? v1.reason === 'ack-only' : true, v1.reason);

  const seen2 = newEchoLedger();
  const dup = `[claude]（自动回执）\n已按 T-0019 改完并验证\n\n(from-bot:claude · 程序代发)`;
  const a = classifyEcho({ text: dup, me, seen: seen2, now: T }, W);
  const b = classifyEcho({ text: dup, me, seen: seen2, now: T + 1000 }, W);
  ok('同内容二现 → dup-fingerprint 吞', !a.suppress && b.suppress && b.reason === 'dup-fingerprint', `${a.reason}/${b.reason}`);

  const long = `[claude] 请把 polaris-smart 仓库下下来研究，读 SKILL.md，跑一遍测试，产出评估报告，逐条给结论，别只看不说\n\n(from-bot:claude · 程序代发)`;
  const seen3 = newEchoLedger();
  const l1 = classifyEcho({ text: long, me, seen: seen3, now: T }, W);
  const l2 = classifyEcho({ text: long, me, seen: seen3, now: T + 1000 }, W);
  ok('长派活重发仍放行（宁重复不可吞任务）', !l1.suppress && !l2.suppress, `${l1.reason}/${l2.reason}`);
}

console.log('\n[10] 三档行为：enforce 真吞 / shadow 只记账 / off 停用');
{
  const t = `[codex] 好的\n\n(from-bot:codex · 程序代发)`;
  const e = classifyEcho({ text: t, me, seen: newEchoLedger(), now: T }, wOf({ echoMode: 'enforce' }));
  const s = classifyEcho({ text: t, me, seen: newEchoLedger(), now: T }, wOf({ echoMode: 'shadow' }));
  const o = classifyEcho({ text: t, me, seen: newEchoLedger(), now: T }, wOf({ echoMode: 'off' }));
  ok('enforce 吞', e.suppress, e.reason);
  ok('shadow 不吞但记因', !s.suppress && s.reason.includes('shadow'), s.reason);
  ok('off 不吞', !o.suppress && o.reason.includes('mode-off'), o.reason);
}

console.log('\n[11] 归一化与判词边界（别把真交付当点头）');
{
  ok('标点/大小写不影响指纹', fingerprint('好的 👍') === fingerprint('  好的  👍 '));
  ok('尾注不参与指纹', fingerprint('[claude] 收到\n(from-bot:claude · x)') === fingerprint('[codex] 收到\n(from-bot:codex · y)'));
  ok('纯点头判定：好的', isAckOnly(normalizeBody('[claude] 好的 👍')));
  ok('纯点头判定：收到收到', isAckOnly(normalizeBody('收到，收到')));
  ok('带内容的真交付不判点头', !isAckOnly(normalizeBody('好的，已经改完并重启了三家服务')));
  ok('超 30 字不判点头', !isAckOnly(normalizeBody('好的收到，不过这块我还想再确认一下边界条件是什么')));
}

console.log('\n[12] 清扫与容量：过期条目要被清掉，长跑不炸内存');
{
  const seen = newEchoLedger();
  const w = wOf({ echoWindowMs: 60_000 });
  classifyEcho({ text: `[x] 已提交 commit abc（T-0019）\n\n(from-bot:x · 程序代发)`, me, seen, now: T }, w);
  prune(seen, w, T + 120_000);
  ok('超窗口条目被清扫', seen.size === 0, `剩 ${seen.size}`);
  for (let i = 0; i < 6000; i++) seen.set(`k${i}`, T);
  prune(seen, w, T);
  ok('容量兜底不炸内存', seen.size <= 5000, `size=${seen.size}`);
}

resetEchoState();
console.log(`\n════ T-0019 回归：${pass} 通过 / ${fail} 失败 ════`);
if (fail) { console.log('❌ 有失败项，别合进主干'); process.exit(1); }
console.log('✅ 全绿');
