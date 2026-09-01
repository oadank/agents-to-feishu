/**
 * config-center store —— 配置中心唯一真相源（config-store.json）。
 *
 * 设计原则（2026-08-25，用户确认）：
 * - config-store.json 是总管家，git 可管理，可 diff 可回滚。
 * - 网页读写它；需要时按它【渲染生成】每个 agent 的 config.env + cordis.yml。
 * - agent 进程【启动时读一次】生成好的文件，运行期不依赖配置中心 —— 配置中心挂了不影响对话。
 *
 * 三层结构：
 *   providers : 总配置 —— 可选模型/Provider 池（volc-ark / gw / litellm / deepseek-official …）
 *   mcps      : 总配置 —— 可选 MCP 服务池（agentmemory / wiki / zai-vision / visionqa / win-desktop-helper …）
 *   agents    : 分配置 —— 每个 agent 一页，从总配置池【选择】model/provider + 勾选 mcps
 *
 * 状态行字段对应（用户强调"数据必须真实"）：
 *   Agent/Model/Provider ← agents[i].displayName/modelId/providerId（写入 config.env 的 _AGENT_NAME/_MODEL_GROUP/_MODEL_PROVIDER）
 *   Session/Cache/平均/上下文 ← http 服务从 ~/.dsh/<bot>/stats/*.jsonl + ACP session 实时读
 *   余额 ← http 服务查网关/官方余额接口（5s 缓存）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 类型 ──

/** 一个 Provider（模型接入）定义 —— 总配置池的一项 */
export interface ProviderDef {
  id: string; // 唯一 id，如 'volc-ark' / 'gw' / 'litellm' / 'deepseek-official'
  displayName: string;
  /** DSH llm 插件 id：llm-pi-ai（openai 兼容直连）或 llm-deepseek（DeepSeek 官方协议） */
  plugin: 'llm-pi-ai' | 'llm-deepseek';
  /** api 类型：llm-pi-ai 支持 openai-completions / openai-responses / anthropic-messages；llm-deepseek 固定官方协议 */
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  baseURL?: string;
  /** 用哪个环境变量名存 key（如 ARK_API_KEY / GW_API_KEY / OPENAI_API_KEY） */
  apiKeyEnv: string;
  /** 可选模型列表 */
  models: ModelDef[];
}

/** 一个可选的模型 */
export interface ModelDef {
  id: string; // 如 deepseek-v4-flash / ox-alpha / agnes-text
  displayName?: string;
  /** 上下文窗口（用于状态行 上下文% 计算），默认 1000000 */
  contextWindow?: number;
  /** 状态行显示的 model 标签；缺省用 id */
  label?: string;
}

/** 一个 MCP 服务定义 —— 总配置池的一项 */
export interface McpDef {
  id: string; // 如 'agentmemory' / 'wiki' / 'zai-vision' / 'visionqa' / 'win-desktop-helper'
  displayName: string;
  transport: 'streamable-http' | 'stdio';
  serverName: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  failOnStartupError?: boolean;
  toolCallTimeoutMs?: number;
  /** 重的 MCP（要装客户端/权限，如控制电脑）：独立外接，不默认绑定 */
  external?: boolean;
}

/** 内建看图（look_image）视觉配置：只配模型即可用，项目自带实现 */
export interface VisionConfig {
  enabled: boolean;
  /** local / online（OpenAI 兼容接口） */
  provider: 'local' | 'online';
  baseUrl: string;   // 如 https://apihub.agnes-ai.cn/v1
  apiKey: string;    // 视觉模型 key（存凭证，不出现在网页明文），可在网页占位
  model: string;     // 如 agnes-2.5-flash（免费视觉，反应快）
  timeoutMs: number;
  prompts?: { describe?: string; text?: string; reverse?: string };
}

/** 一个可克隆的音色样本（voiceclone） */
export interface CloneSample {
  id: string;
  name: string;
  path: string;
  /** 该克隆音色自带的性格/风格指令（可选） */
  context?: string;
}

