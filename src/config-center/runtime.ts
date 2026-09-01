/**
 * config-center runtime —— 读取各 agent 的【真实运行时状态】，网页只读展示。
 *
 * 状态行数据真实性（用户强调）：
 *   Session      ← config/engine 记录的 ACP sessionId（前 8 位）
 *   Cache / 平均  ← ~/.dsh/<id>-bot/stats/日期.jsonl（readCacheStats 同引擎逻辑）
 *   上下文        ← stats jsonl 里最新 prompt / provider contextWindow
 *   余额          ← 按 provider 查网关/官方余额接口（5s 缓存）
 *
 * 这些数据与飞书卡片分割线同源，保证"网页显示 = 卡片显示"。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { findModel } from './store.js';
import type { ConfigStore, AgentDef, ProviderDef } from './store.js';

/** 一个 agent 的实时状态视图 */
export interface AgentRuntimeState {
  agentId: string;
  session?: string;       // ACP session 前 8 位
  cacheLastRate?: number; // 最近一次缓存命中 %
  cacheAvgRate?: number;  // 当日平均缓存命中 %
  contextPercent?: number;// 上下文占用 %
  contextUsed?: number;   // 已用 tokens
  contextLimit?: number;  // 上限 tokens
  balance?: { currency: string; total: string } | null;
  usage?: ArkUsageView | null;   // 火山方舟 Agent Plan 套餐配额快照（volc-ark 显示额度而非余额）
  lastRequestAt?: string;
}

/** 火山方舟 Agent Plan 套餐配额视图（按量套餐，无金钱余额，显示各周期用了几成）。 */
export interface ArkUsageView {
  planType?: string;
  periods: Array<{ label: string; quota: number; used: number; resetAt: number }>;
}

// ── 从 stats jsonl 读取（与 engine.ts readCacheStats 同口径）──

export interface StatsSummary {
  cacheLastRate: number;
  cacheAvgRate: number;
  contextPercent: number;
  contextUsed: number;
  contextLimit: number;
  lastRequestAt?: string;
}

/** 读取某 agent 当日 stats 汇总 */
export function readAgentStats(agentId: string, contextLimitArg?: number): StatsSummary | null {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const statsDir = path.join(home, `${agentId}-bot`, 'stats');
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const file = path.join(statsDir, `${localDate}.jsonl`);
    if (!fs.existsSync(file)) return null;

    let lastRate: number | null = null;
    let sumHit = 0, sumMiss = 0, lastPrompt = 0;
    let lastTs: string | undefined;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.source !== 'cli') continue;
      const hit = Number(rec.cache_hit ?? 0);
      const miss = Number(rec.cache_miss ?? 0);
      if (hit + miss <= 0) continue;
      lastRate = (hit / (hit + miss)) * 100;
      sumHit += hit; sumMiss += miss;
      if (rec.prompt != null && Number(rec.prompt) > 0) lastPrompt = Number(rec.prompt);
      if (rec.ts) lastTs = rec.ts;
    }
    if (lastRate == null || sumHit + sumMiss <= 0) return null;
    // 上下文上限：用 agent 模型配置的 contextWindow（非写死 1M），缺省兜底 1M
    const contextLimit = contextLimitArg && contextLimitArg > 0 ? contextLimitArg : 1_000_000;
    return {
      cacheLastRate: lastRate,
      cacheAvgRate: (sumHit / (sumHit + sumMiss)) * 100,
      contextUsed: lastPrompt,
      contextLimit,
      contextPercent: lastPrompt > 0 ? Math.min(100, (lastPrompt / contextLimit) * 100) : 0,
      lastRequestAt: lastTs,
    };
  } catch {
    return null;
  }
}

// ── 余额查询（与 web 端 api-proxy 同口径）──

export interface BalanceView { currency: string; total: string; }

const balanceCache = new Map<string, { value: BalanceView | null; at: number }>();

/** 按 provider 查余额；不可用返回 null。5s 缓存防抖。
 *  多候选端点 + 多字段解析，尽量让所有直连 provider 都能显示余额。
 *  候选顺序：{baseURL}/balance、{origin}/v1/balance、{origin}/balance；deepseek-official 走官方接口。
 */
