/**
 * DeepTutor 模型配置推送（路线 A：单服务 + 配置中心推送，2026-09-05）。
 *
 * DeepTutor 的模型此前完全由它自己的设置界面管理（catalog.services.llm 的
 * profile 体系），配置中心管不到——agent 卡片的模型/Provider 对它是空摆设。
 * 本模块把 config-store 选的 provider/model 映射成 DeepTutor 的一个专属
 * profile（id 固定 'llm-profile-configcenter'），随 apply 推送并切 active：
 *   - 用户在 DeepTutor 界面手工建的其他 profile 原样保留，随时可切回；
 *   - 幂等：内容未变化时不写网络（避免 apply 风暴打扰 DeepTutor）；
 *   - 服务不在线/推送失败 → log warning 不阻塞 apply（bot 继续用 DeepTutor
 *     上次保存的配置，报错由状态页与日志可见）。
 *
 * API 契约（实测 deeptutor/api/routers/settings.py）：
 *   GET  /api/settings                     → {catalog: {services: {llm: {...}}}}
 *   PUT  /api/settings/draft {catalog}     → 存草稿（merge_draft_secrets 会合并密钥）
 *   POST /api/settings/apply               → 草稿提升为运行时配置（无 body = 推进已存草稿）
 * 鉴权：单用户本机模式（AUTH_ENABLED=false）无鉴权；多用户部署用
 *   CTI_DEEPTUTOR_TOKEN 带上 Bearer。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigStore, AgentDef } from './store.js';
import { findProvider } from './store.js';
import { readCredentialKey, readOldEnvKey } from './render.js';

/** DeepTutor 里配置中心专属 profile 的固定 id（存在即更新，不存在则建） */
export const DEEPTUTOR_CC_PROFILE_ID = 'llm-profile-configcenter';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[sync-deeptutor] ${msg}\n`, 'utf-8'); } catch { /* 忽略 */ }
}

// 服务地址/Token 解析优先级：运行时页覆盖（runtimeEnv）> 进程 env > 默认 8001
let _envOverride: Record<string, string> | undefined;
function dtBase(): string {
  const v = (_envOverride && _envOverride.CTI_DEEPTUTOR_BASE) || process.env.CTI_DEEPTUTOR_BASE || 'http://127.0.0.1:8001';
  return v.replace(/\/+$/, '');
}

function dtHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const token = (_envOverride && _envOverride.CTI_DEEPTUTOR_TOKEN) || process.env.CTI_DEEPTUTOR_TOKEN || '';
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function dtFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${dtBase()}${pathname}`, { ...init, headers: { ...dtHeaders(), ...(init?.headers || {}) } });
}

