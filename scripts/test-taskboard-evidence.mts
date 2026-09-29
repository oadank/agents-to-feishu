/**
 * 票 T-0025 · 账本证据不再「覆盖上一条 + 第 501 字起静默丢弃」的单测。
 *
 * 跑法：npx tsx scripts/test-taskboard-evidence.mts
 * 隔离：全程用临时 CTI_USER_HOME，绝不碰 runtime/taskboard/tasks.json 那本真账。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't0025-evidence-'));
process.env.CTI_USER_HOME = tmp;

const { createTask, updateTask, getTask, listTasks } = await import('../src/config-center/taskboard.js');

let pass = 0;
let fail = 0;
const ok = (cond: unknown, label: string, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label} ${extra}`); }
};

try {
  const mk = (t: string) => {
    const r = createTask({ title: t, intent: '单测夹具', shard: 'unittest/evidence', by: 'dsh', dedupeKey: `t0025-${t}` });
    const id = (r as any).task?.id as string;
    if (!id) throw new Error(`建票失败: ${JSON.stringify(r).slice(0, 200)}`);
    return id;
  };

  console.log('【1】超 500 字：摘要留 500，全文进轨迹，返回必须出声');
  const id1 = mk('over-head');
  const long = `结论句。${'指针与细节'.repeat(120)}`; // > 500 且 < 2000
  const r1 = updateTask(id1, { by: 'dsh', evidence: long }) as any;
  ok(r1.ok === true, '写入成功', JSON.stringify(r1).slice(0, 160));
  ok(r1.task.evidence.length === 500, '摘要恰好 500 字', `实得 ${r1.task.evidence.length}`);
  ok(typeof r1.warn === 'string' && r1.warn.includes('一个字没丢'), '返回体有 warn 且明说没丢', `warn=${r1.warn}`);
  ok(r1.evidenceTrailCount === 1, '返回告知轨迹条数=1', `实得 ${r1.evidenceTrailCount}`);
  ok(r1.task.evidenceTrail === undefined, '更新返回里不下发全文轨（省载荷）');
  const d1 = getTask(id1) as any;
  const trail1 = d1.task.evidenceTrail ?? [];
  ok(trail1.length === 1, '详情口取到轨迹 1 条');
  ok(trail1[0].text.length === long.length, '轨迹存的是全文，一字不裁', `全文${long.length} vs 轨迹${trail1[0].text.length}`);
  ok(trail1[0].by === 'dsh', '轨迹记了是谁写的');

  console.log('【2】再回填：旧的不能被覆盖（这是本票的正题）');
  const second = '第二次交账：换了个结论，前一次的证据必须还在。';
  const r2 = updateTask(id1, { by: 'codex', baseRev: r1.task.rev, evidence: second }) as any;
  ok(r2.ok === true, '第二次写入成功', JSON.stringify(r2).slice(0, 160));
  ok(r2.task.evidence === second, '摘要字段换成最新一条');
  const d2 = getTask(id1) as any;
  ok((d2.task.evidenceTrail ?? []).length === 2, '轨迹累积到 2 条');
  ok((d2.task.evidenceTrail ?? [])[0].text === long, '第一条全文仍在，没被第二次覆盖');
  ok(!r2.warn, '未超限时不该有多余的 warn', `warn=${r2.warn}`);

  console.log('【3】同文重复提交：不重复记轨迹');
  const r3 = updateTask(id1, { by: 'codex', baseRev: r2.task.rev, evidence: second }) as any;
  ok(r3.evidenceTrailCount === 2, '与末条同文 → 不增长', `实得 ${r3.evidenceTrailCount}`);
  const d3 = getTask(id1) as any;
  ok(d3.task.rev === r2.task.rev, '同文回填不改版本号（没新信息不该推 rev）', `rev ${d3.task.rev} vs ${r2.task.rev}`);

  console.log('【4】超 2000 字全文上限：必须点名"尾部已丢弃"，不再静默');
  const id2 = mk('over-full');
  const huge = '甲'.repeat(2400);
  const r4 = updateTask(id2, { by: 'dsh', evidence: huge }) as any;
  ok(typeof r4.warn === 'string' && r4.warn.includes('已丢弃'), 'warn 明说尾部丢弃', `warn=${String(r4.warn).slice(0, 90)}`);
  const d4 = getTask(id2) as any;
  ok(d4.task.evidenceTrail[0].text.length === 2000, '轨迹按 2000 截（并已在 warn 里声明）');

  console.log('【5】轨迹上限：连投 12 次只留最后 10 条，且都是新那批');
  const id3 = mk('trail-cap');
  let rev = (getTask(id3) as any).task.rev;
  for (let i = 1; i <= 12; i++) {
    const rr = updateTask(id3, { by: 'dsh', baseRev: rev, evidence: `第 ${i} 次交账：内容各不相同 ${'x'.repeat(30)}${i}` }) as any;
    rev = rr.task.rev;
  }
  const d5 = getTask(id3) as any;
  ok((d5.task.evidenceTrail ?? []).length === 10, '轨迹封顶 10 条', `实得 ${d5.task.evidenceTrail?.length}`);
  ok(d5.task.evidenceTrail[9].text.includes('12'), '末条是第 12 次（最新的在）');
  ok(d5.task.evidenceTrail[0].text.includes('3'), '首条滑到第 3 次（最旧两条被挤出，符合封顶）');

  console.log('【6】列表口不下发全文轨，详情口下发');
  const ls = listTasks({ shard: 'unittest/evidence' }) as any;
  const anyWithTrail = (ls.tasks ?? []).some((t: any) => t.evidenceTrail !== undefined);
  ok(!anyWithTrail, '列表里每条都剥掉了 evidenceTrail');
  ok((ls.tasks ?? []).length >= 3, `列表能查到夹具票（${(ls.tasks ?? []).length} 条）`);
  const det = getTask(id3) as any;
  ok(Array.isArray(det.task.evidenceTrail), '详情口能取到轨迹');

  console.log('【7】存盘对象没被动过刀（withoutTrail 只影响返回，不影响账本）');
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, '.agents-to-feishu', 'runtime', 'taskboard', 'tasks.json'), 'utf-8'));
  const stored = raw.tasks.find((t: any) => t.id === id3);
  ok(Array.isArray(stored?.evidenceTrail) && stored.evidenceTrail.length === 10, '盘上真账仍有轨迹 10 条');

  console.log('【8】老票（无轨迹字段）不受影响：读得到、写得动');
  const legacyId = mk('legacy');
  const lr = updateTask(legacyId, { by: 'dsh', evidence: '短证据不超限' }) as any;
  ok(lr.ok === true && lr.task.evidence === '短证据不超限' && !lr.warn, '短证据：原样进、不吭声');
  ok(lr.evidenceTrailCount === 1, '短证据也照样入轨（可追溯）', `实得 ${lr.evidenceTrailCount}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉就算了，反正是 tmp */ }
  const residue = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('t0025-evidence-'));
  if (residue.length) console.log(`⚠ 临时目录残留 ${residue.length} 个（未阻塞判定）`);
}