export async function readBalance(provider: ProviderDef | undefined): Promise<BalanceView | null> {
  if (!provider) return null;
  const key = provider.id;
  const hit = balanceCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.value;

  const apiKey = resolveApiKey(provider);
  if (!apiKey) { balanceCache.set(key, { value: null, at: Date.now() }); return null; }

  // 候选余额端点
  const candidates: string[] = [];
  if (provider.id === 'deepseek-official') {
    candidates.push('https://api.deepseek.com/user/balance');
  }
  if (provider.baseURL) {
    const base = provider.baseURL.replace(/\/+$/, '');
    candidates.push(
      `${base}/balance`,
      base.replace(/\/v1$/, '') + '/v1/balance',
      base.replace(/\/v1$/, '') + '/balance',
    );
  }

  let value: BalanceView | null = null;
  for (const u of candidates) {
    try {
      const resp = await fetch(u, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) continue;
      const data = await resp.json().catch(() => null);
      if (!data || typeof data !== 'object') continue;
      value = pickBalance(data);
      if (value) break;
    } catch {
      continue; // 该端点失败，试下一个
    }
  }
  balanceCache.set(key, { value, at: Date.now() });
  return value;
}

/** 从网关/官方响应的常见字段里挑出余额（兼容各家命名） */
function pickBalance(raw: unknown): BalanceView | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const numbers: Array<[string, unknown]> = [
    ['balance_cny', data.balance_cny],
    ['available_balance_cny', data.available_balance_cny],
    ['balance', data.balance],
    ['available_balance', data.available_balance],
    ['credits', data.credits],
    ['total_credits', data.total_credits],
    ['remaining_balance', data.remaining_balance],
    ['total_balance', data.total_balance],
  ];
  for (const [name, raw] of numbers) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return { currency: 'CNY', total: String(raw) };
    }
    if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
      return { currency: 'CNY', total: raw.trim() };
    }
    void name;
  }
  // 兼容飞书格式：{ total_balance / granted_balance / topped_up_balance } 在 balance_infos[0]
  const infos = (data as { balance_infos?: Array<Record<string, unknown>> }).balance_infos;
  if (Array.isArray(infos) && infos[0]) {
    const info = infos[0];
    for (const k of ['total_balance', 'granted_balance', 'topped_up_balance']) {
      const v = info[k];
      if (typeof v === 'number') return { currency: String(info.currency || 'CNY'), total: String(v) };
      if (typeof v === 'string' && v !== '') return { currency: String(info.currency || 'CNY'), total: v };
    }
  }
  // deepseek 官方：balance_infos[0].total_balance
  return null;
}

function resolveApiKey(provider: ProviderDef): string {
  const fromEnv = process.env[provider.apiKeyEnv] || '';
  if (fromEnv) return fromEnv;
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    if (!fs.existsSync(p)) return '';
    const txt = fs.readFileSync(p, 'utf-8');
    const m = txt.match(new RegExp(`^\\s*${provider.apiKeyEnv}\\s*:\\s*(\\S+)`, 'm'));
    return m ? m[1] : '';
  } catch { return ''; }
}

// ── 专用余额/用量读取（与 dsh-web host/apiproxy 同口径，移植自 dsh-web api-proxy.ts）──
// 火山方舟 Agent Plan 套餐配额（非金钱余额，显示各周期用量几成）：Volcengine V4 签名
// 调 GetAFPUsage OpenAPI。凭证为 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY。
const ARK_OPENAPI_HOST = 'ark.cn-beijing.volcengineapi.com';
const ARK_OPENAPI_REGION = 'cn-beijing';
const ARK_OPENAPI_SERVICE = 'ark';
let arkUsageCache: { value: ArkUsageView | null; at: number } | null = null;
let deepseekBalanceCache: { value: BalanceView | null; at: number } | null = null;
let gwBalanceCache: { value: BalanceView | null; at: number } | null = null;
const SSO_CACHE_MS = 5_000;
const ARK_CACHE_MS = 60_000;

// ── 同步读缓存值（不发起网络请求）：供卡片骨架 buildDivider 首屏直用，避免阻塞 ──
export function readArkUsageCached(): ArkUsageView | null { return arkUsageCache ? arkUsageCache.value : null; }
export function readDeepSeekBalanceCached(): BalanceView | null { return deepseekBalanceCache ? deepseekBalanceCache.value : null; }
export function readGwBalanceCached(): BalanceView | null { return gwBalanceCache ? gwBalanceCache.value : null; }

