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
 *   mcps      : 总配置 —— 可选 MCP 服务池（openmem / visionqa / win-desktop-helper / comfy …）
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
  /** 用哪个环境变量名存 key（如 ARK_API_KEY / GATEWAY_API_KEY / OPENAI_API_KEY） */
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
  /**
   * 模型是否支持看图（默认 true——现役模型大多自生视觉）。
   * true/缺省：apply 时向 systemPrompt 注入「优先用自身视觉，look_image 仅兜底」降级令。
   * false：不注入，现有 look_image/看图 MCP 工具行为不变（纯文本模型手动关）。
   */
  visionCapable?: boolean;
}

/** 一个 MCP 服务定义 —— 总配置池的一项 */
export interface McpDef {
  id: string; // 如 'openmem' / 'visionqa' / 'win-desktop-helper'
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
    /** 本地 Audio8 零样本克隆 TTS（音色须先注册到 C:\D\opt\audio8-tts\voices\）
     *  url = 常驻服务地址（主路径，模型常驻内存）；cmd = CLI 兜底 */
    audio8: { enabled: boolean; url: string; cmd: string; voice: string };
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
  /** 2026-09-01 是否显示思考层（💭 blockquote）；false = 卡片完全不展示思考过程 */
  showThinkingCards: boolean;
  /** 默认工作目录（可选；缺省用 store.defaultWorkdir，再兜底 os.homedir()） */
  workdir?: string;
  /** 是否启用（false = 网页停用该 agent，不生成/不启动） */
  enabled: boolean;
  /** 引擎运行时类型：dsh | openclaw | opencode | reasonix | mimo | openakita | gemini | hermes | codex | claude */
  runtime?: string;
  /** 独立注入：该 agent 追加的 systemPrompt（拼接在统一注入之后，首条消息注入） */
  systemPrompt?: string;
  /** 状态栏样式（2026-09-01 三选一，数值任何模式下都显示）：full=图标+数值（默认，旧 icon 值按 full 渲染） | text=英文标签+数值 | value=仅数值 */
  dividerMode?: 'full' | 'text' | 'value' | (string & {});
  /** 思考深度：default=按 runtime 默认 | off=关闭思考提效 | high=强制深度思考（按 runtime 写对应键） */
  thinkingLevel?: 'default' | 'off' | 'high';
  /** 飞书内置能力白名单（2026-08-30 内置化）：缺省=全开。可选值 list_chats/chat_history/send_text/lookup_user/send_image */
  feishuCaps?: string[];
}

