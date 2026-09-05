/**
 * config-center HTTP 服务 —— 承载配置网页后端。
 *
 * 职责：
 *  - GET  /api/store                读整个 config-store（网页初始化）
 *  - POST /api/agents               新建 agent
 *  - PUT  /api/agents/:id           改 agent 分配置
 *  - DELETE /api/agents/:id         删 agent
 *  - PUT /api/providers/:id         改总配置 provider
 *  - POST /api/providers            新建 provider
 *  - DELETE /api/providers/:id      删 provider
 *  - /mcp/comfy                     ComfyUI 生图 MCP 服务（Streamable HTTP，Tailscale 可访问）
 *  - PUT /api/mcps/:id / POST/DELETE mcps
 *  - POST /api/agents/:id/apply     应用：渲染 config.env + cordis.yml + 重启 ACP
 *  - GET  /api/agents/:id/status    运行时状态（Session/Cache/平均/上下文/余额）
 *  - GET  /                        静态前端页面
 *
 * 重启 agent：通过 nssm 重启 agents-to-feishu 的对应进程（每个 agent 一个进程）。
 * 简化落地：本服务用一个后台任务管理每个 agent 的 DshProvider ACP 进程，apply 时
 * kill 旧进程 → 重启。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import {
  type ConfigStore, type AgentDef, type ProviderDef, type McpDef, type SpeechConfig,
  readStore, writeStore, findProvider, DEFAULT_SPEECH, DEFAULT_INJECTION, defaultStorePath,
} from './store.js';
import { writeAgentArtifacts, readCredentialKey, readOldEnvKey } from './render.js';
import { startAgent as pmStart, stopAgent as pmStop, restartAgent as pmRestart, statusAll as pmStatus } from './process-manager.js';
import { syncDeepTutorModel } from './sync-deeptutor.js';
import { buildAgentRuntimeState, type AgentRuntimeState } from './runtime.js';
import { lookImage } from '../vision/look.js';
import {
  synthesize, synthesizeVoiceClone, AUDIO8_DIR, AUDIO8_VOICES_DIR, AUDIO8_PY, type TtsConfig,
} from '../voice/tts.js';
import { transcribe, resolveFfmpeg, type AsrConfig } from '../voice/asr.js';
import { createComfyMcpHttpHandler } from '../comfy/mcp-server.js';
import { createVisionMcpHttpHandler } from '../vision/mcp.js';

/** 项目根（server.ts 位于 src/config-center/，上溯两级） */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
/** 内置测试样例图（可分发，随项目走） */
const SAMPLE_VISION_IMAGE = path.join(PROJECT_ROOT, 'assets', 'sample-vision.jpg');

export interface ConfigServerOptions {
  /** 监听地址；可传多个同时绑定（如 ['127.0.0.1', TailscaleIP]）。显式传 '0.0.0.0' = 全接口（调用方自己负责） */
  host?: string | string[];
  port: number;
  /** config-store.json 路径 */
  storeFile?: string;
  /** 前端静态目录 */
  staticDir?: string;
  /** 凭证写入：globalExtra 注入到 config.env 的键（如 ARK_API_KEY 值） */
  globalExtra?: Record<string, string>;
  /** apply 时是否真的重启进程（false = 只写文件不重启，测试用） */
  restartOnApply?: boolean;
  logger?: (msg: string) => void;
}