function readCredential(name: string): string {
  const fromEnv = process.env[name] || '';
  if (fromEnv) return fromEnv;
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    if (!fs.existsSync(p)) return '';
    const txt = fs.readFileSync(p, 'utf-8');
    const m = txt.match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)`, 'm'));
    return m ? m[1] : '';
  } catch { return ''; }
}

/** DeepSeek 官方直连余额：DEEPSEEK_API_KEY → GET https://api.deepseek.com/user/balance。 */
export async function readDeepSeekBalance(): Promise<BalanceView | null> {
  const now = Date.now();
  if (deepseekBalanceCache && now - deepseekBalanceCache.at < SSO_CACHE_MS) return deepseekBalanceCache.value;
  const apiKey = readCredential('DEEPSEEK_API_KEY');
  if (!apiKey) { deepseekBalanceCache = { value: null, at: now }; return null; }
  try {
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) { deepseekBalanceCache = { value: null, at: now }; return null; }
    const data: any = await resp.json().catch(() => null);
    const info = data?.balance_infos?.[0];
    if (!info) { deepseekBalanceCache = { value: null, at: now }; return null; }
    const value: BalanceView = { currency: info.currency || 'CNY', total: String(info.total_balance) };
    deepseekBalanceCache = { value, at: now };
    return value;
  } catch { return deepseekBalanceCache?.value ?? null; }
}

/** GW (henry-gao) 直连余额（按量预付款）：GW_API_KEY → GET https://gateway.henry-gao.com/v1/balance。 */
export async function readGwBalance(): Promise<BalanceView | null> {
  const now = Date.now();
  if (gwBalanceCache && now - gwBalanceCache.at < SSO_CACHE_MS) return gwBalanceCache.value;
  const apiKey = readCredential('GW_API_KEY');
  if (!apiKey) { gwBalanceCache = { value: null, at: now }; return null; }
  try {
    const resp = await fetch('https://gateway.henry-gao.com/v1/balance', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) { gwBalanceCache = { value: null, at: now }; return null; }
    const data: any = await resp.json().catch(() => null);
    if (data?.balance_cny === undefined) { gwBalanceCache = { value: null, at: now }; return null; }
    const value: BalanceView = { currency: 'CNY', total: String(data.balance_cny) };
    gwBalanceCache = { value, at: now };
    return value;
  } catch { return gwBalanceCache?.value ?? null; }
}

/** 火山方舟 Agent Plan 套餐配额快照：VOLC_ACCESS_KEY_ID/SECRET → Volcengine V4 签名 GetAFPUsage。 */
export async function readArkUsage(): Promise<ArkUsageView | null> {
  const now = Date.now();
  if (arkUsageCache && now - arkUsageCache.at < ARK_CACHE_MS) return arkUsageCache.value;
  const accessKeyId = readCredential('VOLC_ACCESS_KEY_ID');
  const secretAccessKey = readCredential('VOLC_SECRET_ACCESS_KEY');
  if (!accessKeyId || !secretAccessKey) { arkUsageCache = { value: null, at: now }; return null; }
  try {
    const xdate = new Date().toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
      .replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z/, '$1$2$3T$4$5$6Z');
    const query = 'Action=GetAFPUsage&Version=2024-01-01';
    const body = '{}';
    const payloadHash = createHash('sha256').update(body, 'utf8').digest('hex');
    const signedHeaders = ['host', 'x-content-sha256', 'x-date'];
    const canonicalHeaders = [
      `host:${ARK_OPENAPI_HOST}\n`,
      `x-content-sha256:${payloadHash}\n`,
      `x-date:${xdate}\n`,
    ].sort().join('');
    const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
    const scope = `${xdate.slice(0, 8)}/${ARK_OPENAPI_REGION}/${ARK_OPENAPI_SERVICE}/request`;
    const stringToSign = [
      'HMAC-SHA256', xdate, scope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');
    const kDate = createHmac('sha256', secretAccessKey).update(xdate.slice(0, 8), 'utf8').digest();
    const kRegion = createHmac('sha256', kDate).update(ARK_OPENAPI_REGION, 'utf8').digest();
    const kService = createHmac('sha256', kRegion).update(ARK_OPENAPI_SERVICE, 'utf8').digest();
    const kSigning = createHmac('sha256', kService).update('request', 'utf8').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
    const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
    const resp = await fetch(`https://${ARK_OPENAPI_HOST}/?${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-date': xdate,
        'x-content-sha256': payloadHash,
        Authorization: authorization,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) { arkUsageCache = { value: null, at: now }; return null; }
    const data: any = await resp.json().catch(() => null);
    const result = data?.Result;
    if (!result) { arkUsageCache = { value: null, at: now }; return null; }
    const periodView = (label: string, p?: { Quota: number; Used: number; ResetTime: number }) =>
      p === undefined ? null : { label, quota: Number(p.Quota), used: Number(p.Used), resetAt: Number(p.ResetTime) || 0 };
    const periods = [
      periodView('5h', result.AFPFiveHour),
      periodView('weekly', result.AFPWeekly),
      periodView('monthly', result.AFPMonthly),
    ].filter((p): p is NonNullable<typeof p> => p !== null);
    if (periods.length === 0) { arkUsageCache = { value: null, at: now }; return null; }
    const value: ArkUsageView = { planType: result.PlanType || '', periods };
    arkUsageCache = { value, at: now };
    return value;
  } catch { return arkUsageCache?.value ?? null; }
}

