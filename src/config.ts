/**
 * 配置加载 —— 严格 KEY=VALUE 解析，绝不 eval 为 shell。
 *
 * 安全基线（对齐官方 0.0.6）：config.env 里可以含 `$(rm -rf ~)` 之类的
 * 内容，但本加载器只用纯文本解析，永远不会把它当 shell 执行。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SPEECH, type SpeechConfig } from './config-center/store.js';

export interface BotConfig {
  /** 飞书应用凭证 */
  appId: string;
  appSecret: string;
  /** 运行时标识（如 dsh / claude / codex ...） */
  runtime: string;
  /** 显示名 */
  agentName: string;
  /** 模型组 / Provider 标签（仅展示与注入用） */
  modelGroup: string;
  modelProvider: string;
  /** 原始 provider id（如 volc-ark / gw / deepseek-official），供状态行短名与余额/用量分流 */
  providerId?: string;
  /** provider base URL（如 https://ark.cn-beijing.volces.com/api/plan），供状态行用量/余额类型判断（按 URL 不按 id） */
  providerBaseUrl?: string;
  /** 当前模型真实上下文窗口（tokens，来自模型配置 contextWindow；用于状态行上下文显示） */
  contextWindow?: number;
  /** 是否显示工具调用卡片 / agent 分割线 */
  showToolCallCards: boolean;
  showAgentDivider: boolean;
  /** dashboard 端口 */
  dashboardPort: number;
  /** 允许的用户列表（* = 所有人） */
  allowedUsers: string[];
  /** 默认工作目录（/new 的默认绑定目录） */
  defaultWorkdir: string;
  /** 注入的 systemPrompt 内容：统一注入(全局) + 独立注入(本 agent) 拼接；无注入则为空 */
  systemPrompt: string;
  /** 全局语音配置（ASR 识别 + TTS 合成），来自 config-store.json 的 speech 段 */
  speech: SpeechConfig;
}

/**
 * 解析一份 KEY=VALUE 文本（支持 # 注释、空行）。
 * 值不做任何 shell 解释；`KEY="value"` / `KEY='value'` 的引号会被剥掉。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 剥掉 key / value 的成对引号
    const stripQuotes = (s: string): string =>
      (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
    key = stripQuotes(key);
    value = stripQuotes(value);
    out[key] = value;
  }
  return out;
}

/**
 * 从 env 文件原始文本按 KEY 读取「JSON 字符串编码」的值并还原。
 * render.ts 写注入文本用 JSON.stringify，含多行/引号时 parseEnvFile 的引号剥离会破坏它，
 * 这里直接在原始文本上正则取整行（含首尾引号）再 JSON.parse，保证多行注入还原。
 * 兼容：值不是 JSON（如无引号/非 JSON 字符串）时回退到剥引号后的原值。
 */
