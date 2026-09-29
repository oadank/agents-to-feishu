/**
 * 2026-08-31 自动回执登记表（模块级单例）。
 * index.ts 登记/消费；lark-tools 在 bot 主动调 send_as_user 回执时打标记，
 * onReplySent 据此跳过自动转发——防止"工具回执 + 自动转发"双份送达。
 *
 * 票 T-0019③（2026-09-29）：两个窗口原先写死在本文件（1h / 5min），现统一收口到
 * src/bridge/windows.ts，由启动闸门校不变量（W2 判重窗口 ≥ 待回执存活 / W3 抑制窗 ≤ 待回执存活），
 * 并经配置中心渲染进 config.<bot>.env —— 数字不再只活在代码兜底里。
 */
import { windows } from './windows.js';

const pendingReceipts = new Map<string, { fromBot: string; at: number }>();
/** 容量上限（对齐 agent-mailbox 的有界台账思路）：超了先扔最老的，进程长跑不炸内存 */
const MAX_PENDING = 100;

/** 登记待回执（收到 (from-bot:X) 派活消息时调用） */
export function registerPending(chatId: string, fromBot: string): void {
  const ttl = windows().receiptPendingMs;
  const now = Date.now();
  for (const [k, v] of pendingReceipts) if (now - v.at > ttl) pendingReceipts.delete(k);
  while (pendingReceipts.size >= MAX_PENDING) {
    const oldest = pendingReceipts.keys().next().value;
    if (!oldest) break;
    pendingReceipts.delete(oldest);
  }
  pendingReceipts.set(chatId, { fromBot, at: now });
}

/** 取走待回执登记（有=需要自动转发）；过期一律当没有 */
export function consumePending(chatId: string): string | null {
  const p = pendingReceipts.get(chatId);
  if (!p) return null;
  pendingReceipts.delete(chatId);
  if (Date.now() - p.at > windows().receiptPendingMs) return null;
  return p.fromBot;
}

/** 只查不取（票 T-0019① 回声判定用：本会话正挂着谁的派活，决定这句是该收的结果还是纯点头） */
export function peekPending(chatId: string): string | null {
  const p = pendingReceipts.get(chatId);
  if (!p) return null;
  if (Date.now() - p.at > windows().receiptPendingMs) {
    pendingReceipts.delete(chatId);
    return null;
  }
  return p.fromBot;
}

/** bot 主动调 send_as_user 回执时打标记（就近抑制窗内的 FINAL 不再自动转发） */
let lastManualReceiptAt = 0;
export function markManualReceipt(): void {
  lastManualReceiptAt = Date.now();
}
/** 抑制窗内 bot 自己用工具回执过 → 跳过自动转发（防双份） */
export function manualReceiptRecent(): boolean {
  if (lastManualReceiptAt === 0) return false;
  return Date.now() - lastManualReceiptAt < windows().manualReceiptMs;
}

/** 单测复位用 */
export function resetAutoReceipt(): void {
  pendingReceipts.clear();
  lastManualReceiptAt = 0;
}