/** 按 provider 读取余额/用量视图（dsh-web 同款分流）：
 *  volc-ark→配额用量；gw/henry-gao 网关（含 claude 用的 GWAnth）→GW余额；
 *  deepseek-official→官方余额；其余走通用探测。
 *  判定：provider.id==='gw' 或 baseURL 命中 henry-gao 网关即走 readGwBalance（正确端点/字段）。 */
export async function readBalanceView(provider: ProviderDef | undefined): Promise<{ balance: BalanceView | null; usage: ArkUsageView | null }> {
  if (!provider) return { balance: null, usage: null };
  const base = (provider.baseURL || '').toLowerCase();
  // Ark：按 provider.id 或 baseURL 判定（volces.com / volcengine / ark.cn-beijing），用户自定义 provider 名也能匹配
  const isArkProvider = provider.id === 'volc-ark'
    || base.includes('volces') || base.includes('volcengine') || base.includes('ark.cn-beijing');
  const isGwGateway = provider.id === 'gw'
    || base.includes('henry-gao.com') || base.includes('gateway.henry-gao');
  if (isArkProvider) return { balance: null, usage: await readArkUsage() };
  if (isGwGateway) return { balance: await readGwBalance(), usage: null };
  if (provider.id === 'deepseek-official') return { balance: await readDeepSeekBalance(), usage: null };
  return { balance: await readBalance(provider), usage: null };
}

// ── LiteLLM 网关：模型组 → 上游 api_base 解析（2026-08-31 状态条 💰/⏱️ 支持）──
// bot 经 LiteLLM(:4000) 中转时，状态条按"真实上游"分流读余额/配额：
//   GwV4F → gateway.henry-gao.com → GW 余额；ArkV4F → volces → Ark 配额；其余上游无公开余额接口。
// /model/info 用 master key（bot env 的 LITELLM_API_KEY/OPENAI_API_KEY 即是），结果缓存 5 分钟。
let litellmModelMapCache: { map: Record<string, string>; at: number } | null = null;

export async function readLitellmModelMap(baseURL: string): Promise<Record<string, string>> {
  const now = Date.now();
  if (litellmModelMapCache && now - litellmModelMapCache.at < 300_000) return litellmModelMapCache.map;
  const key = process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!key || !baseURL) return litellmModelMapCache?.map ?? {};
  try {
    const resp = await fetch(`${baseURL.replace(/\/+$/, '')}/model/info`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return litellmModelMapCache?.map ?? {};
    const data: any = await resp.json().catch(() => null);
    const map: Record<string, string> = {};
    for (const m of (data?.data ?? []) as Array<Record<string, unknown>>) {
      const base = (m?.litellm_params as Record<string, unknown> | undefined)?.api_base;
      if (m?.model_name && typeof base === 'string') map[String(m.model_name)] = base;
    }
    litellmModelMapCache = { map, at: now };
    return map;
  } catch { return litellmModelMapCache?.map ?? {}; }
}