/** 内建语音（ASR+TTS）配置：对齐 @oadank/dsh-input-tools 的全引擎能力，可分发 */
export interface SpeechConfig {
  enabled: boolean;
  tts: {
    /** 默认引擎：edge | xiaomi | voicedesign | voiceclone | local | ali | auto（auto=按配置降级链） */
    defaultEngine: string;
    /** 微软 Edge 免费 */
    edge: { enabled: boolean; voice: string };
    /** 小米预置音色（mimo-v2.5-tts），含唱歌与音色描述底嗓 */
    xiaomi: { enabled: boolean; apiKey: string; baseUrl: string; voice: string; singing: boolean; context: string };
    /** 小米音色设计（mimo-v2.5-tts-voicedesign）：mode=ai 由 AI 生成 / fixed 用 context */
    voicedesign: {
      enabled: boolean;
      mode: 'ai' | 'fixed';
      context: string;
      aiGender: string;      // male | female | ''
      aiAge: string;         // 由 AI_AGE_LABELS 定义
      lockGender: boolean;
      lockTimbre: boolean;
      lockAge: boolean;
    };
    /** 小米音色克隆（mimo-v2.5-tts-voiceclone）：samples 数组，首个为默认 */
    voiceclone: {
      enabled: boolean;
      samplePath: string;
      context: string;
      defaultId: string;
      samples: CloneSample[];
    };
    /** 本地 MeloTTS：URL 常驻服务优先，CMD 兜底 */
    local: { enabled: boolean; url: string; cmd: string };
    /** 阿里 qwen3-tts-flash（dashscope） */
    ali: { enabled: boolean; apiKey: string; baseUrl: string; voice: string };
  };
  asr: {
    enabled: boolean;
    mode: 'service' | 'cmd' | 'api';
    url: string;
    cmd: string;
    apiKey: string;
    apiBaseUrl: string;
  };
}

/** 小米音色设计：age 可选值标签（对齐 dsh-input-tools AI_AGE_LABELS，供前端下拉/WEB 注入用） */
export const AI_AGE_LABELS: Record<string, string> = {
  infant: '婴儿感',
  child: '幼儿感',
  teen: '少年感',
  young: '青年感',
  middle: '中年感',
  old: '老年感',
};

/** 一个 Agent（分配置）—— 一个飞书 app + 一个 DSH ACP 进程 + 一个端口 */
export interface AgentDef {
  /** 唯一内部名（小写），对应 CTI_BOT_* / config.env 前缀 / 端口 */
  id: string;
  /** 显示名（状态行 Agent:） */
  displayName: string;
  /** 飞书 app 凭证 */
  appId: string;
  appSecret: string;
  /** 从总配置池选 */
  providerId: string;
  modelId: string;
  /** 勾选的 MCP id 列表 */
  mcps: string[];
  /** dashboard 端口 */
  port: number;
  /** 是否显示工具卡/分割线 */
  showToolCallCards: boolean;
  showAgentDivider: boolean;
  /** 默认工作目录（可选；缺省用 store.defaultWorkdir，再兜底 os.homedir()） */
  workdir?: string;
  /** 是否启用（false = 网页停用该 agent，不生成/不启动） */
  enabled: boolean;
  /** 引擎运行时类型：dsh | openclaw | opencode | reasonix | mimo | openakita | gemini | hermes | codex | claude */
  runtime?: string;
  /** 独立注入：该 agent 追加的 systemPrompt（拼接在统一注入之后，首条消息注入） */
  systemPrompt?: string;
  /** 状态栏样式（2026-08-30 二选一，图标+文字太长）：icon=每段只图标 | text=每段只文字 */
  dividerMode?: 'full' | 'icon' | 'text' | 'value';
  /** 思考深度：default=按 runtime 默认 | off=关闭思考提效 | high=强制深度思考（按 runtime 写对应键） */
  thinkingLevel?: 'default' | 'off' | 'high';
  /** 飞书内置能力白名单（2026-08-30 内置化）：缺省=全开。可选值 list_chats/chat_history/send_text/lookup_user/send_image */
  feishuCaps?: string[];
}

/** 顶层 config-store.json */
export interface ConfigStore {
  /** 全局开关（2026-08-31）：群聊仅 @ 本 bot 才回复（默认 true） */
  settings?: { groupMentionOnly?: boolean };
  version: number;
  providers: ProviderDef[];
  mcps: McpDef[];
  agents: AgentDef[];
  /** 内建看图配置（look_image）：只配模型即可用，项目自带实现 */
  vision?: VisionConfig;
  /** 内建语音配置（ASR 识别 + TTS 合成）：项目自带实现 */
  speech?: SpeechConfig;
  /** 注入配置：统一注入 = 全局共享 systemPrompt（所有 agent 首条消息生效） */
  injection?: InjectionConfig;
  /** 内建技能库配置：启停白名单 + 远程市场 URL（项目 skills/ 目录挂载控制） */
  skills?: SkillConfig;
  /** 全局默认工作目录（所有 agent 的缺省启动目录；每 agent 可覆盖，见 AgentDef.workdir） */
  defaultWorkdir?: string;
}

