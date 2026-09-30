/**
 * 消息号幂等台账（msg-dedup）—— 治"飞书把同一条消息推两遍"的第二道闸。
 *
 * ── 为什么需要它（2026-09-30 dsh 实测定罪，证据链三段）────────────────────────
 * 1) 平台侧：飞书对事件订阅有**重推机制**——它没及时拿到"已收到"的回执，就把同一条事件
 *    再推一遍（官方《事件订阅》FAQ 第 8 条：「为什么我收到了多次消息推送？可能是重推
 *    机制导致的」，并要求消费方按事件唯一号自行幂等）。
 * 2) SDK 侧：`@larksuiteoapi/node-sdk` 的 `handleEventData` 是
 *    `const respPayload={code:ok}` → **`yield eventDispatcher.invoke(...)`** → 才 `sendMessage(ack)`。
 *    也就是**回执必须等我们注册的回调返回**，回调跑多久，平台就等多久。
 * 3) 我们侧：`im.message.receive_v1` 回调里 `await engine.handleText(...)` 把整轮对话跑完才返回。
 *    ⇒ 只要一轮 > 平台超时点，就**必然**被重推。
 * 实测（2026-09-29 23:00~24:00 四家日志 43 对）：第二遍全部落在 **18.5~20.3 秒**（中位 19.3s），
 * 无一例外；而毫秒级返回的 `/help` **一条都没被重推** ⇒ 因果坐实。
 *
 * ── 本模块的定位 ────────────────────────────────────────────────────────────
 * 主修在 index.ts：**先给平台回"收到了"，活丢后台跑**（不再拖回执）。
 * 这里是**兜底**：万一将来又出现别的双重来源（多连接、平台改策略、人工重发），
 * 同一条消息仍然只会被处理一次。旧实现是**内存 Set + 按条数 LRU**，有两个真窟窿：
 *   ① 进程一重启就清空 ⇒ 正好卡在重启窗口的第二遍被当成新消息（09-29「压缩连跑两轮」即此）；
 *   ② 命令消息（/new 之类）当初被**故意豁免去重**，重推会真执行两遍（/new 两遍 = 连清两次记忆）。
 * 现在：状态落盘，命令也纳入判重——但失败会自动撤销标记，重投仍能补做一次（不吞命令）。
 *
 * 每家 bot 独立一份文件（13 个进程各写各的，绝不共享，避免互相覆盖）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 状态：I=正在处理（in-flight） D=已处理完（done） */
type Mark = 'I' | 'D';
interface Entry { st: Mark; ts: number }

/** 一条消息号在台账里最长存活：15 分钟。平台重推只发生在几十秒内，15 分钟足够富余，
 *  又能保证长期运行不无限膨胀（老条目按 TTL 清，不再"按条数把最新的挤掉老的"）。 */
const TTL_MS = 15 * 60 * 1000;
/** 条数硬上限（防极端刷屏把内存吃掉）：超了先清最老的，与 TTL 双保险。 */
const MAX_ENTRIES = 20000;
/** 落盘节流：脏了最多 3 秒写一次，避免每条消息都同步写盘。 */
const FLUSH_DEBOUNCE_MS = 3000;

const botName = process.env.CTI_BOT || 'default';
const file = path.join(
  process.env.CTI_USER_HOME || os.homedir(),
  '.agents-to-feishu', 'runtime', `seen-msgs-${botName}.json`,
);

const table = new Map<string, Entry>();
let loaded = false;
let dirty = false;
let stats = { loadedFromDisk: 0, pruned: 0 };

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: Array<[string, Entry]> };
    const now = Date.now();
    for (const [id, e] of raw.entries ?? []) {
      if (!id || !e || typeof e.ts !== 'number') continue;
      if (now - e.ts > TTL_MS) { stats.pruned++; continue; }   // 过期条目不复活
      table.set(id, { st: e.st === 'D' ? 'D' : 'I', ts: e.ts });
    }
    stats.loadedFromDisk = table.size;
  } catch { /* 首次运行/文件损坏：空表起步，不影响收消息 */ }
}

function prune(): void {
  const now = Date.now();
  for (const [id, e] of table) {
    if (now - e.ts > TTL_MS) table.delete(id);
  }
  if (table.size > MAX_ENTRIES) {
    const cut = table.size - MAX_ENTRIES;
    let i = 0;
    for (const id of table.keys()) { table.delete(id); if (++i >= cut) break; }
  }
}

let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

export function flush(): void {
  if (!dirty) return;
  dirty = false;
  prune();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, bot: botName, at: new Date().toISOString(), entries: [...table.entries()] }));
    fs.renameSync(tmp, file);
  } catch (e) {
    // 落盘失败绝不阻断收消息：内存表照常生效，退化成旧行为（重启即失）。
    console.warn(`[msg-dedup] 台账落盘失败（不影响处理，仅重启后失去幂等兜底）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 登记并开始处理一条消息号。
 * @returns 'new' 应当处理；'inflight' 同一消息号正被处理中，跳过；'done' 已处理完，跳过。
 */
export function beginId(id: string): 'new' | 'inflight' | 'done' {
  if (!id) return 'new';
  ensureLoaded();
  const hit = table.get(id);
  if (hit) {
    // in-flight 卡死超过 TTL 视作丢了（进程被杀等），放行重投补做一次，别永久哑火
    if (Date.now() - hit.ts > TTL_MS) table.delete(id);
    else return hit.st === 'D' ? 'done' : 'inflight';
  }
  table.set(id, { st: 'I', ts: Date.now() });
  scheduleFlush();
  return 'new';
}

/** 处理成功收尾：标 done（重投到此为止都会被拦住）。 */
export function finishId(id: string): void {
  if (!id) return;
  const hit = table.get(id);
  if (hit) { hit.st = 'D'; hit.ts = Date.now(); scheduleFlush(); }
}

/**
 * 处理失败撤销标记：让平台的下一次重投（或人工重发）还能真正补做一次。
 * 这是"命令也纳入判重"的安全前提——否则首轮异常 = 这条命令被吞掉。
 */
export function failId(id: string): void {
  if (!id) return;
  if (table.delete(id)) scheduleFlush();
}

export function dedupStats(): { live: number; file: string; loadedFromDisk: number } {
  ensureLoaded();
  return { live: table.size, file, loadedFromDisk: stats.loadedFromDisk };
}

process.on('beforeExit', () => { flush(); });
