/**
 * 2026-08-31 自动回执登记表（模块级单例）。
 * index.ts 登记/消费；lark-tools 在 bot 主动调 send_as_user 回执时打标记，
 * onReplySent 据此跳过自动转发——防止"工具回执 + 自动转发"双份送达。
 */
const pendingReceipts = new Map<string, { fromBot: string; at: number }>();
const PENDING_TTL_MS = 60 * 60_000;

/** 登记待回执（收到 (from-bot:X) 派活消息时调用） */
export function registerPending(chatId: string, fromBot: string): void {
  for (const [k, v] of pendingReceipts) if (Date.now() - v.at > PENDING_TTL_MS) pendingReceipts.delete(k);
  if (pendingReceipts.size > 100) {
    const oldest = pendingReceipts.keys().next().value;
    if (oldest) pendingReceipts.delete(oldest);
  }
  pendingReceipts.set(chatId, { fromBot, at: Date.now() });
}

/** 取走待回执登记（有=需要自动转发） */
export function consumePending(chatId: string): string | null {
  const p = pendingReceipts.get(chatId);
  if (!p) return null;
  pendingReceipts.delete(chatId);
  return p.fromBot;
}

/** bot 主动调 send_as_user 回执时打标记（就近 5 分钟内的 FINAL 不再自动转发） */
let lastManualReceiptAt = 0;
export function markManualReceipt(): void {
  lastManualReceiptAt = Date.now();
}
/** 5 分钟内 bot 自己用工具回执过 → 跳过自动转发（防双份） */
export function manualReceiptRecent(): boolean {
  return Date.now() - lastManualReceiptAt < 5 * 60_000;
}