export function readJsonEnvValue(envFileText: string, key: string): string {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, 'm');
  const m = envFileText.match(re);
  if (!m) return '';
  const raw = m[1].trim();
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    // 非 JSON 字符串：剥成对引号返回
    return (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  }
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface LoadOptions {
  /** 显式指定 env 文件路径（默认 ~/.agents-to-feishu/config.env） */
  envFile?: string;
  /** 覆盖环境变量（测试用） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 加载全局配置 + 单个 bot 配置。
 * bot 名由 CTI_BOT 环境变量指定（对齐旧体系：一个进程一个 bot）。
 */
export function loadConfig(opts: LoadOptions = {}): { global: Record<string, string>; bot: BotConfig; botName: string } {
  const env = opts.env ?? process.env;
  const home = env.CTI_HOME || path.join(env.USERPROFILE || env.HOME || '.', '.agents-to-feishu');
  const botName = env.CTI_BOT || 'default';
  // 按 bot 独立配置文件优先：config.<botName>.env（配置中心生成），否则回退通用 config.env。
  // 这样多 agent 各读各的文件，互不干扰（配置中心渲染写 config.<id>.env）。
  const botEnvFile = path.join(home, `config.${botName}.env`);
  const candidates = opts.envFile
    ? [opts.envFile]
    : [
        botEnvFile,
        path.join(home, 'config.env'),
        path.join(process.cwd(), 'config.env'),
        path.join(env.USERPROFILE || env.HOME || '.', '.agents-to-feishu', 'config.env'),
      ];
  const envFile = candidates.find((p) => fs.existsSync(p));

  let global: Record<string, string> = {};
  let envText = '';
  if (envFile) {
    envText = fs.readFileSync(envFile, 'utf8');
    global = parseEnvFile(envText);
  }

  const resolvedBotName = env.CTI_BOT || global.CTI_BOT || 'default';
  const prefix = `CTI_BOT_${resolvedBotName.toUpperCase()}_`;

  const get = (key: string, fallback?: string): string | undefined => {
    // 优先级：bot 前缀环境变量 > bot 前缀全局文件 > 裸 key 环境变量 > 裸 key 全局文件
    const v = env[prefix + key] ?? global[prefix + key] ?? env[key] ?? global[key];
    return v !== undefined ? v : fallback;
  };

  const bool = (v: string | undefined, dft = false): boolean =>
    v === undefined ? dft : /^(1|true|yes|on)$/i.test(v);

  const appId = get('APP_ID', '') || get('CTI_BOT_APP_ID', '');
  const appSecret = get('APP_SECRET', '') || get('CTI_BOT_APP_SECRET', '');

  if (!appId || !appSecret) {
    throw new Error(
      `缺少飞书凭证：请在 ${envFile} 配置 ${prefix}APP_ID / ${prefix}APP_SECRET，或设置环境变量 CTI_BOT_APP_ID / CTI_BOT_APP_SECRET`
    );
  }

  const allowedRaw = get('ALLOWED_USERS', '*') || '*';
  const allowedUsers = allowedRaw === '*' ? ['*'] : allowedRaw.split(',').map((s) => s.trim()).filter(Boolean);

  const bot: BotConfig = {
    appId,
    appSecret,
    runtime: get('RUNTIME', 'dsh') || 'dsh',
    agentName: get('AGENT_NAME', botName) || botName,
    modelGroup: get('MODEL_GROUP', '') || '',
    modelProvider: get('MODEL_PROVIDER', '') || '',
    providerId: get('PROVIDER_ID', '') || undefined,
    providerBaseUrl: get('BASE_URL', '') || process.env.ANTHROPIC_BASE_URL || global.ANTHROPIC_BASE_URL || undefined,
    contextWindow: Number(get('CONTEXT_WINDOW', '') || '') || undefined,
    showToolCallCards: bool(get('SHOW_TOOL_CALL_CARDS'), true),
    showAgentDivider: bool(get('SHOW_AGENT_DIVIDER'), true),
    dashboardPort: parseInt(get('DASHBOARD_PORT', '13590') || '13590', 10),
    allowedUsers,
    defaultWorkdir: env.CTI_DEFAULT_WORKDIR ?? global.CTI_DEFAULT_WORKDIR ?? process.env.CTI_USER_HOME ?? os.homedir() ?? '',
    // 注入 systemPrompt = 统一注入(全局, CTI_SYSTEM_PROMPT_GLOBAL) + 独立注入(本 agent, 前缀 SYSTEM_PROMPT)。
    // 统一来源 config-store.json 的 injection 段，render 时写入 env；引擎拼进首条消息。
    systemPrompt: buildInjectedSystemPrompt(envText, env, prefix),
    speech: loadSpeechConfig(env),
  };

  return { global, bot, botName };
}

/**
 * 读取 config-store.json 的全局语音配置（ASR+TTS），桥接进程直接读真相源，不依赖 env 注入。
 * 各引擎子段深合并，缺省用 DEFAULT_SPEECH 兜底（兼容旧 store 缺字段/嵌套脏键）。
 */
export function loadSpeechConfig(env: NodeJS.ProcessEnv = process.env): SpeechConfig {
  try {
    const home = env.CTI_HOME || path.join(env.USERPROFILE || env.HOME || '.', '.agents-to-feishu');
    const storePath = path.join(home, 'config-store.json');
    if (!fs.existsSync(storePath)) return DEFAULT_SPEECH;
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as { speech?: Partial<SpeechConfig> };
    const s = parsed.speech;
    if (!s) return DEFAULT_SPEECH;
    return {
      enabled: s.enabled ?? DEFAULT_SPEECH.enabled,
      tts: {
        defaultEngine: s.tts?.defaultEngine ?? DEFAULT_SPEECH.tts.defaultEngine,
        edge: { ...DEFAULT_SPEECH.tts.edge, ...(s.tts?.edge ?? {}) },
        xiaomi: { ...DEFAULT_SPEECH.tts.xiaomi, ...(s.tts?.xiaomi ?? {}) },
        voicedesign: { ...DEFAULT_SPEECH.tts.voicedesign, ...(s.tts?.voicedesign ?? {}) },
        voiceclone: { ...DEFAULT_SPEECH.tts.voiceclone, ...(s.tts?.voiceclone ?? {}) },
        local: { ...DEFAULT_SPEECH.tts.local, ...(s.tts?.local ?? {}) },
        ali: { ...DEFAULT_SPEECH.tts.ali, ...(s.tts?.ali ?? {}) },
      },
      asr: { ...DEFAULT_SPEECH.asr, ...(s.asr ?? {}) },
    };
  } catch (e) {
    console.warn(`[config] 读取语音配置失败，用默认: ${e instanceof Error ? e.message : String(e)}`);
    return DEFAULT_SPEECH;
  }
}

/** 合成注入 systemPrompt：统一注入(全局键)在前，独立注入(bot 前缀键)在后。 */
function buildInjectedSystemPrompt(envText: string, env: NodeJS.ProcessEnv, prefix: string): string {
  const globalInject = readInject(envText, env, 'CTI_SYSTEM_PROMPT_GLOBAL');
  const customInject = readInject(envText, env, `${prefix}SYSTEM_PROMPT`);
  if (!globalInject && !customInject) return '';
  const parts = [globalInject, customInject].filter((s) => s && s.trim());
  return parts.join('\n\n---\n\n');
}

/** 读单个注入键：文件源按 JSON 编码还原（render 用 JSON.stringify 写）；环境变量源为明文。 */
function readInject(envText: string, env: NodeJS.ProcessEnv, key: string): string {
  if (env[key] !== undefined) return env[key] ?? '';
  return readJsonEnvValue(envText, key);
}
