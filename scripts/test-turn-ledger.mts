/**
 * 在途轮次台账回归（票 T-0021 · 2026-09-29 dsh）
 * 运行：npx tsx scripts/test-turn-ledger.mts
 * 原则：纯本地临时目录，不碰真实 logs/、不发任何外部请求。
 *
 * 这套测试守的是"重启前先看锅里炖着没"的那只眼睛——它要是判错，
 * 要么害得 precheck 永远拦重启（假阳性），要么放行了正在干活的 bot（假阴性，就是 09-29 打断 mimo 那次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  markTurn, clearTurn, inflightTurns, readTurnFile, judgeTurns, turnLogFile,
  setTurnBotName, resetTurnLedger, BEAT_FRESH_MS,
} from '../src/bridge/turn-ledger.js';

let pass = 0; let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// 临时目录 + 伪装成某家 bot
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ledger-'));
const rtLog = path.join(tmp, 'ttest-rt.log');
process.env.CTI_RT_LOG = rtLog;
setTurnBotName('ttest');
const file = turnLogFile(rtLog, 'ttest');
const M = 60_000;

console.log('\n[1] markTurn 落盘：谁在忙、忙什么、多久了，都要能从盘上读出来');
{
  markTurn('oc_a', 'om_1', 'Motrix 2.0 下载到本机，你测试ai下载可以使用，然后测试下载个小软件。你先自己跑通，长任务期间请持续观察进度并把结论回给我，务必核对官方字节数');
  const f = readTurnFile(rtLog, 'ttest');
  ok('台账文件生成', f !== null);
  ok('记录了 chatId', f?.turns[0]?.chatId === 'oc_a');
  ok('记录了 mid', f?.turns[0]?.mid === 'om_1');
  ok('记了 pid（供交叉核对进程是否已死）', typeof f?.pid === 'number' && f!.pid === process.pid);
  ok('预览不为空', (f?.turns[0]?.preview ?? '').length > 0);
  ok('预览被截到 ≤80 字（别把整段长文落盘）', (f?.turns[0]?.preview ?? '').length <= 80, `实际 ${(f?.turns[0]?.preview ?? '').length}`);
  ok('无 .tmp 残留（原子写）', !fs.existsSync(`${file}.tmp`));

  // 折叠空白是硬要求：换行会毁掉 precheck 的单行输出，也会让现场文件难读
  markTurn('oc_a', 'om_1x', '第一行\n第二行   中间有很多空格\n\t还有 tab');
  const p = readTurnFile(rtLog, 'ttest')!.turns[0].preview;
  ok('换行/连续空格/tab 全被折叠成单空格', !/[\n\r\t]/.test(p) && !/ {2,}/.test(p), JSON.stringify(p));
  ok('折叠后内容仍在（不是被清空）', p.includes('第一行') && p.includes('第二行'));
}

console.log('\n[2] 判据三态（precheck 的唯一依据）');
{
  const now = Date.now();
  const f1 = readTurnFile(rtLog, 'ttest')!;
  ok('心跳新鲜 → running（先别动）', judgeTurns(f1, now, 90 * M).state === 'running');

  const dead = { ...f1, turns: f1.turns.map((t) => ({ ...t, lastBeatAt: now - 10 * M, startedAt: now - 40 * M })) };
  ok('心跳停 10min → stale-leftover（上次被打断的现场，不拦重启但要能看见）', judgeTurns(dead as any, now, 90 * M).state === 'stale-leftover');

  const ancient = { ...f1, turns: f1.turns.map((t) => ({ ...t, lastBeatAt: now - 200 * M, startedAt: now - 200 * M })) };
  ok('超老现场仍是 stale（不误判成 running）', judgeTurns(ancient as any, now, 90 * M).state === 'stale-leftover');

  ok('空台账 → idle', judgeTurns({ bot: 'x', pid: 1, updatedAt: now, turns: [] }, now, 90 * M).state === 'idle');
  ok('无台账 → idle', judgeTurns(null, now, 90 * M).state === 'idle');
  ok('心跳新鲜阈值 > 2 个心跳周期（60s 一拍，别让偶发延迟就误判）', BEAT_FRESH_MS > 2 * M, `实际 ${BEAT_FRESH_MS / M}min`);
}

console.log('\n[3] 同一会话重复开轮：幂等，且"炖了多久"要说实话');
{
  const before = readTurnFile(rtLog, 'ttest')!.turns[0].startedAt;
  markTurn('oc_a', 'om_2', '又发一条进来');
  const f = readTurnFile(rtLog, 'ttest')!;
  ok('同 chatId 不叠加成两条', f.turns.length === 1, `实际 ${f.turns.length}`);
  ok('保留最早 startedAt（不被刷新掩盖）', f.turns[0].startedAt === before);
  ok('mid 更新为最新一条', f.turns[0].mid === 'om_2');
}

console.log('\n[4] 多会话并发：各记各的，互不覆盖');
{
  markTurn('oc_b', 'om_3', '第二个会话的活');
  const f = readTurnFile(rtLog, 'ttest')!;
  ok('两条并存', f.turns.length === 2, `实际 ${f.turns.length}`);
  ok('inflightTurns() 与盘上一致', inflightTurns().length === 2);
  clearTurn('oc_b');
  ok('清掉一条后剩一条', inflightTurns().length === 1);
  clearTurn('oc_a');
  ok('全清后盘上 turns 为空数组（区别于"文件不存在"=旧版本）', readTurnFile(rtLog, 'ttest')!.turns.length === 0);
  ok('清账不留 .tmp', !fs.existsSync(`${file}.tmp`));
  clearTurn('oc_不存在的会话'); // 不应抛
  ok('清不存在的会话不抛', true);
}

console.log('\n[5] 读盘的容错（台账坏掉绝不能拖垮 precheck / 桥启动）');
{
  fs.writeFileSync(file, '{坏的 json', 'utf-8');
  ok('畸形 JSON → null（当作没有）', readTurnFile(rtLog, 'ttest') === null);
  fs.writeFileSync(file, JSON.stringify({ bot: 'ttest', pid: 1, updatedAt: 1, turns: 'not-array' }), 'utf-8');
  ok('结构不对 → null', readTurnFile(rtLog, 'ttest') === null);
  fs.writeFileSync(file, JSON.stringify({ bot: 'ttest', pid: 1, updatedAt: 1, turns: [{ chatId: 'ok' }, { bogus: 1 }] }), 'utf-8');
  const f = readTurnFile(rtLog, 'ttest');
  ok('脏条目被剔除、好条目留下', f?.turns.length === 1 && f.turns[0].chatId === 'ok', JSON.stringify(f));
  ok('缺失字段补默认值不抛', f?.turns[0].startedAt === 0);
  fs.unlinkSync(file);
  ok('文件不存在 → null', readTurnFile(rtLog, 'ttest') === null);
  ok('没设 CTI_RT_LOG 时路径回落 cwd/logs（不会算出 undefined 路径）', turnLogFile(undefined, 'zz').endsWith(path.join('logs', 'zz-turn.json')) || turnLogFile(undefined, 'zz').includes('zz-turn.json'));
}

resetTurnLedger();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
