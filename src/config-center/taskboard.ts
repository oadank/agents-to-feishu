/**
 * taskboard —— 团队任务账（统一管理平台的"一本账"）。
 *
 * 为什么要有这个东西（2026-09-20，老大拍板"配置中心加一页做状态管理"）：
 *   13 家机器人靠群里一句 @ 就开干，没有号、没有版本、没有状态。后果全部真实发生过：
 *   同一件事被派两遍、两家改同一处互相覆盖、任务"完成"了又冒回待办、旧口径被后人当现状。
 *   本模块只做三件事：给号（幂等）、给版本（不硬盖）、给状态（不许悄悄倒退）。
 *
 * 边界（重要，别踩）：
 *   - 账本独立存 runtime/taskboard/，绝不塞进 config-store.json。
 *     config-store 是"出厂设定"（人工慢改），任务账是"正在发生什么"（机器高频写），
 *     混在一起会把配置搞脏 —— 2026-09-18 闸门状态存 JSON 被两家同时写冲掉过，教训沿用。
 *   - 本模块纯同步 + 原子写（tmp→rename），单进程内串行，不引新依赖、不引数据库。
 *   - 配置中心挂了不影响对话（与 store.ts 同一原则），任务账只是"看得见 + 拦一下"，
 *     不是所有链路的必经关卡。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 状态机 ──
// 只许朝前走：todo → doing → review → done；blocked 是 doing 的侧枝。
// 要退回，必须显式带 why，并记进 reopens（谁都不许悄悄倒回去）。
export const TASK_FLOW = ['todo', 'doing', 'review', 'done'] as const;
export type TaskStatus = (typeof TASK_FLOW)[number] | 'blocked';

const FLOW_RANK: Record<string, number> = { todo: 0, doing: 1, review: 2, done: 3, blocked: 1 };

export interface TaskEvent {
  at: string;
  by: string;
  action: string;
  from?: string;
  to?: string;
  rev: number;
  note?: string;
  /** 状态倒退的原因（正常推进为空） */
  why?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  /** 意图：说清"要动哪块、动成什么样"，不塞成品全文（对齐"传操作不传结果"） */
  intent: string;
  /** 分片归属：这件事的地盘（如 config-center / openmem / repo:xxx / doc:yyy） */
  shard: string;
  owner: string;
  status: TaskStatus;
  /** 版本号：每次改动 +1。提交时带 baseRev 对账，对不上不硬盖 */
  rev: number;
  /** 幂等号：同一件事重复提交只算一次（堵重复派活） */
  dedupeKey: string;
  /** 交付证据（文件/commit/链接），交活回填 —— 这里只放 500 字**摘要**（列表/体检口径） */
  evidence: string;
  /**
   * 票 T-0025（09-29 老大验收口径「不失忆」）：证据**只追加、不覆盖、不静默砍尾**的全文轨。
   * 旧口径每次回填把上一条 evidence 整个盖掉，且第 501 个字起**无声丢弃** —— 09-29 一晚我自己
   * 中两次（540 字与 517 字各被砍掉尾巴，指针那句直接没了），codex 交 T-0022 也被迫自砍到 500。
   * 摘要仍留 evidence（UI 与 audit 不用改），全文进这里：列表与更新返回里剥掉，
   * 只在 GET /api/tasks/<id> 详情口下发，防 2000 条 × 轨迹撑爆载荷。
   */
  evidenceTrail?: { at: string; by: string; text: string }[];
  /** 状态倒退次数与原因 */
  reopens: { at: string; by: string; from: string; to: string; why: string }[];
  createdAt: string;
  updatedAt: string;
  history: TaskEvent[];
}

interface TaskBoard {
  /** 全局版本号：任何一条任务变化都 +1（页面轮询靠它判断要不要重拉） */
  globalRev: number;
  seq: number;
  tasks: TaskRecord[];
}

// ── 落盘 ──

export function taskboardDir(home = process.env.CTI_USER_HOME || os.homedir()): string {
  return path.join(home, '.agents-to-feishu', 'runtime', 'taskboard');
}

