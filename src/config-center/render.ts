/**
 * config-center render —— 按 config-store.json 渲染生成每个 agent 的
 *   config.env  +  ~/.dsh/<id>-bot/cordis.yml
 *
 * 状态行数据真实性保障（用户强调）：
 *   Agent/Model/Provider ← config.env 的 AGENT_NAME / MODEL_GROUP / MODEL_PROVIDER（网页改这里 → 状态行变）
 *   Model/Provider 实际路由 ← cordis.yml 的 acp-agent.provider/model + llm-*.providers（真正跑在这里）
 *   所以"网页改模型"必须【同时】写 config.env + cordis.yml，再重启该 agent 的 ACP 进程。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ConfigStore, type ProviderDef, type AgentDef, type McpDef,
  findProvider, findModel, resolveAgentWorkdir,
} from './store.js';
import { writeEnvMerged, writeCordisMerged } from './patch-apply.js';

/** 项目根（render.ts 位于 src/config-center/，上溯两级） */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
/** 项目内建技能目录（可分发，不依赖 dsh 的 ~/.dsh/skills） */
export const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

/** 从 ~/.dsh/.credentials.yaml 读取一个 key 的真实值（apply 时注入 config.env） */
export function readCredentialKey(key: string): string {
  try {
    const home = process.env.CTI_USER_HOME || os.homedir();
    const p = path.join(home, '.dsh', '.credentials.yaml');
    if (!fs.existsSync(p)) return '';
    const txt = fs.readFileSync(p, 'utf-8');
    const m = txt.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)`, 'm'));
    if (!m) return '';
    return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}

/** 从老 config.env 读一个 key（兜底） */
export function readOldEnvKey(key: string, oldEnvFile?: string): string {
  try {
    const f = oldEnvFile || path.join(os.homedir(), '.agents-to-im', 'config.env');
    if (!fs.existsSync(f)) return '';    const txt = fs.readFileSync(f, 'utf-8');
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)`, 'm'));
    if (!m) return '';
    return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}

/**
 * 读某个 agent 现有 env 文件里的键（用于 apply 时保留历史配置，避免被覆盖丢失）。
 * 2026-08-29 修复：CTI_CLAUDE_CLI_PATH 原本只存在于 config.claude.env，
 * 配置中心重新渲染时不认识它 ⇒ 丢失 ⇒ claude 回落 C:\WINDOWS\system32\claude.bat
 * ⇒ Node spawn(.bat) EINVAL ⇒ "Claude 启动失败: spawn EINVAL"。
 */