/** 解析 LiteLLM 模型组的上游用量视图：gw→GW 余额；ark→Ark 配额；其他上游无公开接口返回 null。 */
export async function readLitellmUpstreamView(modelGroup: string, baseURL: string): Promise<{ balance: BalanceView | null; usage: ArkUsageView | null; kind: 'gw' | 'ark' | 'none' }> {
  const map = await readLitellmModelMap(baseURL);
  const base = (map[modelGroup] || '').toLowerCase();
  if (base.includes('henry-gao')) return { balance: await readGwBalance(), usage: null, kind: 'gw' };
  if (base.includes('volces') || base.includes('volcengine') || base.includes('ark.cn-beijing')) return { balance: null, usage: await readArkUsage(), kind: 'ark' };
  return { balance: null, usage: null, kind: 'none' };
}

// ── 汇总 ──

/** 计算某 agent 的完整运行时状态（供网页） */
export async function buildAgentRuntimeState(store: ConfigStore, agent: AgentDef): Promise<AgentRuntimeState> {
  const model = findModel(store, agent.providerId, agent.modelId);
  const stats = readAgentStats(agent.id, model?.contextWindow);
  const provider = store.providers.find((p) => p.id === agent.providerId);
  const { balance, usage } = await readBalanceView(provider);
  return {
    agentId: agent.id,
    session: undefined, // session id 由运行时注入（本模块不追踪 ACP session）
    cacheLastRate: stats?.cacheLastRate,
    cacheAvgRate: stats?.cacheAvgRate,
    contextUsed: stats?.contextUsed,
    contextLimit: stats?.contextLimit,
    contextPercent: stats?.contextPercent,
    balance,
    usage,
    lastRequestAt: stats?.lastRequestAt,
  };
}

// ── LiteLLM 记账库用量（2026-08-31）──
// 背景：gemini CLI 不吐 usage（_meta.quota 恒 0），但请求经 LiteLLM(:4000) 中转，
// LiteLLM Postgres 的 LiteLLM_SpendLogs 有完整记账（prompt/completion tokens）。
// CLI 不报 → 桥接在 turn 结束后按 model_group + 时间窗补拉，落盘 stats 供状态条显示。

/** 惰性单例连接池（nssm 常驻进程，复用连接；失败不阻塞主流程） */
let litellmPool: QueryResultLikePool | null = null;
async function getLitellmPool(): Promise<QueryResultLikePool> {
  if (!litellmPool) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      connectionString: process.env.CTI_LITELLM_DB_URL || 'postgresql://litellmuser:adan123456@localhost:5432/litellm',
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    pool.on('error', () => { /* 空闲连接错误静默（pg 自愈，下次调用重建） */ });
    litellmPool = pool as unknown as QueryResultLikePool;
  }
  return litellmPool;
}
type QueryResultLikePool = { query: (sql: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; on: (ev: string, cb: () => void) => void };

export interface LitellmTurnUsage { inputTokens: number; outputTokens: number; requests: number; }

/** 拉取某模型组自 sinceTs（epoch ms）以来的累计用量（turn 结束后调用）。失败返回 null。 */
export async function readLitellmTurnUsage(modelGroup: string, sinceTs: number): Promise<LitellmTurnUsage | null> {
  try {
    const pool = await getLitellmPool();
    // 时区坑（2026-08-31 实测）：startTime 是 naive UTC 列 —— 参数必须 ::timestamptz → at time zone 'utc'，
    // 否则会话时区(+08)会把阈值偏移 8 小时。归因：CLI 流量（gemini）落库时 model_group 为空、model 已解析成
    // 上游名，无法按组名匹配 → 空组的成功 acompletion 行按时间窗归因（bot 间 turn 重叠极少，可接受）；
    // 直连流量（带组名）按组名精确匹配。0 token 行是心跳/健康检查，排除。
    const r = await pool.query(
      `select coalesce(sum(prompt_tokens),0)::int as pt, coalesce(sum(completion_tokens),0)::int as ct, count(*)::int as n
       from "LiteLLM_SpendLogs"
       where "startTime" >= ($2::timestamptz at time zone 'utc')
         and (prompt_tokens > 0 or completion_tokens > 0)
         and ((model_group = $1 or model = $1)
              or (coalesce(model_group, '') = '' and call_type = 'acompletion' and status = 'success'))`,
      [modelGroup, new Date(sinceTs).toISOString()],
    );
    const row = r.rows[0] || {};
    return { inputTokens: Number(row.pt) || 0, outputTokens: Number(row.ct) || 0, requests: Number(row.n) || 0 };
  } catch (e) {
    console.warn('[runtime] readLitellmTurnUsage failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