const MAX_TASKS = 2000; // 只保留最近 2000 条，防账本无限膨胀（历史走 events.jsonl）

function boardPath(): string { return path.join(taskboardDir(), 'tasks.json'); }
function eventsPath(): string { return path.join(taskboardDir(), 'events.jsonl'); }
function lockPath(): string { return path.join(taskboardDir(), 'tasks.lock'); }

function emptyBoard(): TaskBoard { return { globalRev: 0, seq: 0, tasks: [] }; }

function loadBoard(): TaskBoard {
  const p = boardPath();
  if (!fs.existsSync(p)) return emptyBoard();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<TaskBoard>;
    return {
      globalRev: Number(parsed.globalRev) || 0,
      seq: Number(parsed.seq) || 0,
      tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as TaskRecord[]).slice(-MAX_TASKS) : [],
    };
  } catch (e) {
    // 账本读坏 = 直接报错，绝不静默清空（清一次等于把全团队的活抹了）
    throw new Error(`任务账读取失败（已保留原文件，未清空）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 原子写：tmp → rename。写坏不会把原账本拖下水 */
function saveBoard(b: TaskBoard): void {
  const dir = taskboardDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = boardPath();
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(b, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, p);
}

/** 追加事件流水（只增不改，事后能考古"谁在什么时候动了哪一步"） */
function appendEvent(task: TaskRecord, ev: TaskEvent): void {
  try {
    fs.mkdirSync(taskboardDir(), { recursive: true });
    fs.appendFileSync(eventsPath(), `${JSON.stringify({ taskId: task.id, ...ev })}\n`, 'utf-8');
  } catch { /* 流水写失败不拦主流程（账本本身已落盘） */ }
}

/**
 * 独占锁：Node 单进程本不需要，但 13 家都往这儿写，防止有人另起一个
 * 配置中心实例（开发口 / 生产口）同时改同一份账。拿不到锁直接拒，不排队硬写。
 */
function withLock<T>(fn: () => T): T {
  const dir = taskboardDir();
  fs.mkdirSync(dir, { recursive: true });
  const lp = lockPath();
  const tryGrab = (): boolean => {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch { return false; }
  };
  let held = tryGrab();
  if (!held) {
    const ageMs = Date.now() - (fs.statSync(lp, { throwIfNoEntry: false })?.mtime.getTime() ?? 0);
    if (ageMs < 15_000) throw new Error('任务账正被另一个写入方占用（稍后重试，本次不硬写）');
    // [T-0031 批三] 陈旧锁：清掉后必须【重新抢锁】再写。旧写法 rmSync 后直接落到 fn()，
    // held 仍是 false（既不持锁又裸跑写）——两个进程同时撞陈旧锁时，A 删锁未建的瞬间
    // B 的 wx 可能抢中，两边一起 loadBoard→改→saveBoard，读改写丢更新，正是这把锁要防的。
    try { fs.rmSync(lp, { force: true }); } catch { /* 清理失败下面重抢也会失败，转而拒 */ }
    held = tryGrab();
    if (!held) throw new Error('任务账锁刚被其他写入方重新抢占（稍后重试，本次不硬写）');
  }
  try {
    return fn();
  } finally {
    if (held) { try { fs.rmSync(lp, { force: true }); } catch { /* 忽略 */ } }
  }
}

// ── 结果类型（HTTP 层直接 json 出去） ──

export interface BoardResult {
  ok: boolean;
  /** 冲突/拒绝时给原因，前端原样显示 */
  error?: string;
  /** 409 类：版本对不上或分片被人占着 */
  conflict?: boolean;
  /** 幂等命中：重复派活，返回已有那条，不新建 */
  duplicated?: boolean;
  globalRev?: number;
  task?: TaskRecord;
  tasks?: TaskRecord[];
  /** 仅 boardSummary 返回：各状态计数 / 撞车 / 卡住 / 无证据 / 回炉 */
  counts?: Record<string, number>;
  shardClash?: { shard: string; ids: string[] }[];
  stale?: { id: string; title: string; owner: string; hours: number }[];
  noEvidence?: { id: string; title: string; owner: string }[];
  reopened?: { id: string; title: string; count: number; last: TaskRecord['reopens'][number] }[];
  /**
   * 票 T-0025：写成功了但有代价（证据超摘要上限被折进全文轨、或超全文上限尾部真的丢弃），
   * **必须回给调用方看**，不再像以前那样静默砍完还回 ok:true。
   */
  warn?: string;
  /** 更新返回里带上全文轨条数（正文不下发，取详情口），让调用方知道"东西都在" */
  evidenceTrailCount?: number;
}

const now = () => new Date().toISOString();
const clampText = (s: unknown, n: number) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n);

// ── 票 T-0025：证据双轨（摘要进列表，全文进轨迹，超限必出声） ──
const EVIDENCE_HEAD_CAP = 500;
const EVIDENCE_FULL_CAP = 2000;
const EVIDENCE_TRAIL_KEEP = 10;

/** 列表/更新返回里剥掉全文轨（只在详情口给），避免把载荷撑爆 */
function withoutTrail(t: TaskRecord): TaskRecord {
  if (!t.evidenceTrail || t.evidenceTrail.length === 0) return t;
  const c: TaskRecord = { ...t };
  delete c.evidenceTrail;
  return c;
}

function find(b: TaskBoard, id: string): TaskRecord | undefined {
  return b.tasks.find((t) => t.id === id);
}

function touch(b: TaskBoard, t: TaskRecord, ev: Omit<TaskEvent, 'at' | 'rev'>): void {
  const full: TaskEvent = { at: now(), rev: t.rev, ...ev };
  t.updatedAt = full.at;
  t.history = [...t.history.slice(-80), full];
  b.globalRev += 1;
  appendEvent(t, full);
}

/** 分片抢占判定：同一块地盘，只允许一条处在 doing */
function shardBusy(b: TaskBoard, shard: string, exceptId: string): TaskRecord | undefined {
  if (!shard) return undefined;
  return b.tasks.find((t) => t.id !== exceptId && t.shard === shard && t.status === 'doing');
}

// ── 对外动作 ──

export interface CreateInput {
  title?: string; intent?: string; shard?: string; owner?: string;
  dedupeKey?: string; status?: TaskStatus; by?: string;
}

/** 建账（派活必须先拿号）。幂等号命中已有任务 → 返回旧那条 + duplicated，不再新建 */
export function createTask(input: CreateInput): BoardResult {
  const title = clampText(input.title, 200);
  if (!title) return { ok: false, error: '建账被拒：title 不能空（一句话说清要干什么）' };
  const shard = clampText(input.shard, 80).toLowerCase();
  if (!shard) return { ok: false, error: '建账被拒：shard（地盘）不能空 —— 不知道动哪块，就判断不了撞不撞车' };
  const owner = clampText(input.owner, 40) || 'unassigned';
  const dedupeKey = clampText(input.dedupeKey, 120);
  const intent = clampText(input.intent, 1000);
  const by = clampText(input.by, 40) || owner;

  return withLock(() => {
    const b = loadBoard();
    if (dedupeKey) {
      const hit = b.tasks.find((t) => t.dedupeKey === dedupeKey);
      if (hit) {
        touch(b, hit, { by, action: 'dedupe-hit', note: `幂等号 ${dedupeKey} 已存在，未重复建账` });
        saveBoard(b);
        return { ok: true, duplicated: true, globalRev: b.globalRev, task: hit };
      }
    }
    b.seq += 1;
    const t: TaskRecord = {
      id: `T-${String(b.seq).padStart(4, '0')}`,
      title, intent, shard, owner,
      status: TASK_FLOW.includes(input.status as (typeof TASK_FLOW)[number]) ? (input.status as TaskStatus) : 'todo',
      rev: 1, dedupeKey, evidence: '', reopens: [],
      createdAt: now(), updatedAt: now(),
      history: [],
    };
    t.history = [];
    b.tasks.push(t);
    touch(b, t, { by, action: 'create', to: t.status, note: `建账：${t.shard} 交给 ${t.owner}` });
    saveBoard(b);
    return { ok: true, globalRev: b.globalRev, task: t };
  });
}

/** 领活：todo → doing。同分片已被别人占着 → 409 让路，不双开 */
export function claimTask(id: string, input: { by?: string; baseRev?: number; takeOver?: boolean }): BoardResult {
  const by = clampText(input.by, 40);
  if (!by) return { ok: false, error: '领活被拒：by（谁来干）不能空' };
  return withLock(() => {
    const b = loadBoard();
    const t = find(b, id);
    if (!t) return { ok: false, error: `找不到任务 ${id}` };
    const revErr = checkRev(t, input.baseRev);
    if (revErr) return revErr;
    const busy = shardBusy(b, t.shard, t.id);
    if (busy && !input.takeOver) {
      return {
        ok: false, conflict: true, task: t,
        error: `分片冲突：${t.shard} 已有 ${busy.id}（${busy.title}）在进行中，负责人 ${busy.owner}。要么并成一件事，要么换分片，要么确认让 ${busy.id} 交棒后带 takeOver 重提。`,
      };
    }
    if (busy && input.takeOver) {
      busy.status = 'blocked';
      busy.reopens.push({ at: now(), by, from: 'doing', to: 'blocked', why: `被 ${t.id} 接管（同分片 ${t.shard}）` });
      // [T-0031 批三] 被接管任务必须推版本号：否则被让路方手里 baseRev=旧 rev，随后
      // updateTask 的 checkRev 照样放行 → 基于已失效状态硬盖，乐观锁对"被接管"这次变更全盲。
      busy.rev += 1;
      touch(b, busy, { by, action: 'yield', from: 'doing', to: 'blocked', note: `同分片让路给 ${t.id}` });
    }
    const from = t.status;
    if (from === 'done' || from === 'review') {
      return { ok: false, error: `状态机拒绝：${id} 已在 ${from}，不许回炉重领（要重开请走 update 并写明 why）` };
    }
    t.status = 'doing';
    t.rev += 1;
    // [09-20 看板缺陷根治] 建账占位历来是中文'待领'，旧判定只认 'unassigned' ⇒ claim 永不落名。
    if (!t.owner || t.owner === 'unassigned' || t.owner === '待领') t.owner = by;
    touch(b, t, { by, action: 'claim', from, to: 'doing' });
    saveBoard(b);
    return { ok: true, globalRev: b.globalRev, task: t };
  });
}

/** 交活 / 推进 / 回填证据。带 baseRev 则对版本，对不上不硬盖 */
export interface UpdateInput {
  by?: string; baseRev?: number; status?: TaskStatus; note?: string;
  evidence?: string; intent?: string; title?: string; owner?: string; shard?: string;
  /** 状态倒退（done→doing）必须带，否则拒 */
  why?: string;
}

export function updateTask(id: string, input: UpdateInput): BoardResult {
  const by = clampText(input.by, 40) || 'unknown';
  return withLock(() => {
    const b = loadBoard();
    const t = find(b, id);
    if (!t) return { ok: false, error: `找不到任务 ${id}` };
    const revErr = checkRev(t, input.baseRev);
    if (revErr) return revErr;

    const next = input.status;
    if (next && !Object.hasOwn(FLOW_RANK, next)) return { ok: false, error: `不认的状态：${next}（可用 ${Object.keys(FLOW_RANK).join('/')}）` };
    if (next) {
      const cur = FLOW_RANK[t.status];
      const tgt = FLOW_RANK[next];
      if (tgt < cur && !(next === 'blocked' && t.status === 'doing')) {
        const why = clampText(input.why, 300);
        if (!why) return { ok: false, error: `状态倒退被拦：${t.status} → ${next} 必须带 why（为什么退回去），不许悄悄倒` };
        t.reopens.push({ at: now(), by, from: t.status, to: next, why });
      }
    }
    const changed: string[] = [];
    if (next && next !== t.status) { changed.push(`状态 ${t.status}→${next}`); t.status = next; }
    const title = clampText(input.title, 200); if (title) { changed.push('改标题'); t.title = title; }
    const intent = clampText(input.intent, 1000); if (intent) { changed.push('改意图'); t.intent = intent; }
    const owner = clampText(input.owner, 40); if (owner) { changed.push(`换人→${owner}`); t.owner = owner; }
    const shard = clampText(input.shard, 80).toLowerCase(); if (shard) { changed.push(`换地盘→${shard}`); t.shard = shard; }
    // [票 T-0025 09-29] 证据不再「覆盖上一条 + 第 501 字起静默丢弃」。
    // 摘要（≤500）留在 evidence 供列表/体检用；全文进 evidenceTrail，**只追加**。
    // 超限时在返回体明说 warn —— 以前 ok:true 却悄悄砍尾，交活的人以为自己写全了（09-29 我自己中两次）。
    let evWarn = '';
    const evRaw = typeof input.evidence === 'string' ? input.evidence.replace(/\r/g, '').trim() : '';
    if (evRaw) {
      const head = evRaw.slice(0, EVIDENCE_HEAD_CAP);
      const full = evRaw.slice(0, EVIDENCE_FULL_CAP);
      const trail = t.evidenceTrail ?? [];
      const sameAsLast = trail.length > 0 && trail[trail.length - 1].text === full;
      if (!sameAsLast) t.evidenceTrail = [...trail, { at: now(), by, text: full }].slice(-EVIDENCE_TRAIL_KEEP);
      t.evidence = head;
      changed.push(sameAsLast ? '回填证据(与轨迹末条同文，未重复记)' : `回填证据(全文轨第 ${(t.evidenceTrail ?? []).length} 条)`);
      const n = (t.evidenceTrail ?? []).length;
      if (evRaw.length > EVIDENCE_FULL_CAP) {
        evWarn = `evidence 原文 ${evRaw.length} 字，超全文上限 ${EVIDENCE_FULL_CAP} 字的尾部 ${evRaw.length - EVIDENCE_FULL_CAP} 字**已丢弃** —— 请改写「结论+指针」，成品全文放产物文件（本次截尾原因已记入返回，不再静默）。`;
      } else if (evRaw.length > EVIDENCE_HEAD_CAP) {
        evWarn = `evidence 原文 ${evRaw.length} 字：列表摘要只留前 ${EVIDENCE_HEAD_CAP} 字，但**全文 ${full.length} 字已存进全文轨第 ${n} 条，一个字没丢**，取 GET /api/tasks/${t.id} 可看。`;
      }
    }
    if (next === 'done' && !t.evidence && !input.evidence) {
      return { ok: false, error: '交活被拒：标 done 必须带 evidence（证据：文件/commit/链接），空口说完成不算完' };
    }
    // 同文重填 = 没有新信息：不推 rev（免得白白让别人手里的 baseRev 失效）、不落历史噪音，
    // 但照旧回 ok + warn，让调用方知道自己那次没写坏。混合了别的字段（如同时改状态）则照常走。
    const onlySameEvidence = changed.length === 1 && changed[0].startsWith('回填证据(与轨迹末条同文') && !input.note;
    if ((!changed.length && !input.note) || onlySameEvidence) {
      return {
        ok: true, globalRev: b.globalRev, task: withoutTrail(t),
        ...(evWarn ? { warn: evWarn } : {}),
        ...((t.evidenceTrail?.length ?? 0) > 0 ? { evidenceTrailCount: t.evidenceTrail!.length } : {}),
      };
    }

    t.rev += 1;
    touch(b, t, { by, action: 'update', from: undefined, to: next, note: `${changed.join('、')}${input.note ? ` | ${clampText(input.note, 300)}` : ''}${input.why ? ` | 倒退原因：${clampText(input.why, 200)}` : ''}` });
    saveBoard(b);
    return {
      ok: true, globalRev: b.globalRev, task: withoutTrail(t),
      ...(evWarn ? { warn: evWarn } : {}),
      ...((t.evidenceTrail?.length ?? 0) > 0 ? { evidenceTrailCount: t.evidenceTrail!.length } : {}),
    };
  });
}

function checkRev(t: TaskRecord, baseRev?: number): BoardResult | null {
  // [T-0031 批三] 只有【没带 baseRev】(undefined/null) 才跳过对账；传了但不是有限数
  // （'abc'/NaN/Infinity/对象）是调用方 bug 或被篡改的载荷，必须显式拒——旧写法用
  // Number.isNaN(Number(baseRev)) 把非法值当"没带"静默放行，等于对非法输入关掉乐观锁。
  if (baseRev === undefined || baseRev === null) return null;
  const n = Number(baseRev);
  if (!Number.isFinite(n)) {
    return { ok: false, conflict: true, task: t, error: `baseRev 非法（${JSON.stringify(baseRev)}）：要带数字版本号，或不带（不校验）——不许拿非法值静默绕过对账` };
  }
  if (n === t.rev) return null;
  return {
    ok: false, conflict: true, task: t,
    error: `版本对不上：${t.id} 你基于第 ${baseRev} 版改，现在已经是第 ${t.rev} 版。本次未落账 —— 先看 current 再决定让路还是换算后重提（别硬盖别人的改动）。`,
  };
}

/** 查询（可按状态/负责人/地盘过滤）+ 全局版本号 */
export function listTasks(q: { status?: string; owner?: string; shard?: string; limit?: number } = {}): BoardResult {
  const b = loadBoard();
  let tasks = b.tasks.slice().reverse();
  if (q.status) tasks = tasks.filter((t) => t.status === q.status);
  if (q.owner) tasks = tasks.filter((t) => t.owner === q.owner);
  if (q.shard) { const sh = q.shard.toLowerCase(); tasks = tasks.filter((t) => t.shard === sh); }
  const limit = Math.max(1, Math.min(Number(q.limit) || 200, MAX_TASKS));
  // 票 T-0025：列表不下发全文轨（详情口 GET /api/tasks/<id> 才给），2000 条也不撑爆载荷
  return { ok: true, globalRev: b.globalRev, tasks: tasks.slice(0, limit).map(withoutTrail) };
}

/** 体检：谁抢同一块地盘、谁卡太久、谁标完成没证据 */
export function boardSummary(): BoardResult {
  const b = loadBoard();
  const doing = b.tasks.filter((t) => t.status === 'doing');
  const byShard = new Map<string, TaskRecord[]>();
  for (const t of doing) byShard.set(t.shard, [...(byShard.get(t.shard) ?? []), t]);
  const shardClash = [...byShard.entries()].filter(([, l]) => l.length > 1)
    .map(([shard, l]) => ({ shard, ids: l.map((t) => `${t.id}@${t.owner}`) }));
  const staleMs = 6 * 3600_000;
  const stale = doing.filter((t) => Date.now() - Date.parse(t.updatedAt) > staleMs)
    .map((t) => ({ id: t.id, title: t.title, owner: t.owner, hours: Math.round((Date.now() - Date.parse(t.updatedAt)) / 3600_000) }));
  const noEvidence = b.tasks.filter((t) => t.status === 'done' && !t.evidence).slice(-20)
    .map((t) => ({ id: t.id, title: t.title, owner: t.owner }));
  const reopened = b.tasks.filter((t) => t.reopens.length).slice(-20)
    .map((t) => ({ id: t.id, title: t.title, count: t.reopens.length, last: t.reopens[t.reopens.length - 1] }));
  return {
    ok: true,
    globalRev: b.globalRev,
    counts: {
      total: b.tasks.length,
      todo: b.tasks.filter((t) => t.status === 'todo').length,
      doing: doing.length,
      review: b.tasks.filter((t) => t.status === 'review').length,
      done: b.tasks.filter((t) => t.status === 'done').length,
      blocked: b.tasks.filter((t) => t.status === 'blocked').length,
    },
    shardClash, stale, noEvidence, reopened,
  };
}

export function getTask(id: string): BoardResult {
  const b = loadBoard();
  const t = find(b, id);
  return t ? { ok: true, globalRev: b.globalRev, task: t } : { ok: false, error: `找不到任务 ${id}` };
}