export function readAgentEnvKey(agentId: string, key: string): string {
  try {
    const home = process.env.CTI_HOME || path.join(process.env.CTI_USER_HOME || 'C:\\Users\\oadan', '.agents-to-feishu');
    const f = path.join(home, `config.${agentId}.env`);
    if (!fs.existsSync(f)) return '';
    const m = fs.readFileSync(f, 'utf-8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

/** 默认 claude CLI 路径（官方 @anthropic-ai/claude-code 的 bin/claude.exe） */
const DEFAULT_CLAUDE_CLI = 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

// ── config.env 渲染 ──

/**
 * ACP 直连型 agent 的网关 base_url 映射。
 *
 * ACP 直连型 provider（如 gemini）通过 CLI 的 `--model` + base_url/api_key 直连
 * OpenAI 兼容端点。这类 CLI 的认证机制面向自家生态（gemini 走 Google 认证头），
 * 直连火山 Ark（Authorization: Bearer）实测会 401 —— 必须经 LiteLLM 网关(4000) 中转，
 * 认证 + 模型名由 LiteLLM 处理（实测 4000 + deepseek-v4-flash 通）。
 * 命中则优先用网关地址；未命中回退 store 的 provider.baseURL（直连）。
 */
const ACP_GATEWAY_BASE_URL: Record<string, string> = {
  gemini: 'http://127.0.0.1:4000',
};

/** 取 agent 的 ACP 网关 base_url（无则返回空串，回退直连） */
function acpGatewayBaseUrl(agentId: string): string {
  return ACP_GATEWAY_BASE_URL[agentId] || '';
}

/**
 * 生成一个 agent 的 config.env 文本。
 * 包含：飞书凭证、runtime=dsh、显示名、model/provider 展示标签、MCP URL 全局键、harness/ACP 落点、端口。
 */
export function renderConfigEnv(store: ConfigStore, agent: AgentDef, globalExtra: Record<string, string> = {}): string {
  const prov = findProvider(store, agent.providerId);
  const model = prov ? findModel(store, agent.providerId, agent.modelId) : undefined;
  const prefix = `CTI_BOT_${agent.id.toUpperCase()}_`;
  // 工作目录：unified（store.defaultWorkdir）+ per-agent 覆盖，不再硬编码 C:\D\opt
  const workdir = resolveAgentWorkdir(store, agent);
  const botHome = path.join(process.env.CTI_USER_HOME || 'C:\\Users\\oadan', '.dsh', `${agent.id}-bot`);
  const harness = globalExtra.CTI_DSH_HARNESS_PATH || process.env.CTI_DSH_HARNESS_PATH || 'C:\\D\\opt\\deepseek-harness\\deepseek-harness';
  // 引擎类型：dsh（DSH harness ACP） vs CLI 型（opencode/reasonix/claude 等，走各自 CLI/app-server）
  const isDsh = !agent.runtime || agent.runtime === 'dsh';

  // 收集该 agent 勾选的 MCP 全局 URL（历史上用 CTI_MCP_* 全局键，现统一由 cordis.yml 承载，这里保留展示兼容）
  const mcpGlobalKeys: string[] = [];
  for (const mcpId of agent.mcps) {
    const m = store.mcps.find((x) => x.id === mcpId);
    if (m && m.url) mcpGlobalKeys.push(`# CTI_MCP_${m.id.toUpperCase()}_URL=${m.url}`);
  }

  const lines: string[] = [];
  lines.push(`# agents-to-feishu agent: ${agent.id} —— 由配置中心渲染生成，勿手改（源: config-store.json）`);
  lines.push(`CTI_BOT=${agent.id}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_APP_ID=${agent.appId}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_APP_SECRET=${agent.appSecret}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_RUNTIME=${agent.runtime || 'dsh'}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_AGENT_NAME=${agent.displayName}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_MODEL_GROUP=${model?.label || model?.id || agent.modelId}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_MODEL_PROVIDER=${prov?.displayName || prov?.id || agent.providerId}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_SHOW_TOOL_CALL_CARDS=${agent.showToolCallCards}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_SHOW_AGENT_DIVIDER=${agent.showAgentDivider}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_SHOW_THINKING_CARDS=${agent.showThinkingCards !== false}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_DASHBOARD_PORT=${agent.port}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_PROVIDER_ID=${agent.providerId || ''}`);
  // 状态栏显示模式（2026-08-30 老大要求二选一）：full=图标+文字 | icon=仅图标
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_DIVIDER_MODE=${agent.dividerMode || 'full'}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_CONTEXT_WINDOW=${model?.contextWindow || 1000000}`);
  // 飞书内置能力白名单（缺省全开）：逗号分隔，mcp-stdio 按此过滤 lark 工具
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_LARK_TOOLS=${(agent.feishuCaps && agent.feishuCaps.length ? agent.feishuCaps : ['list_chats', 'chat_history', 'send_text', 'send_image', 'create_doc', 'get_doc_text', 'bot_directory', 'send_post', 'send_as_user', 'chat_members']).join(',')}`);
  // 真实模型 ID + 网关 base_url（provider 端读这两个跑真实值，而非只读展示标签 MODEL_GROUP）
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_MODEL=${model?.id || agent.modelId}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_BASE_URL=${acpGatewayBaseUrl(agent.id) || prov?.baseURL || ''}`);
  if (agent.runtime === 'zcode') {
    // zcode 穿透：真实 key 随 config.<bot>.env 下发，provider 组装 ZCode Protocol 的
    // runtimeModel（inline apiKey）在 session/create|resume 时注入——网页切 provider/model
    // → apply → 下条消息生效。key 来源与 claude 的 ANTHROPIC_AUTH_TOKEN 同源（凭证层）。
    const zk = (prov?.apiKeyEnv ? (readCredentialKey(prov.apiKeyEnv) || readOldEnvKey(prov.apiKeyEnv)) : '') || '';
    lines.push(`CTI_BOT_${agent.id.toUpperCase()}_API_KEY=${zk}`);
    // zcode MCP 穿透：勾选的 MCP 池渲染成 JSON，provider 映射为协议 mcpServers
    // （stdio → command/args/env；streamable-http/sse → http/sse + url），session/create|resume 下发。
    const mcpDefs = (agent.mcps || [])
      .map((id) => store.mcps.find((m) => m.id === id))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({
        id: m.id,
        displayName: m.displayName,
        transport: m.transport,
        url: m.url || '',
        command: m.command || '',
        args: m.args || [],
        env: m.env || {},
      }));
    lines.push(`CTI_BOT_${agent.id.toUpperCase()}_MCP_SERVERS=${JSON.stringify(mcpDefs)}`);
    // 思考深度穿透：off = 关思考提效（GLM-5.3 默认思考可单轮 1.9 万字，💭滑窗高频全换）
    lines.push(`CTI_BOT_${agent.id.toUpperCase()}_THINKING_LEVEL=${agent.thinkingLevel || 'default'}`);
  }
  lines.push('');
  // 注入（systemPrompt）：统一注入(全局) + 独立注入(该 agent)。值用 JSON 字符串编码，
  // loadConfig 读取时 JSON.parse 还原（支持多行/引号）。空字符串也写，保证键存在。
  const globalInject = store.injection?.enabled === false ? '' : (store.injection?.global ?? '');
  lines.push('# ── systemPrompt 注入：统一(全局) + 独立(本 agent) ──');
  lines.push(`CTI_SYSTEM_PROMPT_GLOBAL=${JSON.stringify(globalInject)}`);
  lines.push(`CTI_BOT_${agent.id.toUpperCase()}_SYSTEM_PROMPT=${JSON.stringify(agent.systemPrompt ?? '')}`);
  lines.push('');
  lines.push(`CTI_DEFAULT_WORKDIR=${workdir}`);
  if (agent.runtime === 'claude') {
    // claude 引擎：CLI 路径必须显式保留。丢失会让 provider 回落 .bat ⇒ spawn EINVAL。
    // 优先级：现有 env 值 > 进程环境 > 官方默认路径
    const cliPath = readAgentEnvKey(agent.id, 'CTI_CLAUDE_CLI_PATH')
      || process.env.CTI_CLAUDE_CLI_PATH
      || (fs.existsSync(DEFAULT_CLAUDE_CLI) ? DEFAULT_CLAUDE_CLI : 'claude');
    lines.push(`# claude CLI 路径（勿删：丢失会导致 spawn EINVAL —— provider 会回落到 .bat）`);
    lines.push(`CTI_CLAUDE_CLI_PATH=${cliPath}`);
  }
  if (isDsh) {
    // DSH harness 接入（仅 dsh 引擎需要）
    lines.push(`CTI_DSH_HARNESS_PATH=${harness}`);
    lines.push(`CTI_DSH_ACP_CONFIG=${path.join(botHome, 'cordis.yml')}`);
    lines.push(`CTI_DSH_ACP_CWD=${workdir}`);
    lines.push('');
  } else {
    // 非 dsh 引擎（claude/codex/mimo/...）：engine/readCacheStats 也靠 CTI_DSH_ACP_CONFIG
    // 定位该 agent 的 stats 目录（~/.dsh/<bot>/stats），缺失会 fallback 到 dsh-bot 读错文件。
    lines.push(`CTI_DSH_ACP_CONFIG=${path.join(botHome, 'cordis.yml')}`);
    lines.push('');
  }
  lines.push('# ── 子进程环境（provider key 由凭证层注入下方 globalExtra）──');
  lines.push(`CTI_USER_HOME=${process.env.CTI_USER_HOME || 'C:\\Users\\oadan'}`);
  lines.push('');
  // 全局键（展示用）
  if (mcpGlobalKeys.length) {
    lines.push('# ── 该 agent 勾选的 MCP（由 cordis.yml 实际承载，此处仅记录）──');
    lines.push(...mcpGlobalKeys);
  }
  lines.push('');
  // 注入其他全局键（如 OPENAI_API_KEY / ARK_API_KEY / GW_API_KEY 的具体值由凭证层写）
  for (const [k, v] of Object.entries(globalExtra)) {
    if (k.startsWith('CTI_BOT_')) continue;
    lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

// ── cordis.yml 渲染 ──

/**
 * 生成一个 agent 的 cordis.yml 全文。
 * 依据 store 的 provider 定义生成 llm-* 插件段；按 agent.mcps 生成 dsh-mcp-client 实例段；
 * acp-agent.provider/model 指向所选。
 */
export function renderCordisYml(store: ConfigStore, agent: AgentDef): string {
  const prov = findProvider(store, agent.providerId);
  if (!prov) throw new Error(`agent ${agent.id} 的 provider "${agent.providerId}" 不存在`);
  const model = findModel(store, agent.providerId, agent.modelId);
  if (!model) throw new Error(`provider ${prov.id} 没有模型 "${agent.modelId}"`);

  const botHome = path.join(process.env.CTI_USER_HOME || 'C:\\Users\\oadan', '.dsh', `${agent.id}-bot`);
  const personaPath = path.join(botHome, 'persona.md');

  const L: string[] = [];
  L.push(`# ${agent.displayName} bot ACP automation server composition (agents-to-feishu config-center owned).`);
  L.push(`# Generated from config-store.json by src/config-center/render.ts — DO NOT EDIT BY HAND.`);
  L.push(`# Spawned by the DshProvider via:`);
  L.push(`#   node --import tsx/esm <harness>/packages/examples/acp-demo/src/bin.ts --config this-file`);
  L.push(`# Env injected: DEEPSEEK_API_KEY, DSH_PERMISSION_MODE=danger-full-access, and provider key (${prov.apiKeyEnv}).`);
  L.push('');

  // LLM provider 段
  if (prov.plugin === 'llm-pi-ai') {
    L.push(`# LLM provider: ${prov.displayName} (llm-pi-ai / openai-completions 直连)`);
    L.push('- id: llm-pi-ai');
    L.push("  name: '@deepseek-ai/dsh-llm-pi-ai'");
    L.push('  config:');
    L.push('    providers:');
    L.push(`      ${prov.id}:`);
    L.push(`        api: ${prov.api || 'openai-completions'}`);
    L.push(`        baseURL: ${prov.baseURL}`);
    L.push(`        displayName: ${prov.displayName}`);
    L.push(`        apiKeyEnv: ${prov.apiKeyEnv}`);
    // 2026-08-29 修复"思考层消失"：llm-pi-ai 对手工声明的模型默认视为"不会思考"
    // （无 reasoning 元数据），必须声明 thinkingFormat + reasoning 默认档 + 每模型
    // reasoningEfforts，模型才会吐 agent_thought_chunk（ACP 探针实测回归）。
    // 2026-08-30 思考深度开关：thinkingLevel=off 时不声明 ⇒ 模型按"不会思考"跑，干活快。
    const dshThinkOff = agent.thinkingLevel === 'off';
    if (!dshThinkOff) {
      L.push('        thinkingFormat: deepseek');
      L.push('        reasoning: high');
    }
    L.push('        models:');
    for (const m of prov.models) {
      L.push(`          - id: ${m.id}`);
      if (!dshThinkOff) {
        L.push('            reasoningEfforts:');
        L.push('              high: high');
      }
      // 2026-08-30 修复：pi-ai 在「模型 reasoning=true + compat 允许」时把系统提示按
      // role=developer 发送（openai-completions.js:787）。豆包 ark 的 GLM 只接受
      // system/assistant/user/tool ⇒ 400 InvalidParameter。关掉该开关后统一用 system，
      // 各家 OpenAI 兼容后端都认；思考层（thinkingFormat/reasoning）不受影响。
      // ⚠ compat 是【模型级】字段（llm-pi-ai modelFields.compat），放 provider 级会导致
      // provider 配置被 schema 拒绝 ⇒ "no adapter registered for provider"。
      L.push('            compat:');
      L.push('              supportsDeveloperRole: false');
    }
  } else {
    // llm-deepseek（官方协议，经 baseURL 可走网关）
    L.push(`# LLM provider: ${prov.displayName} (llm-deepseek)`);
    L.push('- id: llm-deepseek');
    L.push("  name: '@deepseek-ai/dsh-llm-deepseek'");
    L.push('  config:');
    L.push('    thinking: enabled');
    L.push('    reasoningEffort: high');
    if (prov.baseURL) L.push(`    baseURL: ${prov.baseURL}`);
    L.push(`    apiKeyEnv: ${prov.apiKeyEnv}`);
    L.push('    models:');
    for (const m of prov.models) {
      L.push(`      - id: ${m.id}`);
    }
  }
  L.push('');

  // 基础插件段（sandbox / subprocess / bash / approval / acp-agent / token-meter / compaction …）
  L.push('# Sandbox.');
  L.push('- id: sandbox');
  L.push("  name: '@deepseek-ai/dsh-sandbox-local'");
  L.push('');
  L.push('- id: sandbox-policy');
  L.push("  name: '@deepseek-ai/dsh-sandbox-policy'");
  L.push('  config:');
  L.push('    mode: !!js "process.env.DSH_PERMISSION_MODE ?? \'workspace-write\'"');
  L.push('    workspaceRoot: !!js process.cwd()');
  L.push('');
  L.push('- id: subprocess');
  L.push("  name: '@deepseek-ai/dsh-subprocess-local'");
  L.push('');
  L.push('- id: bash');
  L.push("  name: '@deepseek-ai/dsh-bash-local'");
  L.push('  config:');
  L.push('    timeoutMs: 60000');
  L.push('');
  L.push('- id: approval');
  L.push("  name: '@deepseek-ai/dsh-user-approval'");
  L.push('  config:');
  L.push('    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? \'workspace-write\') === \'danger-full-access\' ? \'never\' : \'ask\'"');
  L.push('');
  L.push('# The ACP automation app: agent spine + JSONL persistence + protocol bridge.');
  L.push('- id: acp-agent');
  L.push("  name: '@deepseek-ai/dsh-acp-demo'");
  L.push('  config:');
  L.push(`    provider: ${prov.id}`);
  L.push(`    model: ${model.id}`);
  L.push(`    persistenceRoot: !!js "process.env.DSH_BOT_SESSIONS_ROOT ?? '${botHome.replace(/\\/g, '/')}/sessions'"`);
  L.push("    persistenceCompression: 'zstd'");
  L.push('    workspaceContext:');
  L.push('      maxBytes: 65536');
  L.push(`    persona: !!js "process.getBuiltinModule('node:fs').readFileSync('${personaPath.replace(/\\/g, '/')}', 'utf8')"`);
  L.push('');
  L.push('- id: token-meter');
  L.push("  name: '@deepseek-ai/dsh-token-meter'");
  L.push('');
  L.push('- id: compaction-basic');
  L.push("  name: '@deepseek-ai/dsh-compaction-basic'");
  L.push('  config:');
  L.push('    thresholdRatio: 0.8');
  L.push('    retainRatio: 0.08');
  L.push('    maxTokens: 16384');
  L.push('    compactionRetries: 2');
  L.push('');
  L.push('- id: session-projection');
  L.push("  name: '@deepseek-ai/dsh-session-projection'");
  L.push('');
  L.push('- id: subagent');
  L.push("  name: '@deepseek-ai/dsh-subagent'");
  L.push('');
  L.push('- id: subagent-spawn-in-process');
  L.push("  name: '@deepseek-ai/dsh-subagent-spawn-in-process'");
  L.push('  config:');
  L.push('    providerName: spawn');
  L.push('');
  L.push('- id: subagent-fork-in-process');
  L.push("  name: '@deepseek-ai/dsh-subagent-fork-in-process'");
  L.push('  config:');
  L.push('    providerName: fork');
  L.push('');
  L.push('- id: tool-subagent-control');
  L.push("  name: '@deepseek-ai/dsh-tool-subagent-control'");
  L.push('');
  L.push('- id: tool-subagent-list-agents');
  L.push("  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'");
  L.push('');
  L.push('- id: tool-subagent-report');
  L.push("  name: '@deepseek-ai/dsh-tool-subagent-report'");
  L.push('');
  L.push('- id: tool-subagent');
  L.push("  name: '@deepseek-ai/dsh-tool-subagent'");
  L.push('  config:');
  L.push('    provider: spawn');
  L.push('    toolName: subagent');
  L.push('    backgroundMode: continuable');
  L.push('    maxDepth: 1');
  L.push('');
  L.push('- id: tool-subagent-fork');
  L.push("  name: '@deepseek-ai/dsh-tool-subagent'");
  L.push('  config:');
  L.push('    provider: fork');
  L.push('    toolName: subagent_fork');
  L.push('    backgroundMode: one-shot');
  L.push('    enableRunInBackground: false');
  L.push('    maxDepth: 1');
  L.push('');
  L.push('- id: workflow-worker-thread');
  L.push("  name: '@deepseek-ai/dsh-workflow-worker-thread'");
  L.push('  config:');
  L.push('    provider: spawn');
  L.push('');
  L.push('- id: tool-workflow');
  L.push("  name: '@deepseek-ai/dsh-tool-workflow'");
  L.push('');
  L.push('- id: tool-ralph');
  L.push("  name: '@deepseek-ai/dsh-tool-ralph'");
  L.push('');
  L.push('- id: tool-todo');
  L.push("  name: '@deepseek-ai/dsh-tool-todo'");
  L.push('  config:');
  L.push('    allowParallelInProgress: true');
  L.push('');
  L.push('- id: fs-sandbox');
  L.push("  name: '@deepseek-ai/dsh-fs-sandbox'");
  L.push('  config:');
  L.push('    cwd: !!js process.cwd()');
  L.push('');
  L.push('- id: fs-observation-policy');
  L.push("  name: '@deepseek-ai/dsh-fs-observation-policy'");
  L.push('');
  L.push('- id: tool-fs');
  L.push("  name: '@deepseek-ai/dsh-tool-fs'");
  L.push('');

  // 内建技能库（项目自带 skills/ 目录，可分发，不依赖 dsh）
  // 挂载白名单语义：
  //   skills 字段未配置(undefined) → 挂全部（默认向后兼容）
  //   skills.enabled 存在（含空数组）→ 严格按白名单过滤，空数组 = 全部停用（不挂）
  const skillNames: string[] = [];
  try {
    if (fs.existsSync(PROJECT_SKILLS_DIR)) {
      for (const ent of fs.readdirSync(PROJECT_SKILLS_DIR, { withFileTypes: true })) {
        if (ent.isDirectory() && fs.existsSync(path.join(PROJECT_SKILLS_DIR, ent.name, 'SKILL.md'))) skillNames.push(ent.name);
      }
    }
  } catch { /* 忽略 */ }
  const hasSkillCfg = store.skills !== undefined && Array.isArray(store.skills.enabled);
  const enabledList = hasSkillCfg ? store.skills!.enabled.slice() : skillNames.slice();
  const mounted = skillNames.filter((n) => enabledList.includes(n));
  L.push(`# Skills 挂载：项目内建 skills/（${PROJECT_SKILLS_DIR.replace(/\\/g, '/')}）`);
  L.push(`# 启用 ${mounted.length}/${skillNames.length} 个技能：${mounted.length ? mounted.join(', ') : '(无)'}`);
  if (mounted.length > 0) {
    L.push('- id: skill-filesystem');
    L.push("  name: '@deepseek-ai/dsh-skill-filesystem'");
    L.push('  config:');
    L.push('    customSkillDirs:');
    for (const s of mounted) L.push(`      - '${path.join(PROJECT_SKILLS_DIR, s).replace(/\\/g, '/')}'`);
  }
  L.push('');

  // MCP 客户端段（按勾选）
  L.push(`# MCP clients (${agent.mcps.length} enabled from config-center)`);
  for (const mcpId of agent.mcps) {
    const m = store.mcps.find((x) => x.id === mcpId);
    if (!m) continue;
    renderMcpBlock(L, m);
  }
  if (agent.mcps.length === 0) {
    L.push('# (none)');
  }
  L.push('');

  // 内置工具插件（2026-08-29 方向定调：dsh 的看图/生图等由桥接自有插件承载，不走 MCP）。
  // vendor/cti-builtin-tools = 桥接第一方插件（收编自 @oadank/dsh-input-tools，摘除 webServer
  // 依赖），由 src/tools/dsh-inject.ts 启动时部署到 <bot>/node_modules/。
  // ESM 以配置文件目录为解析锚点，故部署目标必须是 dsh-bot/node_modules/。
  L.push(`# Built-in tools plugin (bridge-owned first-party; NOT an MCP client)`);
  L.push(`- id: cti-builtin-tools`);
  L.push(`  name: 'cti-builtin-tools'`);
  L.push('');

  return L.join('\n');
}

/** 渲染一个 MCP 插件实例段 */
function renderMcpBlock(L: string[], m: McpDef): void {
  L.push(`- id: mcp-${m.id.replace(/[^a-z0-9-]/gi, '-')}`);
  L.push("  name: '@deepseek-ai/dsh-mcp-client'");
  L.push('  config:');
  L.push(`    transport: '${m.transport}'`);
  L.push(`    serverName: '${m.serverName}'`);
  if (m.transport === 'streamable-http') {
    if (m.url) L.push(`    url: '${m.url}'`);
  } else {
    if (m.command) L.push(`    command: '${m.command}'`);
    if (m.args?.length) L.push(`    args: ${JSON.stringify(m.args)}`);
    if (m.env && Object.keys(m.env).length) {
      L.push('    env:');
      for (const [k, v] of Object.entries(m.env)) {
        L.push(`      ${k}: '${v}'`);
      }
    }
  }
  L.push(`    failOnStartupError: ${m.failOnStartupError !== false}`);
  if (m.toolCallTimeoutMs) L.push(`    toolCallTimeoutMs: ${m.toolCallTimeoutMs}`);
  L.push('');
}

// ── 落盘 ──

/** 把一个 agent 的 config.env + cordis.yml 写到目标位置（配置中心调用） */
export function writeAgentArtifacts(
  _store: ConfigStore,
  agent: AgentDef,
  _globalExtra: Record<string, string> = {},
  /** 本次请求显式提供的键（用户明确要改它 ⇒ 可覆盖受保护键） */
  explicitKeys: Set<string> = new Set(),
): { configEnv: string; cordisYml: string; configEnvPath: string; cordisYmlPath: string } {
  // 注入 provider 的真实 key（从 .credentials.yaml / 老 config.env 读），否则模型无法调用
  const prov = findProvider(_store, agent.providerId);
  const globalExtra: Record<string, string> = { ..._globalExtra };
  if (prov?.apiKeyEnv) {
    const real = readCredentialKey(prov.apiKeyEnv) || readOldEnvKey(prov.apiKeyEnv);
    if (real) globalExtra[prov.apiKeyEnv] = real;
  }
  // OPENAI_API_KEY 兜底（llm-pi-ai 某些后端走它）
  if (!globalExtra.OPENAI_API_KEY) {
    const oa = readCredentialKey('LITELLM_API_KEY') || readCredentialKey('OPENAI_API_KEY') || readOldEnvKey('OPENAI_API_KEY');
    if (oa) globalExtra.OPENAI_API_KEY = oa;
  }
  // 官方真 claude（@anthropic-ai/claude-code CLI）直连网关所需的 env：
  // provider（claude.ts）读 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 灌给 claude.exe；
  // 权限默认 bypassPermissions（全能力、最全权限、自动审批，不弹确认）；
  // 模型不识别（第三方模型走网关）时按 1M 上下文处理并消告警。
  if (agent.runtime === 'claude') {
    const cProv = prov || findProvider(_store, agent.providerId);
    if (cProv?.baseURL) globalExtra.ANTHROPIC_BASE_URL = cProv.baseURL.replace(/\/+$/, '');
    const cKey = (cProv?.apiKeyEnv ? (readCredentialKey(cProv.apiKeyEnv) || globalExtra[cProv.apiKeyEnv] || '') : '');
    if (cKey) globalExtra.ANTHROPIC_AUTH_TOKEN = cKey;
    globalExtra.ANTHROPIC_MODEL = globalExtra.ANTHROPIC_MODEL
      || (prov ? (findModel(_store, agent.providerId, agent.modelId)?.id || agent.modelId) : agent.modelId);
    globalExtra.ANTHROPIC_PERMISSION_MODE = globalExtra.ANTHROPIC_PERMISSION_MODE || 'bypassPermissions';
    globalExtra.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1';
    globalExtra.CLAUDE_CODE_MAX_CONTEXT_TOKENS = globalExtra.CLAUDE_CODE_MAX_CONTEXT_TOKENS || '1000000';
  }

  // 模型联动：把 config-store 选的 provider/model 写进该 agent 的 CLI 配置
  // （13600 网页切模型 → apply → 各 CLI 自动联动，无需手改 CLI 配置）
  syncModelToCli(_store, agent, globalExtra);

  const configEnv = renderConfigEnv(_store, agent, globalExtra);
  const isDsh = !agent.runtime || agent.runtime === 'dsh';
  let cordisYml = '';
  if (isDsh) {
    cordisYml = renderCordisYml(_store, agent);
  }
  // 非 dsh（CLI 型 provider）不走 DSH harness，无需 cordis.yml（agent 各自 CLI 引擎）

  // 2026-08-29 修复：写入目录必须与读取方 loadConfig（config.ts:106：CTI_HOME || USERPROFILE/.agents-to-feishu）
  // 同源解析，否则只设 CTI_HOME 没设 CTI_USER_HOME 时会"配置中心写成功、bot 读的是另一份"。
  const configHome = process.env.CTI_HOME
    || path.join(process.env.CTI_USER_HOME || process.env.USERPROFILE || 'C:\\Users\\oadan', '.agents-to-feishu');
  const configEnvPath = path.join(configHome, `config.${agent.id}.env`);
  const cordisYmlPath = path.join(process.env.CTI_USER_HOME || 'C:\\Users\\oadan', '.dsh', `${agent.id}-bot`, 'cordis.yml');

  fs.mkdirSync(path.dirname(configEnvPath), { recursive: true });
  fs.mkdirSync(path.dirname(cordisYmlPath), { recursive: true });
  // 2026-08-29 精准穿透：不再整篇覆盖。
  // env = 键级合并（保留模板不认识的键；受保护键只补全不覆盖）；
  // cordis.yml = 托管区替换（区外人工/插件条目永不碰）。两者都自动备份 + 审计。
  writeEnvMerged(configEnvPath, configEnv, agent.id, explicitKeys);
  if (isDsh) {
    writeCordisMerged(cordisYmlPath, cordisYml, agent.id);
    // 生成 persona.md：cordis.yml 的 acp-agent 段用 readFileSync 引用它，缺失会导致
    // 插件树加载失败（ENOENT persona.md）→ acp-demo 崩溃 → ACP 全部超时（"ACP request 100 timeout"）。
    // 内容 = 统一注入(全局) + 独立注入(本 agent)，拼接规则对齐 config.ts buildInjectedSystemPrompt。
    const personaGlobal = _store.injection?.enabled === false ? '' : (_store.injection?.global ?? '');
    const personaCustom = agent.systemPrompt ?? '';
    const personaBody = [personaGlobal, personaCustom].filter((s) => s && s.trim()).join('\n\n---\n\n');
    const personaPath = path.join(process.env.CTI_USER_HOME || 'C:\\Users\\oadan', '.dsh', `${agent.id}-bot`, 'persona.md');
    fs.mkdirSync(path.dirname(personaPath), { recursive: true });
    fs.writeFileSync(personaPath, personaBody, 'utf-8');
  }
  return { configEnv, cordisYml, configEnvPath, cordisYmlPath };
}

// ── 模型联动：config-store 选的 provider/model → 各 CLI 配置文件 ──
// 13600 网页切换模型（provider/model）→ apply → 重新渲染 → 这里把
// base_url / model（CLI 实际模型名） / api_key_env 写进该 agent 使用的 CLI 配置，
// 实现"网页切模型，CLI 自动联动"。CLI 端读自己配置，不依赖 CTI_* env。

/** provider 下的 CLI 实际模型名（CLI 端 ≠ config-store model.id 时映射；缺省用 model.id） */
const CLI_MODEL_NAMES: Record<string, Record<string, string>> = {
  gw: { 'deepseek-v4-flash': 'deepseek-v4-flash-0731' }, // GW 端点实际模型名
  'volc-ark': { 'deepseek-v4-flash': 'deepseek-v4-flash' },
  'deepseek-official': { 'deepseek-v4-flash': 'deepseek-v4-flash' },
};

/** 把 model.id 映射为 CLI 端实际模型名 */
function cliModelName(providerId: string, modelId: string): string {
  return (CLI_MODEL_NAMES[providerId] && CLI_MODEL_NAMES[providerId][modelId]) || modelId;
}

/**
 * 在 TOML 文本里把顶层 key 或指定 section 内的 key 替换为 newValue（保留缩进/其余结构）。
 * 用逐行定位（避开 \r\n / 空行 / 嵌套 section 的正则前瞻坑）：
 *   - 顶层：只扫第一个 section 头之前的行
 *   - section：定位 [section] 头，到下一个 [ 头或末尾之间的首处匹配
 * 找不到匹配 key 时不改动（保持幂等安全）。
 */
function setTomlValue(toml: string, key: string, newValue: string, section?: string): string {
  const v = /^[A-Za-z0-9_./:-]+$/.test(newValue) ? `"${newValue}"` : JSON.stringify(newValue);
  const lines = toml.split(/\r?\n/);
  if (!section) {
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*$/.test(lines[i])) continue;         // 跳过空行
      if (/^\s*\[/.test(lines[i])) break;            // 遇到第一个 section 头即停（顶层 key 在此之前）
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
        lines[i] = lines[i].replace(/^(\s*).*$/, `$1${key} = ${v}`);
        break;
      }
    }
    return lines.join('\n');
  }
  const target = `[${section}]`;
  let inSec = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSec = trimmed === target;                    // 只有精确匹配的 section 头才进入
      continue;
    }
    if (!inSec) continue;
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*).*$/, `$1${key} = ${v}`);
      break;
    }
  }
  return lines.join('\n');
}