/** 内建技能库配置：控制 skills/ 目录哪些技能挂载给 agent */
export interface SkillConfig {
  /**
   * 挂载的技能名白名单。
   * - undefined / 空数组 = 挂载全部（向后兼容默认）
   * - 非空数组 = 只挂载列出的技能
   */
  enabled: string[];
  /** 远程技能市场索引 URL（可选，页面「搜索市场」拉取清单） */
  marketUrl: string;
}

export const DEFAULT_SKILLS: SkillConfig = {
  enabled: [],
  marketUrl: '',
}

/** 统一注入配置：所有 agent 生效的全局 systemPrompt（手动填，存 config-store.json） */
export interface InjectionConfig {
  enabled: boolean;
  /** 统一注入文本（镜像）：md 文件是引擎生效源，此字段存拼接全文镜像用于展示/备份 */
  global: string;
  /** 各 prompt md 内容的镜像副本（key=文件名） */
  files?: Record<string, string>;
}

/** 默认统一注入：启用但内容为空（统一注入实际内容在 config/prompts/*.md）。 */
export const DEFAULT_INJECTION: InjectionConfig = {
  enabled: true,
  global: '',
  files: {},
};

/** 默认内建看图配置：免费 agnes-ai 视觉（反应快）。apiKey 为空由凭证层注入。 */
export const DEFAULT_VISION: VisionConfig = {
  enabled: true,
  provider: 'online',
  baseUrl: 'https://apihub.agnes-ai.cn/v1',
  apiKey: '',
  model: 'agnes-2.5-flash',
  timeoutMs: 240000,
  prompts: {},
};

/** 默认内建语音配置：全引擎结构（edge 免费默认开，其余关，真实 key/样本在运行时 config-store 填）。 */
export const DEFAULT_SPEECH: SpeechConfig = {
  enabled: true,
  tts: {
    defaultEngine: 'edge',
    edge: { enabled: true, voice: 'zh-CN-XiaoxiaoNeural' },
    xiaomi: {
      enabled: false, apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1', voice: '冰糖', singing: false, context: '',
    },
    voicedesign: {
      enabled: false, mode: 'ai', context: '',
      aiGender: '', aiAge: 'young', lockGender: true, lockTimbre: true, lockAge: false,
    },
    voiceclone: {
      enabled: false, samplePath: '', context: '', defaultId: '', samples: [],
    },
    local: { enabled: false, url: '', cmd: '' },
    ali: { enabled: false, apiKey: '', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', voice: 'Cherry' },
  },
  asr: {
    enabled: true,
    mode: 'service',
    url: 'http://127.0.0.1:18790',
    cmd: '',
    apiKey: '',
    apiBaseUrl: 'https://api.xiaomimimo.com/v1',
  },
};

// ── 默认值 ──

/**
 * 默认 MCP 池。
 * 原则（用户 2026-08-25）：
 *  - 池要【丰富可增加】——各 agent 按需勾选，不删减选项。
 *  - zai-vision 已移除（看图改走内建 look_image，见 vision 段）。
 *  - 轻量、能内建的能力（看图 look_image）不走 MCP，走 config-store 的 vision 段（项目自带实现）。
 *  - 重的 MCP（要装客户端/权限，如控制电脑 win-desktop-helper）标 external，独立外接不默认绑定。
 */
export const DEFAULT_MCPS: McpDef[] = [
  {
    id: 'agentmemory', displayName: 'AgentMemory 记忆', transport: 'streamable-http',
    serverName: 'agentmemory', url: 'http://localhost:3114/mcp', failOnStartupError: false, external: true,
  },
  {
    id: 'wiki', displayName: 'Wiki 团队文档', transport: 'streamable-http',
    serverName: 'wiki', url: 'http://localhost:3456/mcp', failOnStartupError: false, external: true,
  },
  {
    id: 'visionqa', displayName: 'VisionQA 质量看图（供 ComfyUI 后端）', transport: 'streamable-http',
    serverName: 'visionqa', url: 'http://127.0.0.1:8092/mcp', failOnStartupError: false, toolCallTimeoutMs: 300000, external: true,
  },
  {
    id: 'skills', displayName: '技能库', transport: 'streamable-http',
    serverName: 'skills-http', url: 'http://127.0.0.1:1/mcp', failOnStartupError: true, external: true,
  },
  {
    id: 'win-desktop-helper', displayName: 'Windows 桌面助手（外接）', transport: 'stdio',
    serverName: 'win-desktop-helper',
    command: 'C:/Program Files/nodejs/node.exe', args: ['path/to/win-desktop-helper/mcp-bridge.js'],
    failOnStartupError: false, toolCallTimeoutMs: 120000, external: true,
  },
  {
    id: 'comfy', displayName: 'ComfyUI 生图（list_templates/generate_image/reverse_prompt）', transport: 'streamable-http',
    serverName: 'comfy-mcp', url: 'http://127.0.0.1:13600/mcp/comfy',
    failOnStartupError: false, toolCallTimeoutMs: 600000, external: true,
  },
];

/**
 * 默认 Provider 池：volc-ark 直连 + gw 直连 + deepseek-official 官方。
 * litellm(4000) 需要单独 key，先不默认塞。
 */
export const DEFAULT_PROVIDERS: ProviderDef[] = [
  {
    id: 'volc-ark', displayName: '火山 Ark 直连',
    plugin: 'llm-pi-ai', api: 'openai-completions',
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    apiKeyEnv: 'ARK_API_KEY',
    models: [
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek-V4-Flash', contextWindow: 1000000, label: 'ark-deepseek-v4' },
    ],
  },
  {
    id: 'gw', displayName: 'GW (henry-gao) 直连',
    plugin: 'llm-pi-ai', api: 'openai-completions',
    baseURL: 'https://gateway.henry-gao.com/v1',
    apiKeyEnv: 'GW_API_KEY',
    models: [
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek-V4-Flash (gw)', contextWindow: 524288, label: 'gwv4f' },
    ],
  },
  {
    id: 'deepseek-official', displayName: 'DeepSeek 官方直连',
    plugin: 'llm-deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-chat', displayName: 'DeepSeek Chat', contextWindow: 1000000 },
    ],
  },
];

