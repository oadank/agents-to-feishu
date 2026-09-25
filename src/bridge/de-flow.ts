/**
 * [2026-09-25 老大定调] 飞书侧 /de 的全流程：读本会话历史 → 本地判断+起草 3 条 → 三选一卡片
 * → 点哪条就用 **user 令牌把原文发回本会话**（不加署名，老大显式豁免）。
 *
 * 独立性：只用本仓配置（config-store.json 的 de 段）+ 飞书开放接口 + lark-cli，
 * 不 import dsh、不打 dsh-web 端口。dsh 挂了这里照常跑。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import { normalize as normPath } from 'node:path';
import type { DeConfig } from '../config-center/store.js';
import { localDe, type DeHistoryTurn, type DeResult } from './local-engines.js';

const execFileAsync = promisify(execFile);
const LARK_RUN_JS = normPath('C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js');
const LARK_NODE = normPath('C:\\Program Files\\nodejs\\node.exe');

export interface DeFeishuClient {
  /** FeishuClient 上是 private getTenantToken()：TS 私有只在编译期，运行时方法存在，所以这里按真实名字声明 */
  getTenantToken(): Promise<string>;
  sendCardHttp(chatId: string, card: unknown): Promise<string | null>;
}

interface Pending { chatId: string; texts: string[]; used: Record<number, string>; at: number; cardMsgId: string | null }
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 30 * 60_000;

function gcPending() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
}

/** 卡片结构（飞书卡片 1.0：header + markdown 段 + 三个 action 按钮，点选即回传 value.callback） */
export function buildDeCard(uid: string, chatId: string, res: DeResult): unknown {
  const j = res.judge as Record<string, unknown>;
  const head = `局面：${String(j.intent ?? '?')}｜风险 ${String(j.risk ?? '?')}｜量级 ${String(j.scope ?? '?')}`;
  const notes = res.context?.note ? `\n（${res.context.note}）` : '';
  const degraded = res.degraded.judge || res.degraded.rank ? '\n⚠ 这次判断/排序没走通，按降级出稿，自己看一眼再发' : '';
  const items = res.candidates.map((c, i) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: '发第 ' + (i + 1) + ' 条' + (c.role ? '（' + c.role + '）' : '') },
    type: i === 0 ? 'primary' : 'default',
    action: { tag: 'callback', value: { callback: `de:${chatId}:${uid}:${i}` } },
  }));
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `/de 回复预选 · 三选一` }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${head}**${notes}${degraded}` } },
      { tag: 'hr' },
      ...res.candidates.map((c, i) => ({ tag: 'div', text: { tag: 'lark_md', content: '**' + (i + 1) + '. ' + (c.role ? '[' + c.role + '] ' : '') + c.text + '**' } })),
      { tag: 'hr' },
      { tag: 'action', actions: items },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '点一条即以其身份原文发出，不加水印；同一张卡每条只能发一次' }] },
    ],
  };
}

/** 以「用户身份」把原文发进会话：走 lark-cli 的 --as user（与 send_as_user 同一条链路）。 */
async function sendAsUserToChat(chatId: string, text: string): Promise<void> {
  if (!fs.existsSync(LARK_RUN_JS)) throw new Error('lark-cli 未安装，无法以你的身份发送');
  const args = [LARK_RUN_JS, 'im', '+messages-send', '--chat-id', chatId, '--text', text, '--as', 'user'];
  const r = await execFileAsync(LARK_NODE, args, { timeout: 60_000, encoding: 'utf-8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const out = String(r.stdout ?? '');
  const i = out.lastIndexOf('\n{');
  const j = JSON.parse(i >= 0 ? out.slice(i + 1) : out || '{}') as { data?: { message_id?: string }; code?: number; msg?: string };
  if (j.code !== undefined && j.code !== 0) throw new Error(`以用户身份发送失败 code=${j.code} ${j.msg ?? ''}`);
  if (!j?.data?.message_id) throw new Error('以用户身份发送无回执 message_id');
}

/** 读本会话最近 N 条文本消息（bot 身份即可读自己所在的会话）。app 发的算助手，其余算用户。 */
export async function fetchHistory(client: DeFeishuClient & { getAppId?: () => Promise<string> }, chatId: string, count: number): Promise<DeHistoryTurn[]> {
  const tk = await client.getTenantToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&sort_type=ByCreateTimeDesc&page_size=${Math.min(50, Math.max(1, count))}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tk}` }, signal: AbortSignal.timeout(20_000) });
  const j = (await r.json()) as { code?: number; msg?: string; data?: { items?: Array<{ msg_type?: string; sender?: { sender_type?: string }; body?: { content?: string } }> } };
  if (!r.ok || (j.code !== undefined && j.code !== 0)) throw new Error(`读会话历史失败 code=${j.code} ${j.msg ?? ''}`);
  const items = j.data?.items ?? [];
  const turns: DeHistoryTurn[] = [];
  for (const it of items) {
    if ((it.msg_type ?? '') !== 'text') continue;
    let text = '';
    try { text = String(JSON.parse(it.body?.content ?? '{}').text ?? ''); } catch { text = ''; }
    text = text.trim();
    if (text === '') continue;
    turns.push({ role: it.sender?.sender_type === 'app' ? 'assistant' : 'user', text });
  }
  turns.reverse(); // 接口按时间倒序给的，正序才是「最近在后」
  return turns.slice(-count);
}