/** openai 兼容 base_url 规范化：缺 /v1 补 /v1（与 zcode runtimeModel 同规则） */
function normalizeOpenAiBase(baseURL: string): string {
  const b = baseURL.replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

/**
 * 推送 config-store 选的 provider/model 到 DeepTutor 并切 active。
 * 返回是否发生实际推送（幂等跳过时为 false）。
 */
export async function syncDeepTutorModel(store: ConfigStore, agent: AgentDef, envOverride?: Record<string, string>): Promise<{ pushed: boolean; skipped?: string; error?: string }> {
  if ((agent.runtime || '') !== 'deeptutor') return { pushed: false, skipped: 'not-deeptutor' };
  _envOverride = envOverride;
  const prov = agent.providerId ? findProvider(store, agent.providerId) : undefined;
  if (!prov) return { pushed: false, skipped: 'no-provider' };
  // 仅 openai 兼容通道（anthropic-messages 等 binding 需另行适配 DeepTutor 的 api_format 枚举）
  if (prov.api && prov.api !== 'openai-completions' && prov.api !== 'openai-responses') {
    return { pushed: false, skipped: `unsupported-provider-api:${prov.api}` };
  }
  const modelId = agent.modelId || (prov.models[0] && prov.models[0].id) || '';
  if (!modelId) return { pushed: false, skipped: 'no-model' };
  const key = prov.apiKeyEnv ? (readCredentialKey(prov.apiKeyEnv) || readOldEnvKey(prov.apiKeyEnv)) : '';
  let baseURL = (prov.baseURL || '').replace(/\/+$/, '');
  if (baseURL && !/\/v\d+$/.test(baseURL)) baseURL += '/v1';
  if (!baseURL) return { pushed: false, skipped: 'no-base-url' };

  // ① 读当前 catalog
  let catalog: any;
  try {
    const r = await dtFetch('/api/settings');
    if (!r.ok) return { pushed: false, error: `GET settings HTTP ${r.status}` };
    catalog = (await r.json() as any).catalog;
  } catch (e) {
    return { pushed: false, error: `DeepTutor 不可达: ${e instanceof Error ? e.message : String(e)}` };
  }
  const llm = catalog?.services?.llm;
  if (!llm || !Array.isArray(llm.profiles)) return { pushed: false, error: 'catalog.services.llm 结构不符（DeepTutor 版本差异?）' };

  // ② 组装配置中心专属 profile（覆盖式更新；用户手工 profile 不动）
  const models = (prov.models || []).map((m) => ({
    id: `llm-model-${m.id}`,
    name: m.label || m.id,
    model: m.id,
    context_window: String(m.contextWindow || 1000000),
    context_window_source: 'manual',
  }));
  const desiredProfile = {
    id: DEEPTUTOR_CC_PROFILE_ID,
    name: 'Config Center 推送（勿在 DeepTutor 界面改）',
    binding: 'openai',
    api_key: key,
    base_url: baseURL,
    api_version: '',
    extra_headers: {},
    models,
    wire_api: prov.api === 'openai-responses' ? 'responses' : 'auto',
    api_format: 'auto',
  };
  const idx = llm.profiles.findIndex((p: any) => p.id === DEEPTUTOR_CC_PROFILE_ID);
  const before = idx >= 0 ? JSON.stringify(llm.profiles[idx]) : '';
  if (idx >= 0) llm.profiles[idx] = desiredProfile;
  else llm.profiles.push(desiredProfile);
  llm.active_profile_id = DEEPTUTOR_CC_PROFILE_ID;
  llm.active_model_id = `llm-model-${modelId}`;

  // ③ 幂等：内容未变且 active 已指向 → 不打网络
  if (idx >= 0 && before === JSON.stringify(desiredProfile)) {
    return { pushed: false, skipped: 'unchanged' };
  }

  // ④ draft → apply（apply 无 body = 提升 draft；密钥由 merge_draft_secrets 合并）
  try {
    const d = await dtFetch('/api/settings/draft', { method: 'PUT', body: JSON.stringify({ catalog }) });
    if (!d.ok) return { pushed: false, error: `PUT draft HTTP ${d.status}` };
    const a = await dtFetch('/api/settings/apply', { method: 'POST', body: JSON.stringify(null) });
    if (!a.ok) return { pushed: false, error: `POST apply HTTP ${a.status}` };
  } catch (e) {
    return { pushed: false, error: `推送失败: ${e instanceof Error ? e.message : String(e)}` };
  }
  rtLog(`DeepTutor 模型已推送: provider=${prov.id} model=${modelId} → active`);
  return { pushed: true };
}

/**
 * 把 agent.mcps 同步到 DeepTutor 部署级 MCP 注册表（/api/settings/mcp）。
 * 2026-09-18：deeptutor provider 走 WS start_turn，协议无 MCP 注入点；
 * 勾选只有落到 DeepTutor 自己的 MCP API 才会出现在 bot 工具面。
 * API（实测 deeptutor/api/routers/mcp_settings.py）：
 *   GET  /api/settings/mcp
 *   PUT  /api/settings/mcp/servers/{name}
 * 管理员通道允许 localhost（network.py deployment strict=False）。
 */
export async function syncDeepTutorMcp(
  store: ConfigStore,
  agent: AgentDef,
  envOverride?: Record<string, string>,
): Promise<{ pushed: boolean; skipped?: string; error?: string }> {
  if ((agent.runtime || '') !== 'deeptutor') return { pushed: false, skipped: 'not-deeptutor' };
  _envOverride = envOverride;

  const desired: Array<{ id: string; url: string; command: string; args: string[]; transport: string }> = [];
  for (const mcpId of agent.mcps || []) {
    const m = store.mcps.find((x) => x.id === mcpId);
    if (!m) continue;
    if (m.transport === 'stdio' && m.command) {
      desired.push({
        id: m.id,
        url: '',
        command: m.command,
        args: m.args || [],
        transport: 'stdio',
      });
    } else if (m.url) {
      desired.push({
        id: m.id,
        url: m.url,
        command: '',
        args: [],
        transport: 'streamableHttp',
      });
    }
  }

  let current: Record<string, any> = {};
  try {
    const r = await dtFetch('/api/settings/mcp');
    if (r.ok) current = ((await r.json()) as { servers?: Record<string, any> }).servers || {};
  } catch (e) {
    return { pushed: false, error: `DeepTutor MCP 不可达: ${e instanceof Error ? e.message : String(e)}` };
  }

  let pushed = 0;
  for (const d of desired) {
    const prev = current[d.id];
    const body =
      d.transport === 'stdio'
        ? { command: d.command, args: d.args, enabled: true }
        : { url: d.url, type: 'streamableHttp', enabled: true };
    const same =
      prev &&
      ((d.transport === 'stdio' && prev.command === d.command && JSON.stringify(prev.args || []) === JSON.stringify(d.args)) ||
        (d.transport === 'streamableHttp' && prev.url === d.url && (prev.type || 'streamableHttp') === 'streamableHttp'));
    if (same) continue;
    try {
      const u = await dtFetch(`/api/settings/mcp/servers/${encodeURIComponent(d.id)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (!u.ok) {
        const detail = await u.text();
        return { pushed: pushed > 0, error: `PUT mcp/${d.id} HTTP ${u.status}: ${detail.slice(0, 200)}` };
      }
      pushed += 1;
    } catch (e) {
      return { pushed: pushed > 0, error: `PUT mcp/${d.id}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (!pushed) return { pushed: false, skipped: 'unchanged' };
  rtLog(`DeepTutor MCP 已推送 ${pushed} 个: ${desired.map((x) => x.id).join(', ')}`);
  return { pushed: true };
}