/** 在 YAML 文本里把嵌套 key（如 model.default）替换为 newValue（只认顶层缩进的键，保留注释） */
function setYamlValue(yaml: string, dotted: string, newValue: string): string {
  const parts = dotted.split('.');
  const indent = '  '.repeat(parts.length - 1);
  const leaf = parts[parts.length - 1];
  const re = new RegExp(`^(\\s{${indent.length}})${leaf}\\s*:.*$`, 'm');
  const v = /^[A-Za-z0-9_./:-]+$/.test(newValue) ? `"${newValue}"` : JSON.stringify(newValue);
  if (re.test(yaml)) return yaml.replace(re, `$1${leaf}: ${v}`);
  return yaml;
}

/**
 * 确保 codex config.toml 里存在 [model_providers.<provName>] 段并写入 base_url/env_key/wire_api=responses。
 * 段已存在则就地更新；不存在则追加整段。返回新 toml 文本。
 */
function ensureCodexProvider(toml: string, provName: string, baseUrl: string, keyEnv: string): string {
  const section = `model_providers.${provName}`;
  const secRe = new RegExp(`^\\s*\\[${section.replace(/[.]/g, '\\.')}\\]\\s*$`, 'm');
  if (!secRe.test(toml)) {
    // 追加新段：name / base_url / env_key / wire_api=responses
    return toml.replace(/\s*$/, '\n')
      + `\n[${section}]\nname = "${provName}"\nbase_url = "${baseUrl}"\nenv_key = "${keyEnv}"\nwire_api = "responses"\n`;
  }
  let t = setTomlValue(toml, 'base_url', baseUrl, section);
  t = setTomlValue(t, 'env_key', keyEnv, section);
  t = setTomlValue(t, 'wire_api', 'responses', section);
  return t;
}