/** /de 触发：拉历史 → 本地出候选 → 发卡片。返回卡片消息 id；失败抛错由调用方回文本提示。 */
export async function runDe(client: DeFeishuClient, cfg: DeConfig, chatId: string): Promise<{ mid: string | null; res: DeResult }> {
  if (!cfg.enabled) throw new Error('/de 未在配置中心启用');
  const turns = await fetchHistory(client as DeFeishuClient, chatId, cfg.historyTurns || 15);
  if (turns.length === 0) throw new Error('这个会话读不到文本历史（可能是空会话或只有图片/文件）');
  const res = await localDe(turns, cfg);
  if (res.candidates.length === 0) throw new Error(`没出候选：${res.context.note || '起草模型返回空'}`);
  const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  gcPending();
  const cardMsgId = await client.sendCardHttp(chatId, buildDeCard(uid, chatId, res));
  pending.set(uid, { chatId, texts: res.candidates.map((c) => c.text), used: {}, at: Date.now(), cardMsgId });
  return { mid: cardMsgId, res };
}

/**
 * 卡片按钮回调：`de:<chatId>:<uid>:<idx>` → 原文以 user 身份发出。
 * 幂等：同一条点第二次直接拒（老大要求"点哪条发哪条"，但不能重复刷屏）。
 */
export async function onDeAction(callback: string): Promise<{ toast: { type: string; content: string }; sentText: string; uid: string; idx: number }> {
  const parts = callback.split(':');
  // de : chatId : uid : idx —— chatId 不含冒号
  if (parts.length < 4) throw new Error(`回调格式不对：${callback}`);
  const [, chatId, uid, idxRaw] = parts;
  const idx = Number(idxRaw);
  const p = pending.get(uid);
  if (!p) throw new Error('这张卡已过期（30 分钟），重新发 /de 再来一次');
  if (p.chatId !== chatId) throw new Error('这张卡不属于本会话');
  if (!Number.isInteger(idx) || idx < 0 || idx >= p.texts.length) throw new Error('按钮序号越界');
  if (p.used[idx] !== undefined) return { toast: { type: 'warning', content: '这条已经发过了，不重复发' }, sentText: p.texts[idx], uid, idx };
  const text = p.texts[idx];
  await sendAsUserToChat(chatId, text);
  p.used[idx] = new Date().toISOString();
  return { toast: { type: 'success', content: `已按你的身份发出第 ${idx + 1} 条` }, sentText: text, uid, idx };
}

/** 高风险兜底：blockRiskySend 时不直发，只把原文回显给用户自己复制 */
export function riskyBlocked(cfg: DeConfig, res: DeResult): boolean {
  return cfg.blockRiskySend !== false && String((res.judge as Record<string, unknown>)?.risk ?? '') === 'high';
}