/** 顶层 config-store.json */
export interface ConfigStore {
  /** 全局开关（2026-08-31）：群聊仅 @ 本 bot 才回复（默认 true） */
  settings?: {
    groupMentionOnly?: boolean;
    /** 派活闸门档位（2026-09-20）：enforce=拦（默认）| observe=只记账 | off=全放 */
    taskGate?: 'enforce' | 'observe' | 'off';
  };
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
  /** 内建 ⚡ 提示词优化（勾选即用）：消息带触发前缀时先精炼再喂 bot，与语音能力同定位 */
  promptOptimize?: PromptOptimizeConfig;
  /** 副驾 /de：读本会话历史 → 判断 → 三条候选卡片（本地引擎，不依赖 dsh） */
  de?: DeConfig;
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

/**
 * [2026-09-25 老大定调] OpenAI 兼容的单模型配置。
 * /p 和 /de 各持一份，互不共用 —— 目的是**彻底不依赖 dsh**（dsh-web 与 dsh-input-tools 插件）：
 * 别人拿到这套 agents-to-feishu 单独部署，填上自己的 base/key/model 就能用。
 */
export interface LlmConfig {
  /**
   * [2026-09-25 老大明说] 模型是**直接选的**，别再让用户填：
   * providerId + modelId 指向「总配置」里已有的服务商与模型，地址与密钥自动解析
   * （密钥走本机凭证层，前端永不明文回显）。下面三个手填字段退化为「高级兜底」。
   */
  providerId?: string;
  modelId?: string;
  /** OpenAI 兼容根地址，例 https://api.deepseek.com/v1（无 /v1 会自动补）；选了服务商就留空 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** DeepSeek 官方独立思考开关：实测同一份输入 default 3.0s → disabled 0.8s。别的后端不认就留 default */
  thinking?: 'default' | 'disabled';
  timeoutMs?: number;
}

/** 内建 ⚡ 提示词优化配置：触发前缀命中 → 先精炼再喂 bot */
export interface PromptOptimizeConfig {
  enabled: boolean;
  /**
   * 引擎选择：local=用本仓自带的本地引擎（默认，不碰 dsh）；endpoint=调外部端点（向后兼容旧配置）。
   * 老配置里 endpoint 指着 dsh-web 的也不炸：engine=endpoint 才走它。
   */
  engine?: 'local' | 'endpoint';
  /** 外部优化端点（仅 engine=endpoint 时生效；空则回落本地引擎） */
  endpoint: string;
  /** 触发前缀（逗号分隔，ASCII 前缀大小写不敏感）；优化成功后剥前缀精炼余文 */
  prefixes: string;
  /** 本地引擎用的模型（/p 专属，可与 /de 不同） */
  llm?: LlmConfig;
  /** 本地引擎：精炼风格档（A=沟通/指令类，B=内容产出类），对齐 dsh 侧的档位语义 */
  tierA?: boolean;
  tierB?: boolean;
  /** 本地引擎：是否顺带注入 openmem 画像（openmem 是独立服务，不是 dsh；关掉也能跑） */
  useOpenmem?: boolean;
}

export const DEFAULT_PROMPT_OPTIMIZE: PromptOptimizeConfig = {
  enabled: false,
  engine: 'local',
  endpoint: '',
  prefixes: '/p,优化：,优化:',
  llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', temperature: 0.5, maxTokens: 1200, thinking: 'disabled', timeoutMs: 60000 },
  tierA: true,
  tierB: true,
  useOpenmem: false,
};

/**
 * [2026-09-25 新增] 副驾 /de：读本会话历史 → 判断局面 → 起草 3 条候选 → 排序 → 交互卡片三选一
 * → 点哪条就用 user 令牌把**原文**发回该会话（不加署名，老大显式豁免）。全程不碰 dsh。
 */
/**
 * [2026-09-25 老大追问「13600 没有 /de 的决策模型」] 决策模型 = 快判断那一族（jev / SystemOne 同族）：
 * 协议是 POST {base}/systemone，body 用 state+questions，**只回概率/选项，不生成文本**，单次几十毫秒。
 * /de 的「判断局面」这一环用它比用聊天模型又快又稳；起草和排序仍需会写人话的模型。
 * 老规矩：只选不填——preset 选定后地址与模型名都写死在代码里，密钥从「总配置」那家的凭证层取。
 */
export interface DecisionConfig {
  /** 'aliyun'(默认) | 'bocha' | 'vercel' | 'opencode' */
  preset: string;
  /** 取 key 用哪家服务商的凭证（默认 'litellm'，即本机 :4000 那套） */
  providerId: string;
  /** 留空=按 preset 拼地址；手填则优先（高级用法） */
  url: string;
  /** 留空=按 preset 的模型名 */
  model: string;
  /** 留空=从 providerId 那家的凭证层取；手填则优先 */
  apiKey: string;
}

export interface DeConfig {
  enabled: boolean;
  /** 触发词，默认 /de */
  command: string;
  /** 拉多少条会话历史进判断（老大 09-25 明说 10~15 够，50 是浪费 token） */
  historyTurns: number;
  /** 判断局面走哪条路：'decision'=决策模型（快，默认）；'chat'=用下面的 judge/draft 聊天模型 */
  judgeEngine?: 'decision' | 'chat';
  /** 决策模型配置（judgeEngine='decision' 时用） */
  decision?: DecisionConfig;
  /** 起草模型（写那三条） */
  draft: LlmConfig;
  /** 判断+排序模型（可指更便宜的；留空 = 复用 draft） */
  judge?: LlmConfig;
  /** 是否注入 openmem 画像/相关记忆（独立服务，非 dsh；拿不到就降级，不拦候选） */
  useOpenmem: boolean;
  /** openmem MCP 地址（默认本机 :3466/mcp） */
  openmemUrl: string;
  /** 高风险（不可逆）时是否禁止直接发送、只允许复制/回显提示 */
  blockRiskySend: boolean;
}

export const DEFAULT_DE: DeConfig = {
  enabled: true,
  command: '/de',
  historyTurns: 15,
  judgeEngine: 'decision',
  decision: { preset: 'aliyun', providerId: 'litellm', url: '', model: '', apiKey: '' },
  draft: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', temperature: 0.95, maxTokens: 900, thinking: 'disabled', timeoutMs: 45000 },
  judge: { baseUrl: '', apiKey: '', model: '', temperature: 0.2, maxTokens: 600, thinking: 'disabled', timeoutMs: 12000 },
  useOpenmem: false,
  openmemUrl: 'http://127.0.0.1:3466/mcp',
  blockRiskySend: true,
};

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
    audio8: { enabled: false, url: 'http://127.0.0.1:18795', cmd: 'node C:\\D\\opt\\audio8-tts\\audio8-tts.mjs', voice: 'xiaotuantuan' },
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
    id: 'openmem', displayName: 'openmem 统一记忆中枢', transport: 'streamable-http',
    serverName: 'openmem', url: 'http://127.0.0.1:3466/mcp', failOnStartupError: false, external: true,
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
    apiKeyEnv: 'GATEWAY_API_KEY',
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
      promptOptimize: DEFAULT_PROMPT_OPTIMIZE,
      de: DEFAULT_DE,
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
      // 深合并：老 store 里的 promptOptimize 没有 llm/engine 字段，直接 ?? 会把默认模型整块丢掉
      promptOptimize: {
        ...DEFAULT_PROMPT_OPTIMIZE,
        ...(parsed.promptOptimize ?? {}),
        llm: { ...DEFAULT_PROMPT_OPTIMIZE.llm!, ...(parsed.promptOptimize?.llm ?? {}) },
      },
      // 老 store 里没有 de：补默认（默认 draft 模型可跑，judge 留空=复用 draft）
      de: {
        ...DEFAULT_DE,
        ...(parsed.de ?? {}),
        draft: { ...DEFAULT_DE.draft, ...(parsed.de?.draft ?? {}) },
        judge: { ...DEFAULT_DE.judge!, ...(parsed.de?.judge ?? {}) },
      },
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