/** 根据 agent.runtime 把 provider/model/key 写进对应 CLI 配置文件（幂等，不存在则跳过） */
export function syncModelToCli(store: ConfigStore, agent: AgentDef, globalExtra: Record<string, string> = {}): void {
  const hunme = process.env.CTI_USER_HOME || 'C:\\Users\\oadan';
  const prov = findProvider(store, agent.providerId);
  const modelId = findModel(store, agent.providerId, agent.modelId)?.id || agent.modelId;
  if (!prov) return;
  const baseUrl = prov.baseURL || globalExtra[`${prov.id.toUpperCase().replace(/-/g, '_')}_BASE_URL`] || '';
  const keyEnv = prov.apiKeyEnv || 'OPENAI_API_KEY';
  const cliModel = cliModelName(prov.id, modelId);
  const rt = agent.runtime || 'dsh';
  const errs: string[] = [];

  try {
    switch (rt) {
      case 'openakita': {
        // ~/.openakita/workspaces/default/data/llm_endpoints.json → endpoints[0]
        const f = path.join(hunme, '.openakita', 'workspaces', 'default', 'data', 'llm_endpoints.json');
        if (!fs.existsSync(f)) break;
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (Array.isArray(j.endpoints) && j.endpoints.length > 0) {
          j.endpoints[0].base_url = baseUrl || j.endpoints[0].base_url;
          j.endpoints[0].model = cliModel;
          j.endpoints[0].api_key_env = keyEnv;
          j.endpoints[0].note = `同步自配置中心 provider=${prov.id} model=${modelId} (${new Date().toISOString().slice(0, 10)})`;
          fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf-8');
        }
        break;
      }
      case 'opencode': {
        // ~/.config/opencode/opencode.json → model + provider 定义
        const f = path.join(hunme, '.config', 'opencode', 'opencode.json');
        if (!fs.existsSync(f)) break;
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const pk = prov.id.replace(/-/g, '');
        j.model = `${pk}/${cliModel}`;
        j.provider = j.provider || {};
        j.provider[pk] = {
          npm: '@ai-sdk/openai-compatible',
          name: prov.displayName || pk,
          options: { baseURL: baseUrl, apiKey: `{env:${keyEnv}}` },
        };
        fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf-8');
        break;
      }
      case 'gemini': {
        // ~/.gemini/settings.json → model.name
        const f = path.join(hunme, '.gemini', 'settings.json');
        if (!fs.existsSync(f)) break;
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        j.model = j.model || {};
        j.model.name = cliModel;
        fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf-8');
        break;
      }
      case 'codex':
        // codex 只支持 OpenAI Responses 协议（wire_api 固定 "responses"，新版不允许 "chat"）。
        // 方案：预置 3 个可用 responses 端点——
        //   1) volcark  直连 volc-ark（实测支持 /responses）
        //   2) gw       直连 GW   （实测支持 /responses）
        //   3) litellm  经 LiteLLM 网关转接（阿里云等不支持 /responses，靠网关转 chat→responses）
        // 并依 config-store 当前选的 provider 切换 active model_provider + model。
        {
          const f = path.join(hunme, '.codex', 'config.toml');
          if (fs.existsSync(f)) {
            let t = fs.readFileSync(f, 'utf-8');
            // 预置三个 responses 端点（幂等，缺失追加）
            t = ensureCodexProvider(t, 'volcark', 'https://ark.cn-beijing.volces.com/api/plan/v3', 'ARK_API_KEY');
            t = ensureCodexProvider(t, 'gw', 'https://gateway.henry-gao.com/v1', 'GW_API_KEY');
            t = ensureCodexProvider(t, 'litellm', 'http://localhost:4000', 'LITELLM_API_KEY');
            // active 切换
            const isGw = prov.id === 'gw';
            const viaLiteLLM = prov.id === 'litellm' || prov.id === 'ali' || (baseUrl && /localhost:4000/.test(baseUrl));
            const activeProv = isGw ? 'gw' : viaLiteLLM ? 'litellm' : 'volcark';
            const activeModel = isGw ? 'deepseek-v4-flash-0731' : cliModel;
            t = setTomlValue(t, 'model', activeModel);
            t = setTomlValue(t, 'model_provider', activeProv);
            // 2026-08-30 思考深度开关：off=minimal（干活快）/ default=high（保持现状）/ high=high
            const codexEffort = agent.thinkingLevel === 'off' ? 'minimal' : 'high';
            t = setTomlValue(t, 'model_reasoning_effort', codexEffort);
            fs.writeFileSync(f, t, 'utf-8');
          }
        }
        break;
      case 'mimo': {
        // ~/.config/mimocode/mimocode.json：model + provider.<pk>（mimo 用 api 字段做 base_url）
        const f = path.join(hunme, '.config', 'mimocode', 'mimocode.json');
        if (!fs.existsSync(f)) break;
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const pk = prov.id.replace(/-/g, '');
        j.model = `${pk}/${cliModel}`;
        j.provider = j.provider || {};
        j.provider[pk] = {
          name: prov.displayName || pk,
          npm: '@ai-sdk/openai-compatible',
          api: baseUrl,
          options: { apiKey: `{env:${keyEnv}}` },
          models: { [cliModel]: { name: cliModel } },
        };
        fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf-8');
        break;
      }
      case 'reasonix': {
        // 2026-08-30 修正：reasonix 真配置在 %APPDATA%\Roaming\reasonix\config.toml
        // （此前写到 ~/.config/reasonix/config.toml —— 那个文件没人读 ⇒ 联动从未生效）。
        // 真配置格式：default_model = "<providerId>/<model>"，providerId 须是该文件
        // [[providers]] 里声明的 id（litellm 段的 models 列表见 LiteLLM /v1/models）。
        // ⚠ 不能用 process.env.APPDATA——config-center 跑 LocalSystem 时指向 systemprofile；
        // 必须用 CTI_USER_HOME（真实用户目录，与被注入的 bot env 同源）
        const appData = path.join(hunme, 'AppData', 'Roaming');
        const f = path.join(appData, 'reasonix', 'config.toml');
        if (!fs.existsSync(f)) break;
        let t = fs.readFileSync(f, 'utf-8');
        // store 模型 → reasonix litellm 段有效名字。
        // 2026-08-30 二次修正：映射必须看 provider——同名模型不同上游在 LiteLLM 是不同名字
        // （gw 网关的 V4F = GwV4F；ark 直连的 V4F = ArkV4F）。此前只看 modelId ⇒ 用户选 gw 却写出 ArkV4F。
        const reasonixModel = modelId === 'glm-5-3-flash' ? 'litellm/Arkglm5.3'
          : modelId === 'deepseek-v4-flash' ? (prov.id === 'gw' ? 'litellm/GwV4F' : 'litellm/ArkV4F')
          : `litellm/${modelId}`;
        t = setTomlValue(t, 'default_model', reasonixModel);
        fs.writeFileSync(f, t, 'utf-8');
        break;
      }
      case 'hermes': {
        // ~/.hermes/config.yaml：
        //   model.default        —— 模型名
        //   provider: "custom:<name>" —— 实际端点由命名 provider 段 providers.<name>.base_url 决定
        // 2026-08-30 修复：此前只改 model.base_url（不生效——被 custom:<name> 覆盖），
        // 导致 hermes 一直打旧端点（LiteLLM 4000）+ 旧模型名 ⇒ 400 Invalid model name。
        // 现在同时更新：model.default、model.base_url、providers.<name>.base_url。
        // 2026-08-30 二次修复：换端点必须连 api_key 一起换（此前只换 URL 不换 key ⇒ 401 Invalid API key）。
        const f = path.join(hunme, '.hermes', 'config.yaml');
        if (!fs.existsSync(f)) break;
        let t = fs.readFileSync(f, 'utf-8');
        t = setYamlValue(t, 'model.default', cliModel);
        // key 取自该 agent 的 config env（按 provider.apiKeyEnv 命名）
        const envFile = path.join(hunme, '.agents-to-feishu', `config.${agent.id}.env`);
        const apiKey = fs.existsSync(envFile)
          ? fs.readFileSync(envFile, 'utf-8').match(new RegExp(`^${keyEnv}=(.+)$`, 'm'))?.[1]?.trim()
          : undefined;
        if (apiKey) t = setYamlValue(t, 'model.api_key', apiKey);
        if (baseUrl) {
          t = setYamlValue(t, 'model.base_url', baseUrl);
          // 解析 provider: "custom:<name>"（⚠ 嵌套在 model: 下，缩进可变 ⇒ 不锚定行首），
          // 更新对应命名 provider 段的 base_url —— 那才是 hermes 实际请求的端点
          const ref = t.match(/^(\s*)provider:\s*"custom:([^"]+)"/m)?.[2];
          if (ref) {
            const secRe = new RegExp(`^(\\s{2})${ref}:\\s*$`, 'm');
            const sec = secRe.exec(t);
            if (sec) {
              // 从该段头到下一个同级键之间，替换 base_url / api_key 行
              const start = sec.index + sec[0].length;
              const rest = t.slice(start);
              const next = rest.search(/^\s{2}[A-Za-z_]+:\s*$/m);
              const seg = rest.slice(0, next < 0 ? rest.length : next);
              let newSeg = seg.replace(/^(\s*)base_url\s*:.*$/m, `$1base_url: "${baseUrl}"`);
              if (apiKey) newSeg = newSeg.replace(/^(\s*)api_key\s*:.*$/m, `$1api_key: "${apiKey}"`);
              t = t.slice(0, start) + (next < 0 ? newSeg : newSeg + rest.slice(next));
            }
          }
        }
        fs.writeFileSync(f, t, 'utf-8');
        break;
      }
      case 'claude':
        // claude 走 Claude Code SDK（claude.ts），模型由进程 env ANTHROPIC_BASE_URL +
        // ANTHROPIC_AUTH_TOKEN 指向 LiteLLM 网关路由，CLI 无独立 model 配置文件可联动。
        break;
      case 'openclaw':
        // openclaw 无单点 model 配置文件（~/.openclaw 无 config.yaml，模型路由由
        // agent/插件体系决定），联动需人工确认接入点，暂不写入。
        break;
      default:
        // dsh（DSH harness，模型由 cordis.yml 的 acp-agent.provider/model 管理，
        // renderCordisYml 已写）及其他未知 runtime：无需 CLI 配置联动。
        break;
    }
  } catch (e) {
    errs.push(`${rt}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (errs.length) {
    console.error(`[render] syncModelToCli ${agent.id} 部分失败: ${errs.join('; ')}`);
  }
}