export function createConfigServer(opts: ConfigServerOptions) {
  // 监听地址由入口 resolveHosts() 决定：默认双绑 127.0.0.1 + Tailscale IP。
  // 默认绝不是 0.0.0.0（那会把全部 bot 凭证对局域网裸奔）；但 CTI_CONFIG_HOST=0.0.0.0
  // 显式传入时照绑——老大拍板：客户要怎么访问就怎么访问，工具不替客户做安全决定。
  const {
    host: hostOpt = '127.0.0.1', port, storeFile, staticDir,
    globalExtra = {}, restartOnApply = true, logger = console.log,
  } = opts;
  const hosts = Array.isArray(hostOpt) ? hostOpt : [hostOpt];

  const log = (m: string) => logger(`[config-center] ${m}`);

  // ComfyUI 生图 MCP 服务（挂 /mcp/comfy，Tailscale 可访问）
  const comfyMcpHandler = createComfyMcpHttpHandler();
  // 内建看图 MCP 服务（挂 /mcp/vision，暴露 look_image 三任务给所有 agent）
  const visionMcpHandler = createVisionMcpHttpHandler();

  // 读/写 store（每次实时，避免并发脏读）
  const load = (): ConfigStore => readStore(storeFile);
  const save = (s: ConfigStore) => writeStore(s, storeFile);

  // ── 工具 ──

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  function json(res: http.ServerResponse, code: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function routeMatch(pathname: string, pattern: string): boolean {
    const pp = pattern.split('/').filter(Boolean);
    const pa = pathname.split('/').filter(Boolean);
    if (pp.length !== pa.length) return false;
    return pp.every((p, i) => p === pa[i] || p.startsWith(':'));
  }
  function param(pathname: string, pattern: string, key: string): string {
    const pp = pattern.split('/').filter(Boolean);
    const pa = pathname.split('/').filter(Boolean);
    const idx = pp.indexOf(`:${key}`);
    return idx >= 0 ? decodeURIComponent(pa[idx] ?? '') : '';
  }

  /** 应用一个 agent：渲染写盘 + 重启进程 */
  async function applyAgent(agentId: string): Promise<{ ok: boolean; configEnvPath?: string; cordisYmlPath?: string; error?: string }> {
    const store = load();
    const agent = store.agents.find((a) => a.id === agentId);
    if (!agent) return { ok: false, error: `agent ${agentId} 不存在` };
    try {
      // 把该 agent runtime 在 config-open.json 里配置的自定义 CLI 路径注入 globalExtra，
      // 渲染进 config.env（provider 读 CTI_<RUNTIME>_CLI_PATH/EXEC 生效）
      const cliOverrides = readRuntimeCliOverrides();
      const cliPath = cliOverrides[agent.runtime || 'dsh'];
      const extra = Object.assign({}, globalExtra);
      if (cliPath && runtimeEntry(agent.runtime || 'dsh').envKey) {
        extra[runtimeEntry(agent.runtime || 'dsh').envKey] = cliPath;
      }
      // 把 config-open.json 里用户配置的"运行时启动环境覆盖"合成进 globalExtra —— 真正穿透给 agent：
      // 用户覆盖的 env 优先级最高（覆盖 render.ts 的默认注入）；空字符串 = 剔除该 env。
      const envOverrides = readRuntimeEnvOverrides()[agent.runtime || 'dsh'];
      if (envOverrides) {
        for (const [k, v] of Object.entries(envOverrides)) {
          if (v === '') { delete extra[k]; continue; }
          extra[k] = v;
        }
      }
      const out = writeAgentArtifacts(store, agent, extra);
      // DeepTutor 模型推送（路线 A）：模型/profile 由配置中心下发到 DeepTutor 自身 settings。
      // 失败不阻塞 apply（bot 用 DeepTutor 上次保存的配置），原因记录在返回值与日志。
      if ((agent.runtime || '') === 'deeptutor') {
        try {
          const r = await syncDeepTutorModel(store, agent, extra);
          if (r.pushed) log(`apply ${agentId}: DeepTutor 模型已推送并生效`);
          else if (r.error) log(`apply ${agentId}: DeepTutor 推送失败（不阻塞）: ${r.error}`);
          else if (r.skipped && r.skipped !== 'unchanged') log(`apply ${agentId}: DeepTutor 推送跳过: ${r.skipped}`);
        } catch (e) {
          log(`apply ${agentId}: DeepTutor 推送异常（不阻塞）: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (restartOnApply) {
        await restartAgentProcess(agent.id);
        log(`apply ${agentId}: artifacts written + process restarted`);
      } else {
        log(`apply ${agentId}: artifacts written (restart skipped)`);
      }
      return { ok: true, configEnvPath: out.configEnvPath, cordisYmlPath: out.cordisYmlPath };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 测试一个 provider 的连通性：拿真实 key（凭证层/老 config.env 兜底），
   * 按协议（OpenAI 聊天 / Responses / Anthropic）打对应端点 1-token 请求，
   * 返回耗时与错误明细。
   */
  async function testProviderConnection(providerId: string, overrideModel?: string): Promise<{
    ok: boolean; latencyMs?: number; model?: string; error?: string;
  }> {
    const store = load();
    const prov = store.providers.find((x) => x.id === providerId);
    if (!prov) return { ok: false, error: `provider ${providerId} 不存在` };
    const baseURL = (prov.baseURL || '').trim();
    if (!baseURL) return { ok: false, error: '该 provider 未配置 BaseURL，先保存再测试' };
    const key = readCredentialKey(prov.apiKeyEnv) || readOldEnvKey(prov.apiKeyEnv) || process.env[prov.apiKeyEnv] || '';
    if (!key) return { ok: false, error: `找不到 key（环境变量 ${prov.apiKeyEnv} 未设置）` };
    const model = (overrideModel && overrideModel.trim()) || prov.models[0]?.id || '';
    if (!model) return { ok: false, error: '该 provider 没有模型，先添加模型再测试' };
    const api = prov.api || 'openai-completions';
    const root = baseURL.replace(/\/+$/, '');
    // 按协议定端点与载荷：anthropic-messages → /v1/messages；openai-responses → /responses；其余 → /chat/completions
    const url = api === 'anthropic-messages'
      ? `${root}/v1/messages`
      : api === 'openai-responses'
        ? `${root}/responses`
        : `${root}/chat/completions`;
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const body = api === 'anthropic-messages'
        ? JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
        : api === 'openai-responses'
          ? JSON.stringify({ model, input: 'ping', max_output_tokens: 1 })
          : JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
      if (api === 'anthropic-messages') {
        // Anthropic 兼容网关：官方协议用 x-api-key + anthropic-version
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['authorization'] = `Bearer ${key}`;
      }
      const r = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { ok: false, latencyMs, model, error: `HTTP ${r.status} ${txt.slice(0, 200) || r.statusText}` };
      }
      return { ok: true, latencyMs, model };
    } catch (e) {
      const latencyMs = Date.now() - started;
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, latencyMs, model, error: /abor/i.test(msg) ? '请求超时（12s）' : msg };
    }
  }

  // ── 运行时（runtime）注册表：每个 agent 的 provider 实际去调用的 CLI 程序 ──
  // 关键：判定"该 agent 是否真实存在" = 它的 CLI 在不在系统里，而不是 nssm/sc 服务状态
  // （服务能 RUNNING 不代表 CLI 装好了——空壳服务也能 RUNNING）。
  // 每个 runtime 的探测严格对齐 provider 源码（resolveXxxCommand / executable / cliPath）：
  //   files   = provider 内部按顺序探测的真实候选可执行文件（命中第一个）
  //   where   = provider 用命令名 spawn 的，走 PATH 探测（从 where 输出挑真实 .cmd/.exe）
  //   command = 展示用命令名
  //   envKey  = provider 读取的覆盖环境变量（配置中心保存自定义路径后渲染成它）
  // install = 未检测到时给用户的安装提示（'' = 作者自研未公开，参照 src/providers 对接同类 CLI）
  // service = 服务型运行时（非 CLI）：值 = 承载服务地址的 env 名（探测=HTTP 健康检查，路径栏=服务地址）
  const REL_RUNTIMES: Array<{ runtime: string; display: string; where?: string; files?: string[]; envKey: string; command: string; install?: string; service?: string }> = [
    // claude: provider 首选 CTI_CLAUDE_CLI_PATH，缺失时探测 C:\WINDOWS\system32\claude.bat，都不在回落 'claude'
    { runtime: 'claude',    display: 'Claude',    files: ['C:\\WINDOWS\\system32\\claude.bat', 'C:\\Windows\\System32\\claude.bat'], envKey: 'CTI_CLAUDE_CLI_PATH', command: 'claude', install: 'npm i -g @anthropic-ai/claude-code', },
    // codex: provider executable='codex'，spawn 'codex app-server' → PATH 命令
    { runtime: 'codex',     display: 'Codex',     where: 'codex',     envKey: 'CTI_CODEX_CLI_PATH', command: 'codex', install: 'npm i -g @openai/codex', },
    // gemini: provider CTI_GEMINI_CLI_PATH || 'gemini' → PATH 命令
    { runtime: 'gemini',    display: 'Gemini',    where: 'gemini',    envKey: 'CTI_GEMINI_CLI_PATH', command: 'gemini', install: 'npm i -g @google/gemini-cli', },
    // hermes: provider CTI_HERMES_CLI_PATH || 'hermes' → PATH 命令（真实装在本机 Local\hermes 的 venv exe）
    { runtime: 'hermes',    display: 'Hermes',    where: 'hermes',    envKey: 'CTI_HERMES_CLI_PATH', command: 'hermes', install: '开源项目 Hermes Agent：安装后 PATH 自动探测/到本页填路径', },
    // opencode: provider 候选 exe（opencode-windows-x64\bin\opencode.exe，baseline 兜底）
    { runtime: 'opencode',  display: 'OpenCode',  files: ['C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe', 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe'], envKey: 'CTI_OPENCODE_EXEC', command: 'opencode', install: 'npm i -g opencode-ai', },
    // openclaw: provider 候选 %USERPROFILE%\AppData\Roaming\npm\openclaw.exe
    { runtime: 'openclaw',  display: 'OpenClaw',  files: ['C:\\Users\\oadan\\AppData\\Roaming\\npm\\openclaw.exe'], envKey: 'CTI_OPENCLAW_EXEC', command: 'openclaw', install: 'npm i -g openclaw', },
    // mimo: provider 候选 mimocode-windows-x64\bin\mimo.exe（baseline 兜底）
    { runtime: 'mimo',      display: 'MiMo',      files: ['C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@mimo-ai\\cli\\node_modules\\@mimo-ai\\mimocode-windows-x64\\bin\\mimo.exe', 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@mimo-ai\\cli\\node_modules\\@mimo-ai\\mimocode-windows-x64-baseline\\bin\\mimo.exe'], envKey: 'CTI_MIMO_EXEC', command: 'mimo', install: 'npm i -g @mimo-ai/cli', },
    // reasonix: provider 候选 reasonix-cli.exe（Local\Programs）> npm 包内 reasonix.exe
    { runtime: 'reasonix',  display: 'Reasonix',  files: ['C:\\Users\\oadan\\AppData\\Local\\Programs\\Reasonix\\reasonix-cli.exe', 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\reasonix\\node_modules\\@reasonix\\cli-win32-x64\\bin\\reasonix.exe'], envKey: 'CTI_REASONIX_EXEC', command: 'reasonix', install: '开源项目 Reasonix：安装后自动探测/到本页填路径', },
    // openakita: provider 用 venv python 当执行器，ARG 的 ACP server 脚本才是真程序（相对 agents-to-feishu 根）
    // 探测/显示以 ACP server 脚本为准（python 仅执行器，显示 python 会误导）
    { runtime: 'openakita', display: 'OpenAkita', files: ['C:\\D\\opt\\agents-to-feishu\\scripts\\openakita-acp-server.py'], envKey: 'CTI_OPENAKITA_SERVER', command: 'scripts/openakita-acp-server.py', install: '开源项目 OpenAkita：安装后自动探测/到本页填路径', },
    // dsh: provider 用 node 当执行器，真程序 = DSH harness 的 ACP demo 入口 bin.ts
    { runtime: 'dsh', display: 'DSH', files: ['C:\\D\\opt\\deepseek-harness\\deepseek-harness\\packages\\examples\\acp-demo\\src\\bin.ts'], envKey: 'CTI_DSH_HARNESS_PATH', command: 'packages/examples/acp-demo/src/bin.ts', install: '开源项目 DeepSeek Harness：clone 安装后，到本页把 harness 路径填好', },
    // zcode: provider 用 node 当执行器，真程序 = ZCode 桌面版内置 CLI（app-server --stdio）
    // deeptutor: 自包含 HTTP 服务（非 CLI），provider 直连其服务端口；无 CLI 可探测 → 恒可用
    { runtime: 'deeptutor', display: 'DeepTutor', envKey: 'CTI_DEEPTUTOR_BASE', command: 'deeptutor', install: '开源项目 DeepTutor：按其文档部署服务后使用', service: 'CTI_DEEPTUTOR_BASE', },
    { runtime: 'zcode', display: 'ZCode', files: ['C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs', 'C:\\Users\\oadan\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'], envKey: 'CTI_ZCODE_CLI', command: 'zcode.cjs', install: '下载安装 ZCode 桌面版（z.ai 官方产品）', },
  ];

  // ── 每个 runtime 的"启动环境模板"（配置页可看/可改，保存后穿透给 agent）──
  // key = env 变量名，value = 默认建议值（用户可在配置页覆盖；空字符串 = 删除该 env）
  // 2026-09-05 老大要求：每个 runtime 的正确启动参数都预设好，别人装上 agent 就能不报错启动。
  const ENV_TPL: Record<string, Record<string, string>> = {
    claude: {
      'ANTHROPIC_BASE_URL': '',            // 直连网关（默认留空 → provider 回落 LiteLLM；用户填网关 URL 即直连）
      'ANTHROPIC_AUTH_TOKEN': '',          // 直连网关 key（默认留空 → provider 从凭证读；用户可显式覆盖）
      'ANTHROPIC_MODEL': '',               // 模型（默认留空 → 用所选 provider/model）
      'ANTHROPIC_PERMISSION_MODE': 'bypassPermissions',   // 全能力、最全权限、自动审批（不弹确认）
      'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT': '1', // 消第三方模型不识别告警
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS': '1000000', // 第三方 1M 上下文
    },
    zcode: {
      'CTI_ZCODE_CLI': '',                 // zcode.cjs 路径（默认留空 → 探测 Program Files 标准安装位）
      'CTI_ZCODE_STALL_MS': '300000',      // 流空闲看门狗：5min 零事件判卡死（长任务可调大）
      'CTI_ZCODE_THINK_HEAD': '400',       // 流式思考转发上限：防💭滑动窗口高频全换（闪烁根因）
    },
    opencode: {
      'CTI_OPENCODE_EXEC': '',             // opencode.exe 路径（默认留空 → 探测 npm 全局位置）
      'CTI_OPENCODE_TIMEOUT_MS': '300000', // 单 prompt 卡死看门狗
      'CTI_OPENCODE_IDLE_TIMEOUT_MS': '1800000', // 会话空闲回收（30min）
    },
    gemini: {
      'CTI_GEMINI_CLI_PATH': '',           // gemini CLI 路径（默认留空 → PATH 查找）
      'CTI_GEMINI_BASE_URL': '',           // 默认留空 → 用所选 provider 网关
      'CTI_GEMINI_API_KEY': '',            // 默认留空 → 凭证层读取
      'CTI_GEMINI_PROMPT_TIMEOUT_MS': '',  // 留空 → provider 内部默认
    },
    openakita: {
      'CTI_OPENAKITA_SERVER': '',          // ACP server 脚本（默认留空 → 项目 scripts/ 相对路径）
      'CTI_OPENAKITA_WORKSPACE': '',       // 留空 → provider 内部默认
    },
    openclaw: {
      'CTI_OPENCLAW_EXEC': '',             // openclaw.exe 路径（默认留空 → 探测 npm 全局位置）
      'CTI_OPENCLAW_STATE_DIR': '',        // 留空 → openclaw 自管
    },
    mimo: {
      'CTI_MIMO_EXEC': '',                 // mimo.exe 路径（默认留空 → 探测 npm 全局位置）
    },
    reasonix: {
      'CTI_REASONIX_EXEC': '',             // reasonix-cli.exe 路径（默认留空 → 探测安装位置/PATH）
      'CTI_REASONIX_TIMEOUT_MS': '',       // 留空 → provider 内部默认
    },
    hermes: {
      'CTI_HERMES_CLI_PATH': '',           // hermes CLI 路径（默认留空 → PATH 查找）
    },
    dsh: {
      'CTI_DSH_HARNESS_PATH': '',          // DeepSeek Harness 根目录（默认留空 → 探测/运行时页手填）
    },
    deeptutor: {
      'CTI_DEEPTUTOR_TOKEN': '',           // 多用户鉴权部署的 Bearer Token（本机免鉴权留空）
    },
  };
  /** 开关型 env（网页渲染成打勾开关；值非空 = 勾选）。其余 envTpl 键渲染成文本输入。 */
  const ENV_FLAG_KEYS: Record<string, string[]> = {
    claude: ['ANTHROPIC_PERMISSION_MODE', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT'],
  };
  /** env 键的中文说明（网页展示） */
  const ENV_LABELS: Record<string, string> = {
    'ANTHROPIC_BASE_URL': '直连网关 URL（留空=走 LiteLLM 回落）',
    'ANTHROPIC_AUTH_TOKEN': '直连网关 key（留空=凭证层读取）',
    'ANTHROPIC_MODEL': '模型名（留空=用所选模型）',
    'ANTHROPIC_PERMISSION_MODE': '自动跳过审批 / 最大权限运行',
    'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT': '消除未知模型告警',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS': '最大上下文 tokens',
    'CTI_ZCODE_CLI': 'zcode.cjs 路径（留空=自动探测）',
    'CTI_ZCODE_STALL_MS': '流空闲看门狗（毫秒）',
    'CTI_ZCODE_THINK_HEAD': '流式思考转发上限（字符）',
    'CTI_OPENCODE_EXEC': 'opencode.exe 路径（留空=自动探测）',
    'CTI_OPENCODE_TIMEOUT_MS': '单轮卡死看门狗（毫秒）',
    'CTI_OPENCODE_IDLE_TIMEOUT_MS': '会话空闲回收（毫秒）',
    'CTI_GEMINI_CLI_PATH': 'gemini CLI 路径（留空=PATH 查找）',
    'CTI_GEMINI_BASE_URL': '网关 URL（留空=用所选 provider）',
    'CTI_GEMINI_API_KEY': 'API key（留空=凭证层读取）',
    'CTI_GEMINI_PROMPT_TIMEOUT_MS': 'prompt 超时（毫秒，留空=默认）',
    'CTI_OPENAKITA_SERVER': 'ACP server 脚本路径',
    'CTI_OPENAKITA_WORKSPACE': '工作空间目录（留空=默认）',
    'CTI_OPENCLAW_EXEC': 'openclaw.exe 路径（留空=自动探测）',
    'CTI_OPENCLAW_STATE_DIR': '状态目录（留空=自管）',
    'CTI_MIMO_EXEC': 'mimo.exe 路径（留空=自动探测）',
    'CTI_REASONIX_EXEC': 'reasonix-cli.exe 路径（留空=自动探测）',
    'CTI_REASONIX_TIMEOUT_MS': 'prompt 超时（毫秒，留空=默认）',
    'CTI_HERMES_CLI_PATH': 'hermes CLI 路径（留空=PATH 查找）',
    'CTI_DSH_HARNESS_PATH': 'DeepSeek Harness 根目录',
    'CTI_DEEPTUTOR_TOKEN': 'Bearer Token（多用户鉴权部署才填）',
  };

  /** 读取 config-open.json 里用户配置的 runtime 启动环境覆盖 { runtime: { ENV: value } } */
  function readRuntimeEnvOverrides(): Record<string, Record<string, string>> {
    const openFile = path.join(path.dirname(storeFile || defaultStorePath()), 'config-open.json');
    try {
      if (fs.existsSync(openFile)) {
        const parsed = JSON.parse(fs.readFileSync(openFile, 'utf-8')) as { runtimeEnv?: unknown };
        if (parsed.runtimeEnv && typeof parsed.runtimeEnv === 'object') {
          const out: Record<string, Record<string, string>> = {};
          for (const [k, v] of Object.entries(parsed.runtimeEnv as Record<string, unknown>)) {
            if (v && typeof v === 'object') out[k] = v as Record<string, string>;
          }
          return out;
        }
      }
    } catch {}
    return {};
  }

  /** 按 runtime 名取注册表项（未知返回一个 miss 的占位，避免崩溃） */
  function runtimeEntry(runtime: string) {
    return REL_RUNTIMES.find((rt) => rt.runtime === runtime)
      || { runtime, display: runtime, envKey: '', command: '' };
  }

  /** 读取 config-open.json 里用户配置的自定义 CLI 路径映射 { runtime: cliPath } */
  function readRuntimeCliOverrides(): Record<string, string> {
    const openFile = path.join(path.dirname(storeFile || defaultStorePath()), 'config-open.json');
    try {
      if (fs.existsSync(openFile)) {
        const parsed = JSON.parse(fs.readFileSync(openFile, 'utf-8')) as { cliPath?: unknown };
        if (parsed.cliPath && typeof parsed.cliPath === 'object') {
          return parsed.cliPath as Record<string, string>;
        }
      }
    } catch {}
    return {};
  }

  /** 服务型运行时探测：HTTP 健康检查 /api/settings + 当前生效模型（llm.active_model_id） */
  async function probeService(rt: (typeof REL_RUNTIMES)[number], overrideBase: string): Promise<{ detected: boolean; resolvedPath: string; activeModel?: string }> {
    const base = (overrideBase || process.env[rt.service!] || 'http://127.0.0.1:8001').replace(/\/+$/, '');
    try {
      const r = await fetch(base + '/api/settings', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return { detected: false, resolvedPath: base };
      let activeModel = '';
      try {
        const j = await r.json() as any;
        activeModel = String(j?.catalog?.services?.llm?.active_model_id || '').replace(/^llm-model-/, '');
      } catch { /* 在线但无模型信息 */ }
      return { detected: true, resolvedPath: base, activeModel };
    } catch {
      return { detected: false, resolvedPath: base };
    }
  }

  /** 探测某 runtime 的 CLI 是否在系统里（file 型同步；where 型异步回调） */
  function probeRuntimeCli(rt: (typeof REL_RUNTIMES)[number], configured: string | undefined): Promise<{ detected: boolean; resolvedPath: string; activeModel?: string }> {
    return new Promise((resolve) => {
      const finishWhere = (): void => {
        if (!rt.where) { resolve({ detected: true, resolvedPath: rt.command }); return; }
        execFile('C:\\Windows\\System32\\where.exe', [rt.where], { timeout: 8000 }, (err, stdout) => {
          if (err) { resolve({ detected: false, resolvedPath: rt.command }); return; }
          const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          // 优先挑真实可执行文件（.cmd/.bat/.exe），避免显示无扩展名的 npm shim（如裸 codex/gemini）
          const real = lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) || lines[0] || rt.command;
          resolve({ detected: true, resolvedPath: real });
        });
      };
      // 用户显式配置了 CLI 路径/服务地址 → 优先用它（CLI 查存在性；服务型按 URL 探测）
      if (configured) {
        if (rt.service && /^https?:\/\//.test(configured)) {
          probeService(rt, configured).then(resolve);
          return;
        }
        resolve({ detected: (() => { try { return fs.existsSync(configured); } catch { return false; } })(), resolvedPath: configured });
        return;
      }
      // 服务型运行时（deeptutor 等）：探测 = HTTP 健康检查（/api/settings），顺带取当前生效模型
      if (rt.service) {
        probeService(rt, process.env[rt.service] || '').then(resolve);
        return;
      }
      // provider 源码里的真实候选可执行文件 → 命中第一个存在的；全脱靶则回退 PATH 查找
      // （2026-09-05：候选列表写的是本机安装位置，别人机器 npm 全局路径不同——按 command 名查 PATH 兜底）
      if (rt.files && rt.files.length > 0) {
        const hit = rt.files.find((p0) => { try { return fs.existsSync(p0); } catch { return false; } });
        if (hit) { resolve({ detected: true, resolvedPath: hit }); return; }
        finishWhere();
        return;
      }
      finishWhere();
    });
  }

  // ── HTTP server ──

  const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      // ── ComfyUI 生图 MCP 服务（Streamable HTTP，Tailscale 访问 /mcp/comfy）──
      if (p === '/mcp/comfy' || p === '/mcp/comfy/') {
        await comfyMcpHandler(req, res);
        return;
      }
      // ── 内建看图 MCP 服务（Streamable HTTP，暴露 look_image 三任务给所有 agent）──
      if (p === '/mcp/vision' || p === '/mcp/vision/') {
        await visionMcpHandler(req, res);
        return;
      }

      // ── 静态前端 ──
      if (staticDir && (p === '/' || p === '/index.html') && method === 'GET') {
        const file = path.join(staticDir, 'index.html');
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      if (staticDir && p.startsWith('/assets/') && method === 'GET') {
        const rel = p.replace(/^\/+/, '');
        const file = path.resolve(staticDir, rel);
        if (file.startsWith(path.resolve(staticDir)) && fs.existsSync(file)) {
          const ext = path.extname(file);
          const ct = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
          res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      // settings 子页（防缓存：JS 改动立即可见）
      if (staticDir && (p === '/agents-settings' || p === '/agents-settings.html') && method === 'GET') {
        const file = path.join(staticDir, 'agents-settings.html');
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      if (staticDir && p === '/agents-settings.js' && method === 'GET') {
        const file = path.join(staticDir, 'agents-settings.js');
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      // 独立语音设置页（React/pReact 版，照 dsh-input-tools 布局交互）
      if (staticDir && (p === '/voice-settings' || p === '/voice-settings.html') && method === 'GET') {
        const file = path.join(staticDir, 'voice-settings.html');
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      if (staticDir && p === '/voice-settings.js' && method === 'GET') {
        const file = path.join(staticDir, 'voice-settings.js');
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      // 独立技能库设置页（React/pReact 版，与语音页同款交互）
      if (staticDir && (p === '/skill-settings' || p === '/skill-settings.html') && method === 'GET') {
        const file = path.join(staticDir, 'skill-settings.html');
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      if (staticDir && p === '/skill-settings.js' && method === 'GET') {
        const file = path.join(staticDir, 'skill-settings.js');
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      // 通用独立配置页路由：/<name>-settings 与 /<name>-settings.js → staticDir 同名文件
      // 覆盖各 tab 迁移后的独立 preact 页（如 vision/comfy/inject/agents/providers/mcps/overview）
      {
        const mPg = p.match(/^\/([A-Za-z0-9_-]+)-settings$/);
        if (staticDir && mPg && method === 'GET') {
          const file = path.join(staticDir, `${mPg[1]}-settings.html`);
          if (fs.existsSync(file)) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(file));
            return;
          }
        }
        const mJs = p.match(/^\/([A-Za-z0-9_-]+)-settings\.js$/);
        if (staticDir && mJs && method === 'GET') {
          const file = path.join(staticDir, `${mJs[1]}-settings.js`);
          if (fs.existsSync(file)) {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            res.end(fs.readFileSync(file));
            return;
          }
        }
      }

      // ── API ──

      // GET /api/store
      if (p === '/api/store' && method === 'GET') {
        return json(res, 200, load());
      }

      // GET /api/settings —— 全局开关
      if (p === '/api/settings' && method === 'GET') {
        const store = load();
        return json(res, 200, { ok: true, data: store.settings ?? { groupMentionOnly: true } });
      }
      // PUT /api/settings —— 保存全局开关
      if (p === '/api/settings' && method === 'PUT') {
        const body = JSON.parse(await readBody(req) || '{}') as { groupMentionOnly?: boolean };
        const store = load();
        store.settings = { ...(store.settings ?? {}), groupMentionOnly: body.groupMentionOnly !== false };
        save(store);
        return json(res, 200, { ok: true, data: store.settings });
      }
      // POST /api/tools/user-self-test —— 用户身份（lark-cli）自测：以发送 bot 身份给自己私聊发一条
      if (p === '/api/tools/user-self-test' && method === 'POST') {
        try {
          const store = load();
          const raw = await readBody(req).catch(() => '{}');
          const body = JSON.parse(raw || '{}') as { botId?: string };
          const botId = body.botId || 'hermes';
          const a = store.agents.find((x) => x.id === botId);
          if (!a) return json(res, 200, { ok: false, error: '找不到 bot: ' + botId });
          const myInfo = (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: a.appId, app_secret: a.appSecret }),
          }).then((r) => r.json())) as { tenant_access_token?: string };
          const r2 = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
            headers: { Authorization: `Bearer ${myInfo.tenant_access_token}` },
          });
          const myData = (await r2.json()) as { bot?: { open_id?: string } };
          const myOpenId = myData?.bot?.open_id;
          if (!myOpenId) return json(res, 200, { ok: false, error: '未取到 bot open_id' });
          // 只读验证：跑 lark-cli +chat-list（不发消息，验证 user token 有效）
          const { execFileSync } = await import('node:child_process');
          const out = execFileSync(
            'C:\\Program Files\\nodejs\\node.exe',
            ['C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js',
             'im', '+chat-list', '--types=p2p', '--as', 'user'],
            { timeout: 60_000, encoding: 'utf-8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
          );
          const ok = /"ok"[: ]+true/.test(out);
          let chats = 0;
          try { chats = (JSON.parse(out)?.data?.chats ?? []).length; } catch { /* 忽略 */ }
          return json(res, 200, { ok, error: ok ? '' : out.slice(0, 200), chats });
        } catch (e) {
          return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // POST /api/tools/user-auth-list —— 查看 lark-cli 已登录用户
      if (p === '/api/tools/user-auth-list' && method === 'POST') {
        try {
          const { execFileSync } = await import('node:child_process');
          const out = execFileSync(
            'C:\\Program Files\\nodejs\\node.exe',
            ['C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js', 'auth', 'list'],
            { timeout: 30_000, encoding: 'utf-8', windowsHide: true },
          );
          return json(res, 200, { ok: true, data: out });
        } catch (e) {
          return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // POST /api/tools/user-auth-login —— 重新登录（设备流：返回授权链接，150 秒内完成授权即可）
      if (p === '/api/tools/user-auth-login' && method === 'POST') {
        try {
          const { execFileSync } = await import('node:child_process');
          const out = execFileSync(
            'C:\\Program Files\\nodejs\\node.exe',
            ['C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js', 'auth', 'login'],
            { timeout: 150_000, encoding: 'utf-8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          );
          return json(res, 200, { ok: true, data: out });
        } catch (e: unknown) {
          const anyErr = e as { stdout?: string; message?: string };
          return json(res, 200, { ok: false, error: (anyErr.stdout ? anyErr.stdout.slice(0, 800) : '') || (anyErr.message ?? String(e)) });
        }
      }
      // GET /api/agents (简)
      if (p === '/api/agents' && method === 'GET') {
        return json(res, 200, load().agents);
      }

      // GET /api/agents/installed —— 探测每个 agent 的真实运行时（CLI 程序）是否安装。
      // 判定依据 = 该 agent 的 provider 实际去调用的 CLI 在不在系统里（与 provider spawn 的命令一致），
      // 不是 nssm/sc 服务状态。CLI 在 = 该 agent 真实存在 → 前端才显示其卡片。
      // 返回 { installed:[id...], status:{ [id]:"installed"|"missing" } }
      if (p === '/api/agents/installed' && method === 'GET') {
        const store = load();
        const cliMap = readRuntimeCliOverrides();
        const out: string[] = [];
        const status: Record<string, string> = {};
        await Promise.all(store.agents.map((a) => probeRuntimeCli(runtimeEntry(a.runtime || 'dsh'), cliMap[a.runtime || 'dsh']).then((r) => {
          if (r.detected) { out.push(a.id); status[a.id] = 'installed'; }
          else { status[a.id] = 'missing'; }
        })));
        return json(res, 200, { installed: out, status });
      }

      // GET /api/runtimes —— 运行时管理：返回每个 runtime 的真实 CLI 命令 / resolve 路径 / 检测状态 / 自定义覆盖 / 启动 env 模板
      if (p === '/api/runtimes' && method === 'GET') {
        const cliMap = readRuntimeCliOverrides();
        const envMap = readRuntimeEnvOverrides();
        const list = await Promise.all(REL_RUNTIMES.map(async (rt) => {
          const configured = cliMap[rt.runtime] || '';
          const probe = await probeRuntimeCli(rt, configured || undefined);
          const detected = probe.detected, resolvedPath = probe.resolvedPath;
          // 启动 env：默认模板 + 用户覆盖合并（用户优先；空字符串 = 剔除该键 → 不返回它）
          const tpl = ENV_TPL[rt.runtime] || {};
          const over = envMap[rt.runtime] || {};
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(tpl)) { if (v !== '') env[k] = v; }
          for (const [k, v] of Object.entries(over)) {
            if (v === '') { delete env[k]; continue; }
            env[k] = v;
          }
          // envMeta：每个键的【真实生效值】（覆盖 > 实际解析值 > provider 内部默认）。
          // 2026-09-05 老大要求：框里直接写好真实值供学习参观，不留空白。
          // secret=掩码显示（未改动不落覆盖）；readonly=随 Agent 上下文自动注入（不渲染输入框）。
          const envMeta: Record<string, { value: string; secret?: boolean; readonly?: boolean; note?: string }> = {};
          const firstAgent = load().agents.find((a: AgentDef) => (a.runtime || 'dsh') === rt.runtime && a.enabled !== false);
          const rtProv = firstAgent ? findProvider(load(), firstAgent.providerId) : undefined;
          const maskKey = (s: string): string => (!s ? '' : s.length <= 8 ? s.slice(0, 2) + '***' : s.slice(0, 6) + '***' + s.slice(-3));
          const pushMeta = (k: string, value: string, opts?: { secret?: boolean; readonly?: boolean; note?: string }): void => {
            envMeta[k] = { value: over[k] !== undefined && over[k] !== '' ? over[k] : value, secret: opts?.secret, readonly: opts?.readonly, note: opts?.note };
          };
          switch (rt.runtime) {
            case 'claude':
              pushMeta('ANTHROPIC_BASE_URL', rtProv?.baseURL || 'http://127.0.0.1:4000', { note: '留空=回落 LiteLLM 网关' });
              pushMeta('ANTHROPIC_AUTH_TOKEN', maskKey(readCredentialKey(rtProv?.apiKeyEnv || '') || readOldEnvKey(rtProv?.apiKeyEnv || '')), { secret: true, note: '留空=凭证层自动读取' });
              pushMeta('ANTHROPIC_MODEL', `跟随 Agent 所选（当前 ${firstAgent ? firstAgent.modelId : '—'}）`, { readonly: true });
              pushMeta('ANTHROPIC_PERMISSION_MODE', 'bypassPermissions');
              pushMeta('CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT', '1');
              pushMeta('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '1000000');
              break;
            case 'zcode':
              pushMeta('CTI_ZCODE_CLI', resolvedPath, { note: '留空=自动探测桌面版内置 CLI' });
              pushMeta('CTI_ZCODE_STALL_MS', '300000');
              pushMeta('CTI_ZCODE_THINK_HEAD', '400');
              break;
            case 'opencode':
              pushMeta('CTI_OPENCODE_EXEC', resolvedPath, { note: '留空=自动探测 npm 全局位置' });
              pushMeta('CTI_OPENCODE_TIMEOUT_MS', '300000');
              pushMeta('CTI_OPENCODE_IDLE_TIMEOUT_MS', '1800000');
              break;
            case 'gemini':
              pushMeta('CTI_GEMINI_CLI_PATH', resolvedPath, { note: '留空=PATH 查找' });
              pushMeta('CTI_GEMINI_BASE_URL', rtProv?.baseURL || 'http://127.0.0.1:4000', { note: '留空=跟随 Agent 所选 Provider' });
              pushMeta('CTI_GEMINI_API_KEY', maskKey(readCredentialKey(rtProv?.apiKeyEnv || 'LITELLM_API_KEY') || readOldEnvKey(rtProv?.apiKeyEnv || 'LITELLM_API_KEY')), { secret: true, note: '留空=凭证层自动读取' });
              pushMeta('CTI_GEMINI_PROMPT_TIMEOUT_MS', '600000');
              break;
            case 'openakita':
              pushMeta('CTI_OPENAKITA_SERVER', resolvedPath, { note: '留空=项目 scripts/ 内置脚本' });
              pushMeta('CTI_OPENAKITA_WORKSPACE', path.join(os.homedir(), '.openakita', 'workspaces', 'default'), { note: '留空=OpenAkita 默认工作区' });
              break;
            case 'openclaw':
              pushMeta('CTI_OPENCLAW_EXEC', resolvedPath, { note: '留空=自动探测 npm 全局位置' });
              pushMeta('CTI_OPENCLAW_STATE_DIR', path.join(os.homedir(), '.openclaw'), { note: '留空=OpenClaw 自管' });
              break;
            case 'mimo':
              pushMeta('CTI_MIMO_EXEC', resolvedPath, { note: '留空=自动探测 npm 全局位置' });
              break;
            case 'reasonix':
              pushMeta('CTI_REASONIX_EXEC', resolvedPath, { note: '留空=自动探测安装位置/PATH' });
              pushMeta('CTI_REASONIX_TIMEOUT_MS', '300000');
              break;
            case 'hermes':
              pushMeta('CTI_HERMES_CLI_PATH', resolvedPath, { note: '留空=PATH 查找' });
              break;
            case 'dsh':
              pushMeta('CTI_DSH_HARNESS_PATH', resolvedPath.replace(/\\packages\\examples\\acp-demo\\src\\bin\.ts$/, ''), { note: 'DeepSeek Harness 根目录' });
              break;
            case 'codex': {
            // 三个值均由配置中心 syncModelToCli 自动写进 ~/.codex/config.toml（Agent 分配置切换即变）
            // → readonly 灰框展示真实生效值，不提供手改（老大要求：自动管理的值不可编辑）
            try {
              const toml = fs.readFileSync(path.join(process.env.CTI_USER_HOME || process.env.USERPROFILE || os.homedir(), '.codex', 'config.toml'), 'utf-8');
              const tomlVal = (key: string): string => {
                const m0 = toml.match(new RegExp('^' + key + '\\s*=\\s*"?([^"\\r\\n]+)"?\\s*$', 'm'));
                return m0 ? m0[1].trim() : '';
              };
              pushMeta('codex.model', tomlVal('model') || '（未生成）', { readonly: true, note: '当前模型 · 配置中心自动管理，在「Agent 分配置」切模型即变' });
              pushMeta('codex.model_provider', tomlVal('model_provider') || '（未生成）', { readonly: true, note: '预置端点 volcark/gw/litellm，配置中心按所选 Provider 自动切换' });
              pushMeta('codex.model_reasoning_effort', tomlVal('model_reasoning_effort') || '（未生成）', { readonly: true, note: '思考强度随 Agent「思考深度」设置（关闭=minimal）' });
              pushMeta('codex.model_max_output_tokens', tomlVal('model_max_output_tokens') || '（未生成）', { readonly: true, note: '最大输出 tokens' });
            } catch { pushMeta('codex.model', '（未安装 codex）', { readonly: true }); }
            break;
          }
          case 'deeptutor':
              pushMeta('CTI_DEEPTUTOR_TOKEN', maskKey(process.env.CTI_DEEPTUTOR_TOKEN || ''), { secret: true, note: '本机免鉴权留空；多用户部署填 Bearer Token' });
              break;
          }
          // 模板里还没出现的键 → 兜底填真实/模板值（保证无空白框）
          for (const [k, v] of Object.entries(tpl)) {
            if (!envMeta[k]) envMeta[k] = { value: over[k] !== undefined && over[k] !== '' ? over[k] : (v !== '' ? v : (env[k] || '（自动）')), note: ENV_LABELS[k] };
          }
          return {
            runtime: rt.runtime, display: rt.display, command: rt.command,
            envKey: rt.envKey, configured, resolvedPath, detected,
            kind: rt.service ? 'service' : 'cli',
            activeModel: (probe as any).activeModel || '',
            install: rt.install || '',
            envTpl: Object.keys(tpl).reduce<Record<string, string>>((a, k) => { a[k] = tpl[k]; return a; }, {}), // 默认模板（含空提示）
            envOver: Object.assign({}, over),      // 用户覆盖（仅显式保存的）
            env,                                    // 最终生效值（模板+覆盖合并）
            envMeta,                                // 每键真实生效值（secret 掩码 / readonly 跟随 Agent）
            envFlags: ENV_FLAG_KEYS[rt.runtime] || [],   // 开关型键（网页渲染成打勾开关）
            envLabels: ENV_LABELS,                       // 键的中文说明
          };
        }));
        return json(res, 200, { runtimes: list });
      }
      // POST /api/runtimes —— 保存某 runtime 的自定义 CLI 路径 / 启动 env 覆盖；存 config-open.json 的 cliPath / runtimeEnv 字段
      if (p === '/api/runtimes' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { runtime?: unknown; cliPath?: unknown; env?: unknown };
        const runtime = String(body.runtime || '');
        const cliPath = String(body.cliPath || '').trim();
        if (!REL_RUNTIMES.some((rt) => rt.runtime === runtime)) return json(res, 400, { error: `未知 runtime: ${runtime}` });
        const openFile = path.join(path.dirname(storeFile || defaultStorePath()), 'config-open.json');
        let data: { closed?: unknown; cliPath?: Record<string, string>; runtimeEnv?: Record<string, Record<string, string>> } = {};
        try { data = JSON.parse(fs.readFileSync(openFile, 'utf-8')); } catch {}
        // cliPath
        const mp = data.cliPath || (data.cliPath = {});
        if (cliPath) mp[runtime] = cliPath; else delete mp[runtime];
        // runtime env 覆盖（body.env = 用户想持久化的键值；空字符串值 = 删除该键覆盖）
        if (body.env !== undefined && typeof body.env === 'object') {
          const rem = data.runtimeEnv || (data.runtimeEnv = {});
          const cur: Record<string, string> = Object.assign({}, rem[runtime]);
          for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
            const s = String(v ?? '');
            if (s === '') delete cur[k]; else cur[k] = s;
          }
          // 清空后删掉该 runtime 条目，避免残留空对象
          if (Object.keys(cur).length === 0) delete rem[runtime]; else rem[runtime] = cur;
        }
        try { fs.writeFileSync(openFile, JSON.stringify(data, null, 2), 'utf-8'); } catch (e) { return json(res, 500, { ok: false, error: String(e) }); }
        return json(res, 200, { ok: true, runtime, cliPath });
      }

      // POST /api/agents
      if (p === '/api/agents' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const store = load();
        const agent: AgentDef = {
          id: String(body.id || '').trim(),
          displayName: String(body.displayName || body.id || '').trim(),
          appId: String(body.appId || ''),
          appSecret: String(body.appSecret || ''),
          providerId: String(body.providerId || store.providers[0]?.id || ''),
          modelId: String(body.modelId || ''),
          // 默认勾选全部 MCP（2026-09-05 老大反馈：新建 bot 默认全空导致能力缺失；不要的取消勾选即可）
          mcps: Array.isArray(body.mcps) ? body.mcps : store.mcps.map((m) => m.id),
          port: Number(body.port || 13600),
          showToolCallCards: body.showToolCallCards !== false,
          showAgentDivider: body.showAgentDivider !== false,
          showThinkingCards: body.showThinkingCards !== false,
          workdir: body.workdir ? String(body.workdir) : (store.defaultWorkdir || ''),
          enabled: body.enabled !== false,
          systemPrompt: body.systemPrompt ?? '',
          runtime: body.runtime ? String(body.runtime) : undefined,
        };
        if (!agent.id || agent.id.includes('/') || agent.id.includes('\\')) {
          return json(res, 400, { error: 'id 必填且不能含路径分隔符' });
        }
        if (store.agents.some((a) => a.id === agent.id)) {
          return json(res, 409, { error: `agent ${agent.id} 已存在` });
        }
        store.agents.push(agent);
        save(store);
        return json(res, 201, agent);
      }

      // PUT/DELETE /api/agents/:id
      if (routeMatch(p, '/api/agents/:id')) {
        const id = param(p, '/api/agents/:id', 'id');
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const store = load();
          const idx = store.agents.findIndex((a) => a.id === id);
          if (idx < 0) return json(res, 404, { error: 'not found' });
          const a = store.agents[idx];
          store.agents[idx] = {
            ...a,
            displayName: body.displayName ?? a.displayName,
            appId: body.appId ?? a.appId,
            appSecret: body.appSecret ?? a.appSecret,
            providerId: body.providerId ?? a.providerId,
            modelId: body.modelId ?? a.modelId,
            mcps: Array.isArray(body.mcps) ? body.mcps : a.mcps,
            port: body.port != null ? Number(body.port) : a.port,
            showToolCallCards: body.showToolCallCards ?? a.showToolCallCards,
            showAgentDivider: body.showAgentDivider ?? a.showAgentDivider,
            showThinkingCards: body.showThinkingCards ?? a.showThinkingCards,
            workdir: body.workdir ?? a.workdir,
            enabled: body.enabled ?? a.enabled,
            systemPrompt: body.systemPrompt ?? a.systemPrompt,
            // 2026-08-30 新增字段（状态栏图标/文字开关 + 思考深度开关）——漏加会导致 PUT 静默丢字段
            dividerMode: body.dividerMode ?? a.dividerMode,
            thinkingLevel: body.thinkingLevel ?? a.thinkingLevel,
            feishuCaps: Array.isArray(body.feishuCaps) ? body.feishuCaps : a.feishuCaps,
            // 2026-09-05 新增：runtime 透传（zcode 等新运行时经网页/API 建站时可选）
            runtime: body.runtime ?? a.runtime,
          };
          save(store);
          // 2026-08-30 修复（老大：更改配置必须穿透）：此前只写 store 就返回 ⇒ CLI 配置文件
          // 纹丝不动、进程不重启 ⇒ "状态栏显示新模型、实际跑的还是旧模型"。
          // 现在保存即 apply：精准合并 env/cordis + CLI 模型联动 + 重启该 agent 服务。
          try {
            const ap = await applyAgent(id);
            return json(res, 200, { ...store.agents[idx], apply: ap });
          } catch (e) {
            return json(res, 500, { error: `保存成功但 apply 失败: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        if (method === 'DELETE') {
          const store = load();
          store.agents = store.agents.filter((a) => a.id !== id);
          save(store);
          return json(res, 200, { ok: true });
        }
      }

      // POST /api/agents/:id/apply
      if (routeMatch(p, '/api/agents/:id/apply') && method === 'POST') {
        const id = param(p, '/api/agents/:id/apply', 'id');
        const r = await applyAgent(id);
        return json(res, r.ok ? 200 : 400, r);
      }

      // POST /api/agents-by-runtime/:runtime —— 穿透应用：对使用该 runtime 的所有 agent 重新 apply（重生成 env + 重启进程）
      // 用于"运行时管理页改了 CLI 路径 / 启动 env"后，一键让同一 runtime 的全部 agent 真正生效。
      if (routeMatch(p, '/api/agents-by-runtime/:runtime') && method === 'POST') {
        const runtime = param(p, '/api/agents-by-runtime/:runtime', 'runtime');
        const store = load();
        const targets = store.agents.filter((a) => (a.runtime || 'dsh') === runtime);
        if (targets.length === 0) return json(res, 200, { ok: true, applied: [] });
        const applied: string[] = [];
        const errors: string[] = [];
        for (const a of targets) {
          const r = await applyAgent(a.id);
          if (r.ok) applied.push(a.id); else errors.push(`${a.id}: ${r.error || '失败'}`);
        }
        return json(res, 200, { ok: errors.length === 0, applied, errors });
      }

      // POST /api/agents/:id/restart —— 只重启该 agent 的服务（nssm 短名），不重新生成配置
      if (routeMatch(p, '/api/agents/:id/restart') && method === 'POST') {
        const id = param(p, '/api/agents/:id/restart', 'id');
        const store = load();
        const agent = store.agents.find((a) => a.id === id);
        if (!agent) return json(res, 404, { error: `agent ${id} 不存在` });
        if (!restartOnApply) {
          return json(res, 200, { ok: true, skipped: true, message: 'restartOnApply=false（测试模式），跳过重启' });
        }
        try {
          const mode = await pmRestart(id);
          return json(res, 200, { ok: true, service: id, mode });
        } catch (e) {
          return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // POST /api/agents/:id/start | /stop —— 进程托管启停（有 nssm 服务转发 nssm；无则配置中心子进程托管，别人机器零 nssm 依赖）
      if (routeMatch(p, '/api/agents/:id/start') && method === 'POST') {
        const id = param(p, '/api/agents/:id/start', 'id');
        const store = load();
        if (!store.agents.find((a) => a.id === id)) return json(res, 404, { error: `agent ${id} 不存在` });
        const r = await pmStart(id);
        return json(res, 200, { ok: true, ...r });
      }
      if (routeMatch(p, '/api/agents/:id/stop') && method === 'POST') {
        const id = param(p, '/api/agents/:id/stop', 'id');
        const r = await pmStop(id);
        return json(res, 200, { ok: true, ...r });
      }

      // GET /api/proc-status —— 子进程托管状态（pid/uptime/重启计数/日志尾巴）
      if (p === '/api/proc-status' && method === 'GET') {
        return json(res, 200, { procs: pmStatus() });
      }

      // GET /api/bootstrap —— 首跑引导数据（fresh = 一个 agent 都没建；runtimes 带安装提示）
      if (p === '/api/bootstrap' && method === 'GET') {
        const store = load();
        return json(res, 200, {
          fresh: store.agents.length === 0,
          agentCount: store.agents.length,
          feishuAppGuide: 'https://open.feishu.cn/document/home/introduction-to-custom-app-creation/overview',
          runtimes: REL_RUNTIMES.map((rt) => ({ runtime: rt.runtime, display: rt.display, install: rt.install || '' })),
        });
      }

      // GET /api/agents/:id/status
      if (routeMatch(p, '/api/agents/:id/status') && method === 'GET') {
        const id = param(p, '/api/agents/:id/status', 'id');
        const store = load();
        const agent = store.agents.find((a) => a.id === id);
        if (!agent) return json(res, 404, { error: 'not found' });
        const st = await buildAgentRuntimeState(store, agent);
        return json(res, 200, st);
      }

      // ── 总配置：providers ──
      // 开合状态：存 config-store.json 同目录的 config-open.json（iframe 内 localStorage/cookie/hash 全不可靠，刷新即失忆）
      const readClosedIds = (): string[] => {
        const openFile = path.join(path.dirname(storeFile || defaultStorePath()), 'config-open.json');
        try {
          if (fs.existsSync(openFile)) {
            const parsed = JSON.parse(fs.readFileSync(openFile, 'utf-8')) as { closed?: unknown };
            if (Array.isArray(parsed.closed)) return parsed.closed.filter((x): x is string => typeof x === 'string');
          }
        } catch {}
        return [];
      };
      if (p === '/api/providers/open-state' && method === 'GET') {
        return json(res, 200, { closed: readClosedIds() });
      }
      if (p === '/api/providers/open-state' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { id?: unknown; closed?: unknown };
        const id = String(body.id || '');
        if (!id) return json(res, 400, { error: 'id 必填' });
        const openFile = path.join(path.dirname(storeFile || defaultStorePath()), 'config-open.json');
        const set = new Set(readClosedIds());
        if (body.closed === true) set.add(id); else set.delete(id);
        try { fs.writeFileSync(openFile, JSON.stringify({ closed: [...set] }, null, 2), 'utf-8'); } catch (e) { return json(res, 500, { ok: false, error: String(e) }); }
        return json(res, 200, { ok: true });
      }
      if (p === '/api/providers' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const store = load();
        const prov: ProviderDef = {
          id: String(body.id || '').trim(),
          displayName: String(body.displayName || body.id || ''),
          plugin: body.plugin === 'llm-deepseek' ? 'llm-deepseek' : 'llm-pi-ai',
          baseURL: body.baseURL || undefined,
          apiKeyEnv: String(body.apiKeyEnv || ''),
          api: body.api || 'openai-completions',
          models: Array.isArray(body.models) ? body.models : [],
        };
        if (!prov.id || store.providers.some((x) => x.id === prov.id)) {
          return json(res, 409, { error: 'provider id 非法或已存在' });
        }
        store.providers.push(prov);
        save(store);
        return json(res, 201, prov);
      }
      // 排序：按 body.ids 顺序重排 store.providers（未提及的保持原位）
      if (p === '/api/providers/reorder' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { ids?: unknown };
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const store = load();
        const rank = new Map<string, number>(ids.map((id, i) => [id, i]));
        store.providers.sort((a, b) => {
          const ra = rank.get(a.id), rb = rank.get(b.id);
          if (ra === undefined && rb === undefined) return 0;
          if (ra === undefined) return 1;
          if (rb === undefined) return -1;
          return ra - rb;
        });
        save(store);
        return json(res, 200, { ok: true });
      }
      if (routeMatch(p, '/api/providers/:id/test') && method === 'POST') {
        const id = param(p, '/api/providers/:id/test', 'id');
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = await testProviderConnection(id, body.model || undefined);
        return json(res, r.ok ? 200 : 400, r);
      }
      if (routeMatch(p, '/api/providers/:id')) {
        const id = param(p, '/api/providers/:id', 'id');
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const store = load();
          const idx = store.providers.findIndex((x) => x.id === id);
          if (idx < 0) return json(res, 404, { error: 'not found' });
          store.providers[idx] = { ...store.providers[idx], ...body, id };
          save(store);
          // 2026-08-30 精准穿透：provider 变更影响所有用它/它的模型定义的 agent ⇒ 逐个 apply
          const affected = store.agents.filter((a) => a.providerId === id);
          const results: Record<string, unknown> = {};
          for (const a of affected) {
            try { results[a.id] = (await applyAgent(a.id)).ok; } catch (e) { results[a.id] = String(e); }
          }
          return json(res, 200, { ...store.providers[idx], applied: results });
        }
        if (method === 'DELETE') {
          const store = load();
          store.providers = store.providers.filter((x) => x.id !== id);
          save(store);
          return json(res, 200, { ok: true });
        }
      }

      // ── 总配置：mcps ──
      if (p === '/api/mcps' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const store = load();
        const m: McpDef = {
          id: String(body.id || '').trim(),
          displayName: String(body.displayName || body.id || ''),
          transport: body.transport === 'stdio' ? 'stdio' : 'streamable-http',
          serverName: String(body.serverName || body.id || ''),
          url: body.url || undefined,
          command: body.command || undefined,
          args: Array.isArray(body.args) ? body.args : undefined,
          env: body.env || undefined,
          failOnStartupError: body.failOnStartupError !== false,
          toolCallTimeoutMs: body.toolCallTimeoutMs,
        };
        if (!m.id || store.mcps.some((x) => x.id === m.id)) {
          return json(res, 409, { error: 'mcp id 非法或已存在' });
        }
        store.mcps.push(m);
        save(store);
        return json(res, 201, m);
      }
      if (routeMatch(p, '/api/mcps/:id')) {
        const id = param(p, '/api/mcps/:id', 'id');
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const store = load();
          const idx = store.mcps.findIndex((x) => x.id === id);
          if (idx < 0) return json(res, 404, { error: 'not found' });
          store.mcps[idx] = { ...store.mcps[idx], ...body, id };
          save(store);
          return json(res, 200, store.mcps[idx]);
        }
        if (method === 'DELETE') {
          const store = load();
          store.mcps = store.mcps.filter((x) => x.id !== id);
          save(store);
          return json(res, 200, { ok: true });
        }
      }

      // ── 内建看图（look_image）──
      // GET /api/vision：读视觉配置
      if (p === '/api/vision' && method === 'GET') {
        const store = load();
        return json(res, 200, { ok: true, vision: store.vision });
      }
      // PUT /api/vision：更新视觉配置（apiKey 留空表示由凭证层读）
      if (p === '/api/vision' && method === 'PUT') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        store.vision = {
          ...(store.vision ?? { enabled: true, provider: 'online', baseUrl: '', apiKey: '', model: '', timeoutMs: 240000, prompts: {} }),
          ...body,
        };
        save(store);
        return json(res, 200, { ok: true, vision: store.vision });
      }
      // GET /api/vision/sample-image：返回项目内置样例图（前端预览图用）
      if (p === '/api/vision/sample-image' && method === 'GET') {
        if (!fs.existsSync(SAMPLE_VISION_IMAGE)) return json(res, 404, { error: 'sample image not found' });
        const buf = fs.readFileSync(SAMPLE_VISION_IMAGE);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
        res.end(buf);
        return;
      }

      // POST /api/vision/test：测试看图（body: { imagePath, task, extra }）
      if (p === '/api/vision/test' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        let imagePath = String(body.imagePath || '').trim();
        // imagePath 为空或 __sample__ 时用项目内置样例图（可分发）
        if (!imagePath || imagePath === '__sample__') {
          imagePath = SAMPLE_VISION_IMAGE;
        }
        const r = await lookImage({
          imagePath,
          task: String(body.task || 'describe'),
          extra: String(body.extra || ''),
          vision: store.vision,
        });
        return json(res, 200, r);
      }

      // ── 内建语音（ASR+TTS）──
      // GET /api/speech：读语音配置
      if (p === '/api/speech' && method === 'GET') {
        const store = load();
        // 用 DEFAULT 补齐全引擎缺省字段，保证前端拿到的 speech 结构完整
        const s = store.speech ?? DEFAULT_SPEECH;
        const d = DEFAULT_SPEECH;
        // 2026-09-01：tts 只白名单合并（此前 ...(s.tts ?? {}) 把历史写脏的嵌套 speech 段
        // 一起带出来，前端 PUT 又原样回传 → 垃圾字段自我繁殖）
        const full: SpeechConfig = {
          enabled: s.enabled ?? d.enabled,
          tts: {
            defaultEngine: s.tts?.defaultEngine ?? d.tts.defaultEngine,
            edge: { ...d.tts.edge, ...(s.tts?.edge ?? {}) },
            xiaomi: { ...d.tts.xiaomi, ...(s.tts?.xiaomi ?? {}) },
            voicedesign: { ...d.tts.voicedesign, ...(s.tts?.voicedesign ?? {}) },
            voiceclone: { ...d.tts.voiceclone, ...(s.tts?.voiceclone ?? {}) },
            local: { ...d.tts.local, ...(s.tts?.local ?? {}) },
            audio8: { ...d.tts.audio8, ...(s.tts?.audio8 ?? {}) },
            ali: { ...d.tts.ali, ...(s.tts?.ali ?? {}) },
          },
          asr: { ...d.asr, ...(s.asr ?? {}) },
        };
        return json(res, 200, { ok: true, speech: full });
      }
      // PUT /api/speech：写语音配置（各引擎子段深合并，缺省用 DEFAULT 兜底）
      if (p === '/api/speech' && method === 'PUT') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const base = store.speech ?? DEFAULT_SPEECH;
        const newTts = body.tts ?? {};
        const tts = {
          defaultEngine: newTts.defaultEngine ?? base.tts?.defaultEngine ?? DEFAULT_SPEECH.tts.defaultEngine,
          edge: { ...(base.tts?.edge ?? DEFAULT_SPEECH.tts.edge), ...(newTts.edge ?? {}) },
          xiaomi: { ...(base.tts?.xiaomi ?? DEFAULT_SPEECH.tts.xiaomi), ...(newTts.xiaomi ?? {}) },
          voicedesign: { ...(base.tts?.voicedesign ?? DEFAULT_SPEECH.tts.voicedesign), ...(newTts.voicedesign ?? {}) },
          voiceclone: { ...(base.tts?.voiceclone ?? DEFAULT_SPEECH.tts.voiceclone), ...(newTts.voiceclone ?? {}) },
          local: { ...(base.tts?.local ?? DEFAULT_SPEECH.tts.local), ...(newTts.local ?? {}) },
          audio8: { ...(base.tts?.audio8 ?? DEFAULT_SPEECH.tts.audio8), ...(newTts.audio8 ?? {}) },
          ali: { ...(base.tts?.ali ?? DEFAULT_SPEECH.tts.ali), ...(newTts.ali ?? {}) },
        };
        store.speech = {
          enabled: body.enabled ?? base.enabled ?? true,
          tts,
          asr: { ...(base.asr ?? DEFAULT_SPEECH.asr), ...(body.asr ?? {}) },
        };
        save(store);
        return json(res, 200, { ok: true, speech: store.speech });
      }
      // POST /api/speech/tts-test：测试 TTS 合成（body: { text, engine?, voiceDesc? }），返回 {ok, format, dataUrl?}
      if (p === '/api/speech/tts-test' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const text = String(body.text || '你好，这是一段语音试听。');
        const engine = String(body.engine || '');
        const voiceDesc = typeof body.voiceDesc === 'string' ? body.voiceDesc : undefined;
        const t0 = Date.now();
        const r = await synthesize(text, store.speech?.tts as TtsConfig, engine || undefined, voiceDesc);
        const elapsedMs = Date.now() - t0;
        if (r.ok && r.data) {
          const dataUrl = `data:audio/${r.format || 'mp3'};base64,${r.data.toString('base64')}`;
          return json(res, 200, { ok: true, engine: r.engine, format: r.format, dataUrl, lenBytes: r.data.length, elapsedMs });
        }
        return json(res, 200, { ok: false, error: r.error, elapsedMs });
      }
      // POST /api/speech/asr-test：测试 ASR 识别（body: { audioBase64, format? }）
      if (p === '/api/speech/asr-test' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const audioBase64 = String(body.audioBase64 || '');
        if (!audioBase64) return json(res, 200, { ok: false, error: '缺少 audioBase64' });
        const r = await transcribe(Buffer.from(audioBase64, 'base64'), store.speech?.asr as AsrConfig);
        return json(res, 200, r);
      }
      // GET /api/speech/asr-sample：返回一段示例音频（edge TTS 合成，转 16k wav，缓存），供 ASR 测试试听+识别
      if (p === '/api/speech/asr-sample' && method === 'GET') {
        const store = load();
        try {
          const homeDir = process.env.CTI_USER_HOME || os.homedir();
          const sampleDir = path.join(homeDir, '.agents-to-feishu');
          const samplePath = path.join(sampleDir, 'asr-sample.wav');
          if (!fs.existsSync(samplePath) || fs.statSync(samplePath).size === 0) {
            fs.mkdirSync(sampleDir, { recursive: true });
            const text = '你好，这是一段语音识别测试音频。你可以点击播放试听，也可以直接识别这段音频。';
            const mp3 = await synthesize(text, store.speech?.tts as TtsConfig, 'edge');
            if (!mp3.ok || !mp3.data) return json(res, 200, { ok: false, error: `示例音频合成失败: ${mp3.error || ''}` });
            const tmpIn = path.join(process.env.TEMP || '.', `atf-asr-sample-${Date.now()}.mp3`);
            const tmpWav = path.join(process.env.TEMP || '.', `atf-asr-sample-${Date.now()}.wav`);
            fs.writeFileSync(tmpIn, mp3.data);
            let wavBytes: Buffer;
            try {
              // 同步转 16k 单声道 wav（sherpa 只认标准 wav；失败则用 mp3 兜底但标记 mediaType）
              execFileSync(resolveFfmpeg(), ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav], {
                windowsHide: true, stdio: 'ignore', timeout: 30000,
              });
              wavBytes = fs.readFileSync(tmpWav);
            } catch {
              wavBytes = mp3.data;
            } finally {
              try { fs.unlinkSync(tmpIn) } catch {} try { fs.unlinkSync(tmpWav) } catch {}
            }
            fs.writeFileSync(samplePath, wavBytes);
            const mediaType = mp3.data !== null && wavBytes === mp3.data ? 'audio/mpeg' : 'audio/wav';
            return json(res, 200, { ok: true, mediaType, data: wavBytes.toString('base64'), text });
          }
          const wav = fs.readFileSync(samplePath);
          return json(res, 200, { ok: true, mediaType: 'audio/wav', data: wav.toString('base64') });
        } catch (e) {
          return json(res, 200, { ok: false, error: `示例音频失败: ${(e as Error)?.message ?? String(e)}` });
        }
      }

      // GET /api/speech/voice-clone/source：克隆原音试听（读样本原文件，白名单=已登记样本）
      if (p === '/api/speech/voice-clone/source' && method === 'GET') {
        const store = load();
        const id = u.searchParams.get('id') || '';
        const samples = store.speech?.tts?.voiceclone?.samples ?? [];
        const s = samples.find((x) => x.id === id);
        if (!s?.path || !fs.existsSync(s.path)) return json(res, 200, { ok: false, error: '克隆样本不存在' });
        try {
          const bytes = fs.readFileSync(s.path);
          const ext = (s.path.split('.').pop() || '').toLowerCase();
          const mediaType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
          return json(res, 200, { ok: true, mediaType, data: bytes.toString('base64'), name: s.name });
        } catch {
          return json(res, 200, { ok: false, error: '读取样本失败' });
        }
      }
      // GET /api/speech/voice-clone/preview：克隆预生成试听（<id>-preview.mp3，免实时合成省 token）
      if (p === '/api/speech/voice-clone/preview' && method === 'GET') {
        const id = u.searchParams.get('id') || '';
        if (!/^[0-9a-zA-Z-]{8,}$/.test(id)) return json(res, 200, { ok: false, error: 'invalid id' });
        const homeDir = process.env.CTI_USER_HOME || os.homedir();
        const candidates = [
          path.join(homeDir, '.agents-to-feishu', 'voiceclone-samples', `${id}-preview.mp3`),
          path.join(homeDir, '.dsh', 'voiceclone-samples', `${id}-preview.mp3`),
        ];
        const f = candidates.find((x) => fs.existsSync(x));
        if (!f) return json(res, 200, { ok: false, error: '尚未生成试听录音' });
        try {
          const bytes = fs.readFileSync(f);
          return json(res, 200, { ok: true, mediaType: 'audio/mpeg', data: bytes.toString('base64') });
        } catch {
          return json(res, 200, { ok: false, error: '读取试听失败' });
        }
      }
      // POST /api/speech/voice-clone/add：上传克隆样本（name + audioBase64 + mediaType + context + previewText）
      if (p === '/api/speech/voice-clone/add' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const audioBase64 = String(body.audioBase64 || '');
        if (!audioBase64) return json(res, 200, { ok: false, error: '缺少音频' });
        const bytes = Buffer.from(audioBase64, 'base64');
        if (bytes.byteLength === 0) return json(res, 200, { ok: false, error: '音频为空' });
        if (bytes.byteLength > 10 * 1024 * 1024) return json(res, 200, { ok: false, error: '音频需在 10MB 以内' });
        const mediaType = String(body.mediaType || 'audio/wav');
        const isMp3 = /mp3|mpeg/i.test(mediaType);
        const homeDir = process.env.CTI_USER_HOME || os.homedir();
        const sampleDir = path.join(homeDir, '.agents-to-feishu', 'voiceclone-samples');
        fs.mkdirSync(sampleDir, { recursive: true });
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const finalSuffix = isMp3 ? 'mp3' : 'wav';
        const samplePath = path.join(sampleDir, `${id}.${finalSuffix}`);
        fs.writeFileSync(samplePath, bytes);
        const name = String(body.name || '').trim() || `克隆音色-${Date.now()}`;
        // [2026-09-01] 对齐 dsh-web（老大：试听文本内置固定、沟通指令用小团团默认、名字用文件名——
        // 前端已删名称/沟通指令输入框，这里兜底内置默认）
        const DEFAULT_CLONE_CONTEXT = '一个魔性的少女萝莉音，说话自带沙雕搞怪和无厘头气质，像在撒娇又像在耍宝，情绪起伏很大：前一句还奶声奶气地撒娇卖萌，后一句就突然拔高音量夸张卖惨耍赖，再下一秒又贱兮兮地坏笑。尾音拖长上扬，带着气音和魔性笑声，喜欢用「臭猪」「你凶我」「哼」「嘿嘿嘿」这类咋咋呼呼的用词，语速忽快忽慢、节奏跳跃，吐字软糯清晰，傻白甜又可爱，让人听了忍不住想笑';
        const DEFAULT_CLONE_PREVIEW_TEXT = '哈喽哈喽！听到这段声音就说明克隆成功啦，怎么样，像不像我本人呀？嘿嘿，以后就用这个声音陪你聊天咯！';
        const newSample = {
          id, name, path: samplePath,
          context: String(body.context || '').trim() || DEFAULT_CLONE_CONTEXT,
          previewText: String(body.previewText || '').trim() || DEFAULT_CLONE_PREVIEW_TEXT,
        };
        const base = store.speech ?? DEFAULT_SPEECH;
        const samples = Array.isArray(base.tts?.voiceclone?.samples) ? [...base.tts.voiceclone.samples] : [];
        samples.push(newSample);
        store.speech = {
          ...base,
          tts: { ...base.tts, voiceclone: { ...(base.tts?.voiceclone ?? DEFAULT_SPEECH.tts.voiceclone), samples } },
        };
        save(store);
        // [2026-09-01] 保存成功后预生成试听录音 <id>-preview.mp3（fire-and-forget）：
        // 「克隆声」按钮直接读静态文件，省 token，没配小米 key 的用户也能试听
        void (async () => {
          try {
            const xiaomiCfg = (store.speech ?? DEFAULT_SPEECH).tts?.xiaomi;
            const key = String(xiaomiCfg?.apiKey ?? '');
            if (key === '') return;
            const r = await synthesizeVoiceClone(
              newSample.previewText,
              { ...(base.tts?.voiceclone ?? DEFAULT_SPEECH.tts.voiceclone), samples: [newSample], sampleId: id },
              key, String(xiaomiCfg?.baseUrl || 'https://api.xiaomimimo.com/v1'), '',
            );
            if (r?.ok && r.data && r.data.length > 1000) {
              fs.writeFileSync(path.join(sampleDir, `${id}-preview.mp3`), r.data);
            }
          } catch { /* 预生成失败不影响添加（试听时实时合成兜底） */ }
        })();
        return json(res, 200, { ok: true, sample: newSample });
      }
      // GET /api/speech/audio8/voices：Audio8 已注册音色（读 voices\<name>\meta.json）
      if (p === '/api/speech/audio8/voices' && method === 'GET') {
        try {
          const items = fs.readdirSync(AUDIO8_VOICES_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => {
              let text = '';
              let createdAt = '';
              // 2026-09-01：音色 id 只能字母数字（register_voice.py 限制 + 目录名），
              // 但显示名可以是中文（如 xiaotuantuan → 小团团），存在 meta.json 的 display 字段
              let display = '';
              try {
                const meta = JSON.parse(fs.readFileSync(path.join(AUDIO8_VOICES_DIR, d.name, 'meta.json'), 'utf8')) as Record<string, unknown>;
                text = String(meta.reference_text ?? meta.text ?? '').slice(0, 200);
                createdAt = String(meta.created_at ?? '');
                display = String(meta.display ?? '');
              } catch { /* 没 meta.json 也照样列出来 */ }
              return { name: d.name, display: display || d.name, text, createdAt };
            })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          return json(res, 200, { ok: true, voices: items });
        } catch (e) {
          return json(res, 200, { ok: false, voices: [], error: `读取 Audio8 音色目录失败: ${(e as Error)?.message ?? String(e)}` });
        }
      }
      // POST /api/speech/audio8/register：上传参考音频 → 转 16k/单声道/≤30s → ASR 逐字文本 → register_voice.py 注册
      if (p === '/api/speech/audio8/register' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const audioBase64 = String(body.audioBase64 || '');
        if (!audioBase64) return json(res, 200, { ok: false, error: '缺少音频' });
        const bytes = Buffer.from(audioBase64, 'base64');
        if (bytes.byteLength === 0) return json(res, 200, { ok: false, error: '音频为空' });
        if (bytes.byteLength > 20 * 1024 * 1024) return json(res, 200, { ok: false, error: '音频需在 20MB 以内' });
        // register_voice.py 的 --name 只接受字母数字-_：中文名会被拒，这里兜底转换
        const rawName = String(body.name || '').trim();
        const name = rawName.replace(/[^A-Za-z0-9_-]/g, '') || `voice${Date.now().toString(36)}`;
        const tmpDir = path.join(os.tmpdir(), 'agents-to-feishu-audio8');
        fs.mkdirSync(tmpDir, { recursive: true });
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const src = path.join(tmpDir, `${id}.src`);
        fs.writeFileSync(src, bytes);
        const wav = path.join(tmpDir, `${id}.wav`);
        try {
          execFileSync(resolveFfmpeg(), ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-t', '30', wav],
            { windowsHide: true, stdio: 'ignore', timeout: 60_000 });
        } catch (e) {
          return json(res, 200, { ok: false, error: `音频转码失败（需 ffmpeg，且参考音 ≤30s）: ${(e as Error)?.message ?? String(e)}` });
        }
        let text = String(body.text || '').trim();
        if (!text) {
          try {
            const r = await transcribe(fs.readFileSync(wav), store.speech?.asr as AsrConfig);
            text = String(r.text ?? '').trim();
          } catch (e) {
            return json(res, 200, { ok: false, error: `ASR 转写失败: ${(e as Error)?.message ?? String(e)}（也可以手填逐字文本）` });
          }
        }
        if (!text) return json(res, 200, { ok: false, error: '拿不到这段音频的逐字文本，请在「逐字文本」里手填' });
        try {
          execFileSync(AUDIO8_PY, [
            path.join(AUDIO8_DIR, 'register_voice.py'),
            '--audio', wav, '--text', text, '--name', name, '--overwrite',
          ], {
            cwd: AUDIO8_DIR, windowsHide: true, encoding: 'utf8', timeout: 180_000,
            env: { ...process.env, PYTHONUTF8: '1' },
          });
        } catch (e) {
          return json(res, 200, { ok: false, error: `注册音色失败: ${(e as Error)?.message ?? String(e)}` });
        }
        // 2026-09-01：把用户填的中文名写回 meta.json 的 display（音色 id 仍是英文，展示用中文）
        try {
          const metaPath = path.join(AUDIO8_VOICES_DIR, name, 'meta.json');
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
          meta.display = rawName || name;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        } catch { /* display 写不进去不影响音色本身 */ }
        return json(res, 200, { ok: true, voice: name, display: rawName || name, text });
      }
      // 2026-09-01 Audio8 卡照「语音克隆」模板重做：原音可播 + 克隆声实时生成 + 保底音色不可删
      const AUDIO8_SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
      /** 保底音色：老大给的克隆样例，永远保留（页面不给删除按钮，服务端也拒绝） */
      const AUDIO8_BUNDLED_VOICE = 'xiaotuantuan';
      const audio8VoiceDir = (name: string): string | null =>
        AUDIO8_SAFE_NAME.test(name) ? path.join(AUDIO8_VOICES_DIR, name) : null;

      // GET /api/speech/audio8/source?voice=xxx：播放该音色的参考原音（voices\<name>\reference.wav）
      if (p === '/api/speech/audio8/source' && method === 'GET') {
        const name = String(new URL(req.url ?? '', 'http://x').searchParams.get('voice') ?? '').trim();
        const dir = audio8VoiceDir(name);
        if (!dir) return json(res, 200, { ok: false, error: '音色名不合法' });
        const src = path.join(dir, 'reference.wav');
        if (!fs.existsSync(src)) return json(res, 200, { ok: false, error: `音色「${name}」没有参考原音文件` });
        return json(res, 200, { ok: true, mediaType: 'audio/wav', data: fs.readFileSync(src).toString('base64') });
      }
      // POST /api/speech/audio8/preview：用该音色实时克隆一段（不落盘、不缓存，用完即弃）
      if (p === '/api/speech/audio8/preview' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.voice ?? '').trim();
        const text = String(body.text ?? '').trim() || '你好，这是用这段参考音克隆出来的声音。';
        if (!AUDIO8_SAFE_NAME.test(name)) return json(res, 200, { ok: false, error: '音色名不合法' });
        const dir = path.join(AUDIO8_VOICES_DIR, name);
        if (!fs.existsSync(dir)) return json(res, 200, { ok: false, error: `音色「${name}」不存在` });
        const base = store.speech?.tts ?? DEFAULT_SPEECH.tts;
        const tts = { ...base, audio8: { ...(base.audio8 ?? DEFAULT_SPEECH.tts.audio8), voice: name } } as TtsConfig;
        const t0 = Date.now();
        // 第 3 参 engineOverride='audio8'：试听不自动降级，如实暴露该引擎的真实报错
        const r = await synthesize(text, tts, 'audio8');
        const elapsedMs = Date.now() - t0;
        if (r.ok && r.data) {
          return json(res, 200, {
            ok: true, engine: 'audio8', format: r.format || 'wav', elapsedMs,
            dataUrl: `data:audio/${r.format || 'wav'};base64,${r.data.toString('base64')}`,
          });
        }
        return json(res, 200, { ok: false, error: r.error ?? '合成失败', elapsedMs });
      }
      // POST /api/speech/audio8/delete：删掉一个自己注册的音色（保底音色拒绝删除）
      if (p === '/api/speech/audio8/delete' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.voice ?? '').trim();
        const dir = audio8VoiceDir(name);
        if (!dir) return json(res, 200, { ok: false, error: '音色名不合法' });
        if (name === AUDIO8_BUNDLED_VOICE) return json(res, 200, { ok: false, error: `「${name}」是保底音色，不能删` });
        if (!fs.existsSync(dir)) return json(res, 200, { ok: false, error: `音色「${name}」不存在` });
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          return json(res, 200, { ok: true, voice: name });
        } catch (e) {
          return json(res, 200, { ok: false, error: `删除失败: ${(e as Error)?.message ?? String(e)}` });
        }
      }
      // GET /api/speech/voice-design-samples：VoiceDesign 官方示例（预生成音频，简单术右侧播放）
      if (p === '/api/speech/voice-design-samples' && method === 'GET') {
        const defs = [
          { key: 'asmr', title: 'ASMR 双耳女声', instruct: '年轻的女性声音，近距离的聆听效果，带有双耳刺激的ASMR感。可以听到她的呼吸声、轻微的吞咽声，以及轻柔的自然唇音。她的说话速度非常慢，营造出一种极度放松且沉浸式的体验。', text: '嘘……放松点，再靠近一点吧。我现在就在你身边。慢慢、轻柔地呼吸，让思绪随着水流轻轻流淌，就像沉浸在温暖的水中一样。' },
          { key: 'docu', title: '纪录片旁白', instruct: '一位中年男性，说标准普通话，嗓音低沉有磁性，带有轻微的沙哑质感，像纪录片旁白解说员，沉稳而有感染力。', text: '当最后一缕阳光消失在地平线之下，这片沉睡了亿万年的大地开始显露它真正的面貌。每一块岩石都记录着时间的流逝，每一阵风都在诉说着古老的故事。' },
          { key: 'elder', title: '年迈老先生旁白', instruct: '一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。', text: '我这辈子啊，走南闯北六十多年。见过最热闹的集市，也见过最安静的戈壁。到头来才明白一个道理，不在于走了多远的路，在于记住了多少风景。年轻人，别光顾着赶路，偶尔也停下来看看天。' },
        ];
        const results = [];
        for (const d of defs) {
          const f = path.join(PROJECT_ROOT, 'assets', 'voice-design-samples', `${d.key}.wav`);
          if (fs.existsSync(f)) {
            results.push({ key: d.key, title: d.title, instruct: d.instruct, text: d.text, mediaType: 'audio/wav', data: fs.readFileSync(f).toString('base64') });
          }
        }
        return json(res, 200, { ok: true, samples: results });
      }

      // ── 技能库（项目 skills/ 挂载管理 + 市场安装）──
      // 技能名白名单：只允许字母/数字/-/_（防目录穿越）。安全校验。
      const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
      const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');
      const MARKET_DIR = path.join(PROJECT_ROOT, 'skills-market');
      const listSkillDirs = (dir: string): string[] => {
        const names: string[] = [];
        try {
          if (!fs.existsSync(dir)) return names;
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.isDirectory() && fs.existsSync(path.join(dir, ent.name, 'SKILL.md'))) names.push(ent.name);
          }
        } catch { /* 忽略 */ }
        return names.sort();
      };
      const readSkillMd = (dir: string, name: string): string => {
        try { return fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf-8'); } catch { return ''; }
      };
      const firstLine = (content: string): string => {
        if (!content) return '';
        const t = content.replace(/^\uFEFF/, '');
        const ln = t.split('\n').map((x) => x.trim()).find((x) => x !== '' && !x.startsWith('#'));
        return (ln || '').slice(0, 80);
      };

      // GET /api/skills：已安装技能列表 + 启停配置 + 市场 URL
      if (p === '/api/skills' && method === 'GET') {
        const store = load();
        const installed = listSkillDirs(PROJECT_SKILLS_DIR);
        const market = listSkillDirs(MARKET_DIR);
        const enabledCfg = store.skills?.enabled ?? [];
        const hasSkillCfg = store.skills !== undefined && Array.isArray(store.skills.enabled);
        // 有效启停视图：skills 未配置 = 全挂（兼容），否则严格按白名单（空数组=全停用）
        const effectiveEnabled = hasSkillCfg ? enabledCfg : installed.slice();
        const skills = installed.map((name) => {
          const content = readSkillMd(PROJECT_SKILLS_DIR, name);
          return {
            name,
            installed: true,
            enabled: effectiveEnabled.includes(name),
            desc: firstLine(content),
            content,
          };
        });
        return json(res, 200, {
          ok: true,
          skills,
          market: market.map((name) => ({
            name,
            installed: installed.includes(name),
            desc: firstLine(readSkillMd(MARKET_DIR, name)),
          })),
          config: { enabled: store.skills?.enabled ?? [], marketUrl: store.skills?.marketUrl ?? '' },
        });
      }

      // GET /api/skills/content?name=&source=project|market：读某技能 SKILL.md
      if (p === '/api/skills/content' && method === 'GET') {
        const name = String(u.searchParams.get('name') || '');
        const source = String(u.searchParams.get('source') || 'project');
        if (!SAFE_NAME.test(name)) return json(res, 400, { ok: false, error: '非法技能名' });
        const base = source === 'market' ? MARKET_DIR : PROJECT_SKILLS_DIR;
        const content = readSkillMd(base, name);
        if (!content) return json(res, 404, { ok: false, error: '技能不存在' });
        return json(res, 200, { ok: true, name, content, source });
      }

      // POST /api/skills/save {name, content}：新建/覆盖 skills/<name>/SKILL.md（并纳入启用）
      if (p === '/api/skills/save' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.name || '').trim();
        const content = String(body.content ?? '');
        if (!SAFE_NAME.test(name)) return json(res, 400, { ok: false, error: '非法技能名（字母数字_-，≤64位）' });
        if (content.trim() === '') return json(res, 400, { ok: false, error: 'SKILL.md 内容不能为空' });
        const dir = path.join(PROJECT_SKILLS_DIR, name);
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
        } catch (e) { return json(res, 500, { ok: false, error: `写入失败: ${(e as Error)?.message ?? String(e)}` }); }
        // 自动纳入启用白名单
        const next = new Set(store.skills?.enabled ?? []);
        next.add(name);
        store.skills = { enabled: Array.from(next), marketUrl: store.skills?.marketUrl ?? '' };
        save(store);
        return json(res, 200, { ok: true, name });
      }

      // POST /api/skills/delete {name}：删除 skills/<name> 目录 + 白名单移除
      if (p === '/api/skills/delete' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.name || '').trim();
        if (!SAFE_NAME.test(name)) return json(res, 400, { ok: false, error: '非法技能名' });
        const dir = path.join(PROJECT_SKILLS_DIR, name);
        try {
          if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); }
        } catch (e) { return json(res, 500, { ok: false, error: `删除失败: ${(e as Error)?.message ?? String(e)}` }); }
        if (store.skills?.enabled) {
          store.skills = { enabled: store.skills.enabled.filter((x) => x !== name), marketUrl: store.skills.marketUrl ?? '' };
          save(store);
        }
        return json(res, 200, { ok: true, name });
      }

      // POST /api/skills/toggle {name, enabled}：启停技能（写 skills.enabled 白名单）
      if (p === '/api/skills/toggle' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.name || '').trim();
        const on = body.enabled === true;
        if (!SAFE_NAME.test(name)) return json(res, 400, { ok: false, error: '非法技能名' });
        const installed = listSkillDirs(PROJECT_SKILLS_DIR);
        // enabled 白名单：skills 未配置(undefined) 首次 toggle 时初始化为当前全部已安装；否则严格按现有白名单（含空数组=全停）
        let en = (store.skills !== undefined && Array.isArray(store.skills.enabled)) ? store.skills.enabled.slice() : installed.slice();
        if (on) { if (!en.includes(name)) en.push(name); }
        else { en = en.filter((x) => x !== name); }
        store.skills = { enabled: en, marketUrl: store.skills?.marketUrl ?? '' };
        save(store);
        return json(res, 200, { ok: true, enabled: en });
      }

      // GET /api/skills/market：本地市场 + 远程市场（config.skills.marketUrl 非空时拉取索引）
      if (p === '/api/skills/market' && method === 'GET') {
        const store = load();
        const installed = listSkillDirs(PROJECT_SKILLS_DIR);
        const local = listSkillDirs(MARKET_DIR).map((name) => ({
          name,
          installed: installed.includes(name),
          desc: firstLine(readSkillMd(MARKET_DIR, name)),
        }));
        let remote: Array<{ name: string; content: string; installed: boolean; desc: string }> = [];
        let remoteError = '';
        const marketUrl = (store.skills?.marketUrl ?? '').trim();
        if (marketUrl !== '') {
          try {
            const r = await fetch(marketUrl, { signal: AbortSignal.timeout(15000) });
            if (r.ok) {
              const data = await r.json().catch(() => null) as { skills?: Array<Record<string, string>> } | null;
              if (data && Array.isArray(data.skills)) {
                remote = data.skills
                  .filter((s) => s && typeof s.name === 'string' && SAFE_NAME.test(s.name) && typeof s.content === 'string')
                  .map((s) => ({ name: s.name, content: s.content, installed: installed.includes(s.name), desc: firstLine(s.content) }));
              } else {
                remoteError = '市场索引缺少 skills 数组';
              }
            } else {
              remoteError = `市场索引返回 ${r.status}`;
            }
          } catch (e) { remoteError = `拉取失败: ${(e as Error)?.message ?? String(e)}`; }
        }
        return json(res, 200, { ok: true, local, remote, remoteError, marketUrl });
      }

      // POST /api/skills/install {name, source?: 'local'|'remote', content?}：从市场安装到 skills/
      if (p === '/api/skills/install' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String(body.name || '').trim();
        const source = String(body.source || 'local');
        if (!SAFE_NAME.test(name)) return json(res, 400, { ok: false, error: '非法技能名' });
        let content = String(body.content ?? '');
        if (content === '') {
          const base = source === 'remote' ? '' : MARKET_DIR;
          if (base === '') return json(res, 400, { ok: false, error: '远程安装必须携带 content' });
          content = readSkillMd(MARKET_DIR, name);
        }
        if (content.trim() === '') return json(res, 400, { ok: false, error: '技能内容为空' });
        const dir = path.join(PROJECT_SKILLS_DIR, name);
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
        } catch (e) { return json(res, 500, { ok: false, error: `安装失败: ${(e as Error)?.message ?? String(e)}` }); }
        const next = new Set(store.skills?.enabled ?? []);
        next.add(name);
        store.skills = { enabled: Array.from(next), marketUrl: store.skills?.marketUrl ?? '' };
        save(store);
        return json(res, 200, { ok: true, name });
      }

      // POST /api/skills/save-market-url {url}：保存远程市场索引 URL
      if (p === '/api/skills/save-market-url' && method === 'POST') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        const url = String(body.url || '').trim();
        store.skills = { enabled: store.skills?.enabled ?? [], marketUrl: url };
        save(store);
        return json(res, 200, { ok: true, marketUrl: url });
      }

      // ── 注入（统一注入，config-store.json 是唯一真相源；独立注入在 agent 编辑）──
      // GET /api/injection：返回统一注入全文 + 启用开关
      if (p === '/api/injection' && method === 'GET') {
        const store = load();
        return json(res, 200, {
          ok: true,
          enabled: store.injection?.enabled !== false,
          global: store.injection?.global ?? '',
        });
      }
      // PUT /api/injection：写统一注入全文（body: { enabled?, global? }）
      if (p === '/api/injection' && method === 'PUT') {
        const store = load();
        const body = JSON.parse((await readBody(req)) || '{}');
        store.injection = {
          enabled: body.enabled !== undefined ? body.enabled !== false : (store.injection?.enabled !== false),
          global: typeof body.global === 'string' ? body.global : (store.injection?.global ?? ''),
        };
        save(store);
        return json(res, 200, { ok: true, enabled: store.injection.enabled, global: store.injection.global });
      }

      // ── 内建 ComfyUI 生图（转发 8090，项目内建让 AI 会生图）──
      // GET /api/comfy/templates：列出生图/视频模板
      if (p === '/api/comfy/templates' && method === 'GET') {
        try {
          const r = await fetch('http://127.0.0.1:8090/templates', { signal: AbortSignal.timeout(10000) });
          if (!r.ok) return json(res, 502, { ok: false, error: `ComfyUI 返回 ${r.status}` });
          return json(res, 200, await r.json());
        } catch (e) {
          return json(res, 502, { ok: false, error: `ComfyUI 不可达: ${(e as Error)?.message ?? String(e)}` });
        }
      }
      // POST /api/comfy/generate：生图/生视频（body 透传给 8090 /generate，含 template/prompt/width/height/seed/image…）
      if (p === '/api/comfy/generate' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        try {
          const r = await fetch('http://127.0.0.1:8090/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(600000), // 生图可能几分钟（XDN 远程）
          });
          if (!r.ok) {
            let err = ''; try { err = (await r.text()).slice(0, 300) } catch { /* 忽略 */ }
            return json(res, 502, { ok: false, error: `ComfyUI 返回 ${r.status}: ${err}` });
          }
          return json(res, 200, await r.json());
        } catch (e) {
          return json(res, 502, { ok: false, error: `ComfyUI 调用失败: ${(e as Error)?.message ?? String(e)}` });
        }
      }
      // POST /api/comfy/reverse_prompt：图片反推提示词
      if (p === '/api/comfy/reverse_prompt' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        try {
          const r = await fetch('http://127.0.0.1:8090/reverse_prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
          });
          if (!r.ok) return json(res, 502, { ok: false, error: `ComfyUI 返回 ${r.status}` });
          return json(res, 200, await r.json());
        } catch (e) {
          return json(res, 502, { ok: false, error: `ComfyUI 调用失败: ${(e as Error)?.message ?? String(e)}` });
        }
      }
      // GET /api/comfy/output/:name：代理 8090 /output/{name} 返回图片/视频字节（前端/生图结果展示用）
      if (routeMatch(p, '/api/comfy/output/:name')) {
        const name = param(p, '/api/comfy/output/:name', 'name');
        try {
          const r = await fetch(`http://127.0.0.1:8090/output/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(60000) });
          if (!r.ok) {
            let err = ''; try { err = (await r.text()).slice(0, 200); } catch { /* 忽略 */ }
            return json(res, 502, { ok: false, error: `ComfyUI 返回 ${r.status}: ${err}` });
          }
          const buf = Buffer.from(await r.arrayBuffer());
          const ct = r.headers.get('content-type') || 'application/octet-stream';
          res.writeHead(200, { 'content-type': ct, 'cache-control': 'max-age=3600' });
          res.end(buf);
          return;
        } catch (e) {
          return json(res, 502, { ok: false, error: `ComfyUI 调用失败: ${(e as Error)?.message ?? String(e)}` });
        }
      }

      // 未匹配
      return json(res, 404, { error: `no route ${method} ${p}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`error: ${msg}`);
      return json(res, 500, { error: msg });
    }
  };

  const server = http.createServer(requestHandler);

  return {
    server,
    listen(): Promise<void> {
      // 多地址绑定：每个 host 一个 server 实例，共享同一个请求处理器
      const listeners = hosts.map((h) => {
        const srv = h === hosts[0] ? server : http.createServer(requestHandler);
        return new Promise<void>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(port, h, () => {
            log(`配置中心已启动 http://${h}:${port}`);
            resolve();
          });
        });
      });
      return Promise.all(listeners).then(() => undefined);
    },
    /**
     * 追加绑定一个地址（2026-08-30 修复开机竞态）：
     * 断电/重启后 Tailscale 网卡可能晚于本服务出现 ⇒ 启动瞬间探测不到 ⇒ 只绑 127.0.0.1，
     * 老大从 Tailscale 打不开。服务起来后由调用方周期探测，网卡一出现就补绑。
     */
    bindHost(host: string): Promise<void> {
      if (hosts.includes(host)) return Promise.resolve();
      hosts.push(host);
      const srv = http.createServer(requestHandler);
      return new Promise<void>((resolve, reject) => {
        srv.once('error', (e) => { hosts.splice(hosts.indexOf(host), 1); reject(e); });
        srv.listen(port, host, () => {
          log(`配置中心追加绑定 http://${host}:${port}（网卡延迟就绪，补绑）`);
          resolve();
        });
      });
    },
    /** 当前已绑定地址（供调用方判断缺哪些） */
    boundHosts(): string[] {
      return [...hosts];
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    applyAgent,
  };
}

// ── 进程重启（独立于服务，供 apply 调用）──

/**
 * 重启某 agent 的 ACP 进程（apply 后真实生效）。
 * 2026-09-05 委托进程管理器：有 nssm 服务走 nssm restart；没有（别人机器）走子进程托管重启，
 * 零 nssm 依赖。失败不阻塞 apply（配置文件已写好，进程起不起得来看状态页排障）。
 */
export function restartAgentProcess(agentId: string): Promise<void> {
  return pmRestart(agentId).then((r) => {
    console.log(`[config-center] restart ${agentId} mode=${r.mode}`);
  });
}

// 供测试直接调用
export function _createServerForTest(opts: ConfigServerOptions) {
  return createConfigServer(opts);
}