// ── 读写 ──

export function defaultStorePath(home = process.env.CTI_USER_HOME || 'C:\\Users\\oadan'): string {
  return path.join(home, '.agents-to-feishu', 'config-store.json');
}

export function readStore(file?: string): ConfigStore {
  const p = file || defaultStorePath();
  if (!fs.existsSync(p)) {
    const initial: ConfigStore = {
      version: 1,
      providers: DEFAULT_PROVIDERS,
      mcps: DEFAULT_MCPS,
      agents: [],
      vision: DEFAULT_VISION,
      speech: DEFAULT_SPEECH,
      injection: DEFAULT_INJECTION,
      defaultWorkdir: '',
    };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(initial, null, 2)}\n`, 'utf-8');
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as ConfigStore;
    // 骨架兜底：老 store 缺字段时补默认
    return {
      version: parsed.version ?? 1,
      providers: parsed.providers ?? DEFAULT_PROVIDERS,
      mcps: parsed.mcps ?? DEFAULT_MCPS,
      agents: parsed.agents ?? [],
      vision: parsed.vision ?? DEFAULT_VISION,
      speech: parsed.speech ?? DEFAULT_SPEECH,
      injection: parsed.injection ?? DEFAULT_INJECTION,
      skills: parsed.skills,
      defaultWorkdir: parsed.defaultWorkdir ?? '',
      settings: parsed.settings ?? { groupMentionOnly: true },
    };
  } catch (e) {
    throw new Error(`config-store.json 解析失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function writeStore(store: ConfigStore, file?: string): void {
  const p = file || defaultStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

// ── 查询辅助 ──

export function findProvider(store: ConfigStore, id: string): ProviderDef | undefined {
  return store.providers.find((p) => p.id === id);
}

export function findModel(store: ConfigStore, providerId: string, modelId: string): ModelDef | undefined {
  const p = findProvider(store, providerId);
  return p?.models.find((m) => m.id === modelId);
}

export function findMcp(store: ConfigStore, id: string): McpDef | undefined {
  return store.mcps.find((m) => m.id === id);
}

/** 解析一个 agent 的最终工作目录：agent.workdir 优先，缺省用 store.defaultWorkdir，再兜底 os.homedir()（不再硬编码 C:\D\opt）。 */
export function resolveAgentWorkdir(store: ConfigStore, agent: AgentDef): string {
  return (
    agent.workdir?.trim()
    || store.defaultWorkdir?.trim()
    || process.env.CTI_USER_HOME
    || os.homedir()
    || ''
  );
}
