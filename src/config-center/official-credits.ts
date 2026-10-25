/**
 * CodeBuddy 官方账号余额（积分）查询 —— 2026-10-23 老大令。
 *
 * 背景：workbuddy bot 的引擎换成官方完整版 CodeBuddy CLI + 官方账号登录态
 * （provider codebuddy-official，officialAuth=true）后，状态栏要显示官方账号
 * 积分余额。口径与 wb-shim 时代完全一致：本机桌面 App（CodeBuddyExtension）
 * 写的 auth 信封里就是同一个腾讯账号的 accessToken，查官方 billing 接口即
 * 「自己账号查自己余额」。
 *
 * 实现照抄 wb-shim daemon.mjs:477 fetchCreditsEx（2026-10-16 自有层口径）：
 *   - 凭据解析/刷新复用官方包 WorkBuddyCredentialStore（信封解密钥匙要 spawn
 *     桌面 Electron 拿 at-rest key，包内自带缓存 —— 所以本模块 store 必须单例，
 *     每次 new 都会重新 spawn Electron，慢且吵）；
 *   - 整数总额：POST {base}/v2/billing/meter/get-user-resource（Accounts 求和）；
 *   - 小数精确值：POST {base}/billing/meter/get-user-resource-summary
 *     （Packets[].CycleRemainCapacity 求和，拿不到就回落整数口径）；
 *   - base 国内=https://www.codebuddy.cn（本机只挂国内版账号）。
 *
 * 纪律：
 *   - 只打状态码/条数/总额，token/nickname 等明文一律不进日志；
 *   - 失败返回 null（卡片该段不显示），不抛、不阻塞一轮对话；
 *   - 余额 60s 缓存（与 wb-shim CREDITS_CACHE_TTL_MS 同值），防每轮都打官方。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CN_VARIANT, WorkBuddyUpstreamClient, WorkBuddyCredentialStore } from 'dsh-workbuddy-connect';
import type { BalanceView } from './runtime.js';

const CREDITS_BASE = 'https://www.codebuddy.cn';
const CREDITS_CACHE_MS = 60_000;
const CREDITS_TIMEOUT_MS = 12_000;

let balanceCache: { value: BalanceView | null; at: number } | null = null;
/** store 单例：WorkBuddyAtRestKeyProvider 的 Electron 探测/解密钥匙只在实例内缓存 */
let storeSingleton: WorkBuddyCredentialStore | null = null;
let inflight: Promise<BalanceView | null> | null = null;

/**
 * 信封解密钥匙提供器（2026-10-23）：store 默认的 keyProvider 关掉了 discovery
 * （"no WorkBuddy Electron binary is configured"），wb-shim 用的是分块里开了
 * 注册表发现的 atRestKeyProviderFor。分块不在包 exports 地图里 → 按 file URL
 * 动态 import（与 wb-shim daemon.mjs:32 同款绕法）；分块名带 hash 会随升级变，
 * 按 host-heartbeat-*.js 前缀找，不写死文件名。
 */
async function atRestKeyProviderFor(variant: typeof CN_VARIANT): Promise<{ protectorKeyFor(requested: readonly string[]): Promise<Buffer>; helperPath(): string | undefined }> {
  const entryUrl = import.meta.resolve('dsh-workbuddy-connect'); // .../lib/index.js
  const libDir = fileURLToPath(new URL('./', entryUrl));
  const chunk = fs.readdirSync(libDir).find((n) => /^host-heartbeat-.*\.js$/.test(n));
  if (!chunk) throw new Error('dsh-workbuddy-connect: host-heartbeat 分块不存在（包结构变了？）');
  const mod: any = await import(pathToFileURL(path.join(libDir, chunk)).href);
  return mod.b(variant);
}

async function getStore(): Promise<WorkBuddyCredentialStore> {
  if (!storeSingleton) {
    const client = new WorkBuddyUpstreamClient();
    const keyProvider = await atRestKeyProviderFor(CN_VARIANT);
    storeSingleton = new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      keyProvider,
      refresh: (credential) => client.refreshToken(credential),
    });
  }
  return storeSingleton;
}

