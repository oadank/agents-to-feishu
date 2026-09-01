/**
 * 统一 usage 落盘 —— agents-to-feishu 所有 provider 的缓存命中率/上下文数据源。
 *
 * 历史背景（2026-08-28）：状态条/网页的缓存命中率、上下文从 ~/.dsh/<bot>-bot/stats/YYYY-MM-DD.jsonl
 * 读取（engine.ts readCacheStats / runtime.ts 同口径）。但此前只有 claude.ts（recordClaudeStats）
 * 和 dsh.ts（recordUsage）自己写 stats 文件；其余 8 个 app-server provider（codex/gemini/hermes/
 * mimo/openakita/openclaw/opencode/reasonix）只发 {type:'usage'} 事件，bridge 层只做内存累计，
 * 从不落盘 → 这些 bot 状态条永远读不到命中率。
 *
 * 本模块统一承担"写 stats 文件"：engine.ts 在消费 {type:'usage'} 事件时调用 recordStats()，
 * 让所有 provider 只要发 usage 事件就自动落盘，一劳永逸。claude.ts / dsh.ts 的 provider 内
 * 落盘调用已移除（否则双写）。
 *
 * 目录规则：~/.dsh/<CTI_BOT>-bot/stats/YYYY-MM-DD.jsonl（对齐 readCacheStats / runtime.ts）。
 * 记录格式必须兼容 readCacheStats：source='cli'，含 cache_hit / cache_miss / prompt。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UsageInfo } from '../providers/types.js';

export interface StatsRecord {
  ts: string;
  session?: string;
  model?: string;
  source: string;
  prompt: number;
  completion: number;
  reasoning?: number;
  cache_hit: number;
  cache_miss: number;
  cache_write?: number;
  total: number;
  requests: number;
}

/** 由 CTI_BOT 确定 stats 目录：~/.dsh/<bot>-bot/stats */
export function resolveStatsDir(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const botId = process.env.CTI_BOT || '';
  if (botId) return path.join(home, `${botId}-bot`, 'stats');
  // 老 dsh 兜底：从 CTI_DSH_ACP_CONFIG 解析 <bot>-bot
  const acpConfig = process.env.CTI_DSH_ACP_CONFIG || '';
  const m = acpConfig.match(/\\(\w+)-bot\\(cordis\.yml)$/i) || acpConfig.match(/\/(\w+)-bot\/(cordis\.yml)$/i);
  return m ? path.join(home, `${m[1]}-bot`, 'stats') : path.join(home, 'dsh-bot', 'stats');
}

/** 写一条 usage 到 stats 文件（no-throw：落盘失败不影响主流程）。 */
export function recordStats(
  usage: UsageInfo,
  opts: { sessionId?: string; model?: string; source?: string } = {},
): void {
  try {
    const cacheRead = Number(usage.cacheReadTokens ?? 0);      // 命中：从缓存读的量
    const cacheWrite = Number(usage.cacheWriteTokens ?? 0);    // 未命中：本次新写入缓存的量
    let hit = cacheRead;
    let miss = cacheWrite;
    let input = Number(usage.inputTokens ?? 0);
    if (hit + miss <= 0) {
      // 2026-08-30 兜底：后端不报缓存拆分（只有 input）时按全 miss 记账——
      // 保证状态条 🎯/🟰 有基线显示（真实命中率需后端上报缓存字段才有意义）
      if (input <= 0) return;
      miss = input;
      input = 0; // 已计入 miss，不再重复
    }
    if (hit + miss <= 0) return;
    const completion = Number(usage.outputTokens ?? 0);

    const statsDir = resolveStatsDir();
    fs.mkdirSync(statsDir, { recursive: true });
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const file = path.join(statsDir, `${localDate}.jsonl`);

    const rec: StatsRecord = {
      ts: now.toISOString(),
      ...(opts.sessionId ? { session: opts.sessionId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      source: opts.source || 'cli',
      prompt: hit + miss + input,
      completion,
      ...(Number(usage.reasoningTokens) > 0 ? { reasoning: Number(usage.reasoningTokens) } : {}),
      cache_hit: hit,
      cache_miss: miss,
      ...(Number(usage.cacheWriteTokens) > 0 ? { cache_write: Number(usage.cacheWriteTokens) } : {}),
      total: hit + miss + input + completion,
      requests: Number(usage.requests ?? 1),
    };
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf-8');
  } catch {
    // 落盘失败静默（不阻塞主回复/状态条）
  }
}