/** 同步读缓存（不发起网络/不解密）：供卡片骨架 buildDivider 首屏直用 */
export function readOfficialBalanceCached(): BalanceView | null {
  return balanceCache ? balanceCache.value : null;
}

/** 官方账号积分余额：拿不到返回 null（调用方不显示该段，不报错） */
export async function readOfficialBalance(): Promise<BalanceView | null> {
  const now = Date.now();
  if (balanceCache && now - balanceCache.at < CREDITS_CACHE_MS) return balanceCache.value;
  if (inflight) return inflight; // 防并发连打（同 wb-shim 的 in-flight 合并）
  inflight = (async (): Promise<BalanceView | null> => {
    try {
      const cred = await (await getStore()).resolve();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${cred.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (cred.uid) headers['X-User-Id'] = cred.uid;
      if (cred.domain) headers['X-Domain'] = cred.domain;

      // 企业账号（cn+enterpriseId）走包内原路径（企业接口无分包明细）；个人账号查分包
      const total = cred.enterpriseId
        ? await fetchPackageCredits(cred)
        : await fetchUserResourceTotal(headers);
      if (total === null) {
        balanceCache = { value: null, at: now };
        return null;
      }
      // 小数精确值（summary 口径）；拿不到就用整数口径，不报错
      const exact = await fetchSummaryExact(headers);
      const value: BalanceView = { currency: '积分', total: String(exact ?? total) };
      balanceCache = { value, at: now };
      console.log(`[official-credits] 官方账号积分余额: ${value.total}（套餐合计${exact != null ? '，小数口径' : '，整数口径'}）`);
      return value;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[official-credits] 余额查询失败（该段不显示，不影响对话）: ${msg.slice(0, 120)}`);
      return balanceCache?.value ?? null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 整数口径：get-user-resource 的 Accounts[].CycleCapacityRemain 求和（照抄 wb-shim） */
async function fetchUserResourceTotal(headers: Record<string, string>): Promise<number | null> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  const resp = await fetch(`${CREDITS_BASE}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: { ...headers, Connection: 'close' },
    body: JSON.stringify({
      PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6)),
    }),
    signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
  });
  const envelope: any = await resp.json().catch(() => ({}));
  if (!resp.ok || envelope?.code !== 0) {
    console.warn(`[official-credits] get-user-resource HTTP ${resp.status} code=${envelope?.code ?? '?'}`);
    return null;
  }
  const accounts = Array.isArray(envelope?.data?.Response?.Data?.Accounts) ? envelope.data.Response.Data.Accounts : [];
  let total = 0;
  for (const a of accounts) {
    if (typeof a !== 'object' || a === null) continue;
    const num = (k: string) => (typeof a[k] === 'number' ? a[k] : 0);
    const size = num('CycleCapacitySize');
    const cycleRemain = num('CycleCapacityRemain');
    const cycleUsed = num('CycleCapacityUsed');
    let remain: number;
    if (size > 0) remain = cycleRemain;
    else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
    else remain = num('CapacityRemain');
    if (remain < 0) remain = 0;
    total += remain;
  }
  return total;
}

/** 小数口径：get-user-resource-summary 的 Packets[].CycleRemainCapacity 求和（拿不到返回 null） */
async function fetchSummaryExact(headers: Record<string, string>): Promise<number | null> {
  try {
    const resp = await fetch(`${CREDITS_BASE}/billing/meter/get-user-resource-summary`, {
      method: 'POST', headers, body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const j: any = await resp.json().catch(() => null);
    const pkgs = j?.data?.Packages;
    if (!Array.isArray(pkgs)) return null;
    let tot = 0;
    for (const p of pkgs) tot += Number(p?.CycleRemainCapacity) || 0;
    return Math.round(tot * 100) / 100;
  } catch { return null; }
}

/** 企业账号兜底：包内 fetchCredits（与 wb-shim 同分支；个人账号走不到） */
async function fetchPackageCredits(cred: any): Promise<number | null> {
  try {
    const client = new WorkBuddyUpstreamClient();
    const c: any = await client.fetchCredits(cred);
    if (typeof c?.total === 'number') return c.total;
    return null;
  } catch { return null; }
}
