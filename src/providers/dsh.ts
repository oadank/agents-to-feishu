/**
 * DSH Provider — ACP 协议接入 DeepSeek Harness ACP 服务器。
 *
 * 架构：单 ACP 进程 + 进程内多会话。
 * 实测（2026-08-24）：DSH acp-demo 支持一个进程内 session/new 多次，各 session
 * 上下文完全隔离（session#2 不知 session#1 内容）。因此 /new 只需在现有进程里
 * 开新 session，绝不杀进程。
 *
 * 进程模型：10 个飞书对话 = 1 个 ACP 进程 + 进程内 10 个 session。
 * - 会话上限 CTI_DSH_MAX_SESSIONS（默认 20），超出按 LRU 淘汰最久未用的
 * - 空闲回收：进程内所有 session 超时（默认 30min）→ 杀进程，下次自动重建
 * - 消息处理：单一常驻 stdout 监听器 + 按 request id 分发（避免多监听器
 *   重复 append 行缓冲导致 JSON 错乱）
 *
 * 协议要点（本地踩坑沉淀，重写保留）：
 * - spawn `node --import tsx/esm packages/examples/acp-demo/src/bin.ts --config <cordis.yml>`
 * - 必须剥离宿主 DSH_* 环境变量（否则 ACP 会挂到宿主会话存储，SQLite 锁冲突无声卡死）
 * - session/new 的 mcpServers 支持 stdio/http 两种形态（packages/acp/acp/src/mcp.ts），
 *   配置中心勾的 MCP 由此下发；旧注释「必填 mcpServers: []、不接受非空」是旧 acp-demo
 *   入口时代的结论，2026-09-17 已作废
 * - danger-full-access 下 approval=never，不触发 request_permission
 * - DSH 只推提交式输出（agent_message_chunk），无思考流
 * - usage 从 _meta.usage 透传，换算成 prompt/cache_hit/cache_miss 口径落盘
 */

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeProvider, StreamChatParams, StreamEvent, UsageInfo } from './types.js';
import { ensureDshPluginInjected } from '../tools/dsh-inject.js';
import { buildWindowsPath, getEnvPath } from './win-spawn-env.js';

// ── 工具函数 ──

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

function readDeepSeekApiKey(): string {
  const explicit = process.env.CTI_DSH_DEEPSEEK_API_KEY;
  if (explicit) return explicit;
  try {
    const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const txt = fs.readFileSync(cred, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)/);
      if (m) return m[1];
    }
  } catch {}
  return process.env.DEEPSEEK_API_KEY || '';
}

/**
 * [根治 2026-09-15] 从配置中心渲染的 cordis.yml 派生一份 ACP patch。
 *
 * 背景（实测坐实）：官方已废弃「直接 spawn 包 bin + 手写整树 cordis」形态——
 * docs/architecture.md#application-launch 原文 "Only `dsh` profiles launch
 * supported Node apps; package bins, demos, and public SDK argv escapes are
 * forbidden"（scripts/verify-application-entrypoints.ts 静态把关）。旧入口吃的
 * 手写整树缺 dsh-base 的 host-plane 装配行，`session/new` 走到
 * packages/acp/acp/src/session.ts 的 ctx.agents.create() 时会 await 一个永远
 * 无人应答的装配：不抛异常、不进 fail-loud、不退出进程 —— 现象就是飞书卡片停在
 * 第一帧、桥接再无输出，且【重启服务无效】（每条新会话都要走 session/new）。
 * 触发点：早上切模型引发 13:07 重启，把还能干活的老 ACP 进程换掉，脱节当场暴露。
 *
 * 现唯一受支持入口是 `dsh --profile acp`（树由 bundle 完整装配），外部只能用
 * `--patch` 覆盖/追加。这里刻意不碰 render.ts —— cordis.yml 仍是配置中心切模型
 * 的单一产物，我们只从它派生 patch：
 *   ① 用 acp-agent 段的 provider/model 覆盖宿主行 `id: acp`（切模型继续生效）
 *   ② 原样追加 MCP clients / 桥接自带插件 cti-builtin-tools / 技能目录（能力不减）
 * 幂等：内容未变不落盘。任何异常返回 null（退化为只带 --profile acp，仍比旧入口强）。
 */
/**
 * [根治 A①] 轻量解析 settings.yaml 的 `llm-pi-ai.providers.<name>.models[].id|name`。
 * 刻意不引 yaml 依赖：cordis 系文件带 `!!js` 自定义标签，通用解析器在这类文件上会炸，
 * 而 settings.yaml 是本机手维护的固定缩进风格（providers 缩进 2 / provider 名缩进 4 /
 * models 缩进 6 / 列表项缩进 8），逐行扫一次即可，零依赖零副作用。
 */
function parseSettingsProviders(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let inProviders = false;
  let cur = '';
  let inModels = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const ind = raw.match(/^\s*/)?.[0].length ?? 0;
    const key = /^\s*("?[\w.\-]+"?)\s*:\s*(.*)$/.exec(raw);
    const name = key?.[1]?.replace(/^"|"$/g, '') ?? '';
    if (ind <= 0) { inProviders = false; cur = ''; inModels = false; continue; }
    if (ind === 2 && key) { inProviders = name === 'providers'; cur = ''; inModels = false; continue; }
    if (!inProviders) continue;
    if (ind === 4 && key) { cur = name; out[cur] = out[cur] ?? []; inModels = false; continue; }
    if (ind === 6 && key) { inModels = name === 'models'; continue; }
    if (ind >= 8 && inModels && cur) {
      const m = /(?:^|[\s,\[])-\s*(?:id|name)\s*:\s*([\w.\-]+)/.exec(raw);
      if (m?.[1]) out[cur]?.push(m[1]);
      const inline = /^\s*(?:id|name)\s*:\s*([\w.\-]+)/.exec(raw);
      if (inline?.[1]) out[cur]?.push(inline[1]);
    }
  }
  return out;
}

/**
 * [根治 A①] 校验 provider/model 确实在 DSH 全局 settings.yaml 注册过。
 * 为什么必须提前拦：`--profile acp` 的模型 catalog 来自 settings.yaml，选了没注册的
 * 组合时，会话创建会掉进 harness 的悬空 await ——【既不报错也不响应】，就是今早那次
 * "卡片停在第一帧、重启服务也没用"的放大器。宁可在这里响亮地拒绝。
 */
function checkAcpModelSelection(provider: string, model: string): string | null {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const settingsPath = path.join(home, 'settings.yaml');
  if (!fs.existsSync(settingsPath)) return null; // 文件不存在＝不是这套部署形态，不拦
  let text = '';
  try { text = fs.readFileSync(settingsPath, 'utf8'); } catch { return null; }
  const provs = parseSettingsProviders(text);
  const names = Object.keys(provs);
  if (!names.length) return null; // 读不出结构就放行，避免误伤
  if (!(provider in provs)) {
    return `DSH 模型配置校验未通过：provider "${provider}" 不在 ${settingsPath} 的 llm-pi-ai.providers 里`
      + `（本机已注册：${names.join(' / ')}）。这种组合会让会话创建静默挂死，已提前拦下——`
      + `请到配置中心(:13600)改该 bot 的模型，或先在 settings.yaml 里补上该 provider。`;
  }
  const models = provs[provider] ?? [];
  if (models.length && !models.includes(model)) {
    return `DSH 模型配置校验未通过：模型 "${model}" 未挂在 provider "${provider}" 下`
      + `（该 provider 可用：${models.join(' / ')}）。继续启动会掉进会话创建静默挂死，已提前拦下——`
      + `请到配置中心(:13600)重选模型，或在 settings.yaml 的 ${provider}.models 里补上 "${model}"。`;
  }
  return null;
}

/**
 * 桥接自有插件在磁盘上的绝对入口（<DSH_HOME>/<bot>-bot/node_modules/<pkg>/lib/index.js）。
 * 为什么不能写裸包名：`--profile acp` 的 ESM 解析锚点是 profile 目录，而插件是部署到
 * `<bot>-bot/node_modules` 的（dsh-inject.ts 的部署约定），两者不互为祖先目录。
 * @param pkg - 包名，如 'cti-builtin-tools'。
 * @returns 绝对入口路径；文件不存在时返回 null（调用方保持原样，交由 Loader 报错）。
 */
function localPluginEntry(pkg: string): string | null {
  try {
    const acpConfig = process.env.CTI_DSH_ACP_CONFIG || '';
    const m = acpConfig.match(/\\(\w+)-bot\\cordis\.yml$/i) || acpConfig.match(/\/(\w+)-bot\/cordis\.yml$/i);
    const botDir = m?.[1] ? `${m[1]}-bot` : 'dsh-bot';
    const home = process.env.DSH_HOME || path.join(process.env.CTI_USER_HOME || os.homedir(), '.dsh');
    const entry = path.join(home, botDir, 'node_modules', pkg, 'lib', 'index.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function ensureAcpPatch(cordisPath: string, log?: (m: string) => void): { patchPath: string; err: string | null } | null {
  try {
    if (!fs.existsSync(cordisPath)) return null;
    const lines = fs.readFileSync(cordisPath, 'utf8').split(/\r?\n/);
    // 按顶层 "- id:" 切段（段文本含其后直到下一个 "- id:" 的全部行）
    const segs: Array<{ id: string; text: string }> = [];
    let cur: { id: string; buf: string[] } | null = null;
    for (const ln of lines) {
      const m = /^- id:\s*(\S+)/.exec(ln);
      if (m) {
        if (cur) segs.push({ id: cur.id, text: cur.buf.join('\n') });
        cur = { id: m[1] as string, buf: [ln] };
        continue;
      }
      if (cur) cur.buf.push(ln);
    }
    if (cur) segs.push({ id: cur.id, text: cur.buf.join('\n') });

    const segName = (s: { text: string }): string => {
      const m = /name:\s*'?([^'\n]+)'?/.exec(s.text);
      return m && m[1] ? m[1].trim() : '';
    };
    const agentSeg = segs.find((s) => s.id === 'acp-agent');
    const provider = agentSeg ? /^\s+provider:\s*(\S+)/m.exec(agentSeg.text)?.[1] : undefined;
    const model = agentSeg ? /^\s+model:\s*(\S+)/m.exec(agentSeg.text)?.[1] : undefined;

    let out = '# Generated by agents-to-feishu DshProvider from cordis.yml — DO NOT EDIT BY HAND.\n';
    out += '# 换模型请在配置中心(:13600)保存，本文件随之重新派生。\n';
    out += '- id: acp\n  config:\n';
    out += `    provider: ${provider ?? 'deepseek-official'}\n    model: ${model ?? 'deepseek-v4-flash'}\n`;

    // [根治 2026-09-17 · dsh bot 手上没有 openmem / 桥接内置工具]
    // patch 语义（packages/boot/app-boot/src/index.ts 的 parsePatchList + cordis include）：
    //   顶层条目 = 【改一个已存在的行】（id 定向覆盖）；目标 id 不存在时只留一条 Loader
    //   警告然后【静默丢弃】。要【新增】行必须放进 `- insert:` 列表。
    // 旧代码把 cti-builtin-tools / mcp-* 平铺在顶层，而这两个 id 在引擎树里都不存在
    // （acp profile = dsh-base + dsh-acp-app），于是被整批丢掉：dsh bot 因此既没有
    // openmem 工具，也没有桥接自带的 look_image / send_voice / send_image。
    // 引擎树里已存在的 id（只能当覆盖用）：acp（dsh-acp-app）、skill-filesystem（dsh-base）。
    // MCP client 实例【不再由 patch 承载】—— 改走 ACP session/new 的 mcpServers
    // （createSession），否则同一 serverName 会在全局与 Agent 两处各挂一次、工具重名。
    const overridable = new Set(['skill-filesystem']);
    const inserts: string[] = [];
    let kept = 0;
    for (const s of segs) {
      const plugin = segName(s);
      if (plugin === '@deepseek-ai/dsh-mcp-client') continue; // 由 session/new 承载
      if (plugin !== 'cti-builtin-tools' && plugin !== '@deepseek-ai/dsh-skill-filesystem') continue;
      kept++;
      const text = s.text.replace(/\s+$/, '');
      if (overridable.has(s.id)) out += '\n' + text + '\n';
      else inserts.push(text);
    }
    if (inserts.length) {
      // 桥接自有插件必须写绝对入口：`--profile acp` 的 ESM 解析锚点是 profile 目录
      // （~/.dsh/profiles/acp），不是 dsh-bot/node_modules，裸名 'cti-builtin-tools' 解析不到。
      // 绝对路径会被 Loader 的 anchorInsertedPluginNames 转成 file URL。
      const entry = localPluginEntry('cti-builtin-tools');
      out += '\n- insert:\n';
      for (const text of inserts) {
        const fixed = entry
          ? text.replace(/^(\s*name:\s*)'?cti-builtin-tools'?\s*$/m, (_m, p1: string) => `${p1}'${entry}'`)
          : text;
        out += fixed.split('\n').map((l) => '    ' + l).join('\n') + '\n';
      }
    }

    const patchPath = path.join(path.dirname(cordisPath), 'acp.patch.yml');
    const prev = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
    if (prev !== out) fs.writeFileSync(patchPath, out, 'utf8');
    log?.(`[dsh] ACP patch: provider=${provider ?? '-'} model=${model ?? '-'} keptPlugins=${kept}`);
    // 派生完成后再判定"能不能拿去启动"：不合法就带着人话错误返回，
    // 由 resolveDshCommand 响亮抛出（不在这里 throw，避免被下面的 catch 吞成 null）
    const err = checkAcpModelSelection(provider ?? 'deepseek-official', model ?? 'deepseek-v4-flash');
    return { patchPath, err };
  } catch {
    return null;
  }
}

/** 解析 DSH ACP 服务器启动命令（官方唯一受支持形态：`dsh --profile acp` + `--patch`，详见 ensureAcpPatch） */
function resolveDshCommand(): { command: string; args: string[]; cwd: string } {
  const harness = process.env.CTI_DSH_HARNESS_PATH || 'C:\\D\\opt\\deepseek-harness\\deepseek-harness';
  const config = process.env.CTI_DSH_ACP_CONFIG || path.join(os.homedir(), '.dsh', 'dsh-bot', 'cordis.yml');
  const args = fs.existsSync(path.join(harness, 'apps', 'cli', 'lib', 'bin.js'))
    ? ['apps/cli/lib/bin.js', '--profile', 'acp']
    : ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp'];
  const res = ensureAcpPatch(config, rtLog);
  // [根治 A①] 配置不合法就响亮抛错，绝不带着"必然挂死"的组合去 spawn。
  // 以前是照常启动 → 会话创建静默僵死 → 你在飞书端什么也看不到。
  if (res?.err) throw new Error(res.err);
  if (res) args.push('--patch', res.patchPath);
  return { command: process.execPath, args, cwd: harness };
}

/** 剥离 DSH_* 环境变量 + 补全 Windows 必需系统变量（NSSM 环境残缺） */
function buildSpawnEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue;
    clean[key] = value;
  }
  if (process.platform !== 'win32') return { ...clean, ...extra };
  const parentPath = (getEnvPath(clean) || '').split(';').filter(Boolean);
  return {
    ...clean,
    ...extra,
    ComSpec: clean.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe',
    SystemRoot: clean.SystemRoot || 'C:\\WINDOWS',
    PATH: buildWindowsPath(getEnvPath(clean)),
  };
}

/** DSH usage 落盘：stats/YYYY-MM-DD.jsonl（对齐 reasonix 口径；目录按 bot 的 ACP config 决定） */
function recordUsage(usage: UsageInfo): void {
  try {
    const input = Number(usage.inputTokens ?? 0);
    const cacheRead = Number(usage.cacheReadTokens ?? 0);
    const hit = cacheRead;
    const miss = input;
    if (hit + miss <= 0) return;
    // 目录规则：跟随 ACP config（~/.dsh/<bot>/cordis.yml → ~/.dsh/<bot>/stats）
    // 由 CTI_DSH_ACP_CONFIG 决定，而不是写死 dsh-bot。
    let botStatsDir: string | null = null;
    const acpConfig = process.env.CTI_DSH_ACP_CONFIG || '';
    const m = acpConfig.match(/\\(\w+)-bot\\(cordis\.yml)$/i) || acpConfig.match(/\/(\w+)-bot\/(cordis\.yml)$/i);
    if (m) {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      botStatsDir = path.join(home, `${m[1]}-bot`, 'stats');
    } else {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      botStatsDir = path.join(home, 'dsh-bot', 'stats'); // 兜底
    }
    fs.mkdirSync(botStatsDir, { recursive: true });
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const file = path.join(botStatsDir, `${localDate}.jsonl`);
    const rec = {
      ts: now.toISOString(),
      model: process.env.CTI_BOT_DSH_MODEL_GROUP || 'deepseek-v4-flash',
      source: 'cli',
      prompt: input + cacheRead,
      completion: Number(usage.outputTokens ?? 0),
      reasoning: Number(usage.reasoningTokens ?? 0),
      cache_hit: hit,
      cache_miss: miss,
      total: input + cacheRead + Number(usage.outputTokens ?? 0),
      requests: 1,
    };
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf-8');
  } catch {}
}

// ── ACP 会话（进程内的一个 session）──

interface AcpSession {
  sessionId: string;
  cwd: string;
  lastUsed: number;
  personaInjected: boolean;
}

/** 活跃 prompt 的流式事件处理器 */
interface ActivePrompt {
  promptId: number;
  /** 当前 ACP session id（interrupt 用 session/cancel 需要真实 sessionId） */
  sessionId: string;
  onUpdate: (msg: any) => void;
  onDone: (err?: string) => void;
}

// ── DshProvider ──

export class DshProvider implements RuntimeProvider {
  readonly name = 'dsh';

  /** 单 ACP 进程（惰性 spawn，空闲回收） */
  private child: ChildProcess | null = null;
  /** 行缓冲：只被唯一常驻监听器读写 */
  private lineBuf = '';
  /** 下一可用 request id */
  private nextId = 100;
  /** 按 request id 等待的响应 resolver */
  private pending = new Map<number, (msg: any) => void>();
  /** 当前活跃 prompt（流式事件分发目标） */
  private activePrompt: ActivePrompt | null = null;
  /** 当前 streamChat 流的结束 promise（interrupt 等待它，确保 turn 完全结束后再放行下一条） */
  private currentStreamEnd: Promise<void> | null = null;
  /** 被 interrupt 取消过的 sessionId：下一条消息必须开新 session（cancel 后旧 turn 未释放，复用会 turn/start 冲突） */
  private interruptedSessionIds = new Set<string>();
  /** 09-20 老大令：弹卡要报原因——idle/interrupt/restart 属正常换代温和提醒，判不了才按异常告警 */
  private lostReasons = new Map<string, 'idle' | 'interrupt' | 'restart'>();
  /** 🔴 09-20 老大令「不主动 /new 就不许断」：会话档案号落盘，进程死亡后首条先向引擎
   *  session/resume 赎回（DSH ACP 声明 sessionCapabilities.resume，对话本就持久化在盘）。
   *  赎回成功=记忆原样、不弹卡；失败才走老路新建+弹卡。文件形态对齐 WB 家。 */
  private savedSids = new Map<string, string>();
  private sidFile(): string {
    return path.join(process.env.CTI_USER_HOME || os.homedir(), '.agents-to-feishu', 'runtime', 'sessions-dsh-acp.json');
  }
  private loadSids(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sidFile(), 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) this.savedSids.set(k, v);
      rtLog(`[dsh] 载入 ${this.savedSids.size} 条会话档案号（复活可赎回）`);
    } catch { /* 首跑无档案 */ }
  }
  private saveSids(): void {
    try {
      fs.mkdirSync(path.dirname(this.sidFile()), { recursive: true });
      fs.writeFileSync(this.sidFile(), JSON.stringify(Object.fromEntries(this.savedSids)), 'utf8');
    } catch { /* 落盘失败不拦主流程 */ }
  }
  /** 向引擎要回旧会话。引擎侧档案缺失/cwd 不符/方法不支持都会报错，由调用方兜底新建。 */
  private async resumeSession(sid: string, cwd: string): Promise<void> {
    const child = await this.ensureProcess();
    const id = this.nextId++;
    this.sendRequest(child, {
      jsonrpc: '2.0', id, method: 'session/resume',
      params: { sessionId: sid, cwd, mcpServers: this.acpMcpServers() },
    });
    const msg = await this.waitResponse(id, 60_000);
    if (!msg?.result) throw new Error(msg?.error?.message ? String(msg.error.message) : 'no result');
  }
  /** 会话注册表：sessionKey（桥接层 id）→ ACP session（同一进程内） */
  private sessions = new Map<string, AcpSession>();
  /** 进程 spawn 等待队列（initialize 未完成时排队的请求） */
  private spawnPromise: Promise<ChildProcess> | null = null;

  private static IDLE_TIMEOUT_MS = parseInt(process.env.CTI_DSH_IDLE_TIMEOUT_MS || '0', 10); // 🔴 09-20 老大令：默认永不回收——不主动 /new 会话必须连续（30min/12h 均为历史中间态，作废；env 可覆盖）
  /** 进程内最大会话数（超出按 LRU 淘汰最久未用的） */
  private static MAX_SESSIONS = parseInt(process.env.CTI_DSH_MAX_SESSIONS || '20', 10);
  private static PROMPT_TIMEOUT_MS = parseInt(process.env.CTI_DSH_TIMEOUT_MS || '300000', 10); // 5min 无输出判卡死
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.loadSids();
    // Phase 1（2026-08-29 方向定调）：bot 启动即确保内置工具插件就位（幂等，零配置、不走 HTTP）
    ensureDshPluginInjected((m) => rtLog(m));
  }

  async prepare(): Promise<void> {
    // [根治 2026-09-15 · 修我自己引入的回归] 下面三处 throw（含新增的模型校验）原本
    // 都不在任何 try 里：未捕获异常直接把 bot 进程带崩 → nssm 重启循环 → SERVICE_PAUSED。
    // 假模型故障注入实测复现：注入后 status=SERVICE_PAUSED —— 比"静默挂死"还糟。
    // 铁律：启动期的配置问题只能「记日志 + 放弃预启动 + 服务继续活着」，
    // 可读错误留给消息路径回给用户（那条链上有 yield error → 飞书补发文本）。
    try {
      const { cwd } = resolveDshCommand();
      const config = process.env.CTI_DSH_ACP_CONFIG || path.join(os.homedir(), '.dsh', 'dsh-bot', 'cordis.yml');
      if (!fs.existsSync(config)) throw new Error(`DSH ACP config not found: ${config}`);
      // [2026-09-15] 入口已从 packages/examples/acp-demo 的遗留 bin 换成官方 `--profile acp`，
      // 存在性检查跟着改：apps/cli 的构建产物 bin.js 或源码 bin.ts 二者有其一即可。
      const cliReady = ['apps/cli/lib/bin.js', 'apps/cli/src/bin.ts'].some((p) => fs.existsSync(path.join(cwd, p)));
      if (!cliReady) {
        throw new Error(`DSH harness not found at: ${cwd} (set CTI_DSH_HARNESS_PATH)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rtLog(`[dsh] prepare 放弃预启动（服务保持存活，消息到来时会重试并把错误回给用户）: ${msg}`);
      console.warn(`[dsh] prepare aborted, service stays alive:`, msg);
      return;
    }
    // ⚠️ 常驻模式（2026-08-25）：服务启动即预启动 ACP 进程并完成 initialize/MCP 初始化，
    // 而不是等第一条消息才惰性 spawn（那是"一次性调用"体验，首条消息要冷启动 4-5 秒）。
    // 进程常驻后，消息来了直接复用，秒回（只等模型首字，不再等 ACP 冷启动）。
    try {
      await this.ensureProcess();
      rtLog(`[dsh] prepare: ACP pre-spawned & initialized (常驻模式)`);
    } catch (e) {
      // 预启动失败不阻塞启动（消息来时仍会惰性重试），但记日志便于排查
      console.warn(`[dsh] prepare pre-spawn ACP failed:`, e);
    }
  }

  /**
   * /new：清掉该 key 的旧会话绑定，下一条消息在进程内开新 session（不杀进程）。
   */
  async resetSession(sessionKey?: string): Promise<void> {
    if (sessionKey) {
      // 用户显式 /new：档案号一并作废（下条不赎回，新建后写新号）
      this.sessions.delete(sessionKey);
      this.savedSids.delete(sessionKey);
      this.saveSids();
      rtLog(`[dsh] resetSession key=${sessionKey.slice(0, 8)}`);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activePrompt || !this.child) return;
    // session/cancel 必须传真实 sessionId（空字符串 ACP 找不到会话 → 插队无效）
    try {
      this.child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', method: 'session/cancel',
        params: { sessionId: this.activePrompt.sessionId },
      }) + '\n');
      rtLog(`[dsh] interrupt session=${this.activePrompt.sessionId.slice(0, 8)}`);
    } catch {}
    // 标记该 session 已中断：下一条必须开新 session（cancel 后旧 turn 不释放，复用会 turn/start 冲突）
    this.interruptedSessionIds.add(this.activePrompt.sessionId);
    // ⚠️ cancel 是异步的：harness 标记取消后还要等当前 turn quiesce 才真正结束。
    // 若不等待，下一条 prompt 会在 turn 1 未结束时发出 → "turn/start 2 while turn 1 is still open"。
    // 所以 interrupt() 必须阻塞到当前 streamChat 的流彻底结束（settled）再返回。
    if (this.currentStreamEnd) {
      await this.currentStreamEnd;
      rtLog(`[dsh] interrupt: current turn fully ended`);
    }
  }

  async dispose(): Promise<void> {
    this.killProcess();
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  /** 会话回收：清理超时未用的 session 绑定，但【进程常驻不杀】（常驻模式 2026-08-25） */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, s] of this.sessions) {
        if (DshProvider.IDLE_TIMEOUT_MS > 0 && now - s.lastUsed > DshProvider.IDLE_TIMEOUT_MS) {
          this.lostReasons.set(key, 'idle');
          this.sessions.delete(key);
          rtLog(`[dsh] idle cleanup session ${s.sessionId.slice(0, 8)}`);
        }
      }
      // ⚠️ 不再杀进程：进程常驻，等用户随时发消息秒回（对齐 CLI 长连接体验）。
      // 进程异常退出由 ensureProcess 惰性重建兜底。
    }, 60_000);
  }

  private killProcess(): void {
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch {}
    }
    this.child = null;
    this.spawnPromise = null;
    for (const k of this.sessions.keys()) this.lostReasons.set(k, 'restart');
    this.sessions.clear();
    this.pending.clear();
    this.activePrompt = null;
    this.lineBuf = '';
  }

  /** 唯一常驻 stdout 监听器：按 id 分发响应，流式事件给 activePrompt */
  private onStdout(chunk: Buffer): void {
    this.lineBuf += chunk.toString();
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop() || '';
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) continue;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const id = msg.id as number | undefined;
      const isResponse = !msg.method && (msg.result !== undefined || msg.error);

      // 1) 请求-响应：匹配 pending
      if (isResponse && id != null && this.pending.has(id)) {
        const resolve = this.pending.get(id)!;
        this.pending.delete(id);
        resolve(msg);
        continue;
      }

      // 2) 服务端通知（session/update / request_permission）
      if (msg.method === 'session/update') {
        this.activePrompt?.onUpdate(msg);
        continue;
      }
      if (msg.method === 'session/request_permission') {
        // danger-full-access 下不应触发，防御性自动批准
        const options = msg.params?.options as Array<{ optionId: string }> | undefined;
        const allow = options?.find((o) => /allow/i.test(o.optionId))?.optionId || options?.[0]?.optionId || 'allow-once';
        try {
          this.child?.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: allow } },
          }) + '\n');
        } catch {}
        continue;
      }
    }
  }

  /** 确保 ACP 进程存在（惰性 spawn，仅挂一次 stdout 监听器） */
  private ensureProcess(): Promise<ChildProcess> {
    if (this.child && !this.child.killed) return Promise.resolve(this.child);
    if (this.spawnPromise) return this.spawnPromise;

    let rejectSpawn: (e: Error) => void = () => {};
    this.spawnPromise = new Promise<ChildProcess>((resolve, reject) => {
      rejectSpawn = reject;
      // [根治 A③] resolveDshCommand 会做配置校验并可能抛错。这里必须兜住并【清掉
      // spawnPromise】：否则 this.spawnPromise 永远停在这个已失败的 promise 上
      // （第 450 行直接 return 它）⇒ 之后每条消息都秒失败、永不重试 = bot 永久失忆，
      // 正是今早那次故障被放大成"完全不可用"的机制。
      let plan: { command: string; args: string[]; cwd: string };
      try {
        plan = resolveDshCommand();
      } catch (e) {
        this.spawnPromise = null;
        const msg = e instanceof Error ? e.message : String(e);
        rtLog(`[dsh] spawn plan FAILED (已清除 spawnPromise，下条消息会重试): ${msg}`);
        reject(e instanceof Error ? e : new Error(msg));
        return;
      }
      const { command, args } = plan;
      const harnessCwd = plan.cwd;
      const env = buildSpawnEnv({
        DEEPSEEK_API_KEY: readDeepSeekApiKey(),
        DSH_PERMISSION_MODE: 'danger-full-access',
        // 2026-08-29 修复：插件（cti-builtin-tools）按 DSH_HOME 定位 voice-config.json/素材。
        // 不设则 homedir() 在 LocalSystem 下指向 systemprofile ⇒ 配置漂移——看图回落
        // "本地 ollama qwen3-vl" 默认（弱模型误描述=看错图 / 后端缺模型=找不到图片）。
        // harness 的 BOOTSTRAP_PREFIXES 只禁 .env 文件带 DSH_*，父进程 spawn 注入是受信通道。
        DSH_HOME: path.join(process.env.CTI_USER_HOME || 'C:\\Users\\oadan', '.dsh'),
      });
      const child = spawn(command, args, {
        cwd: harnessCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
      rtLog(`[dsh] ACP spawned pid=${child.pid}`);

      child.stderr.on('data', (c: Buffer) => rtLog(`[dsh] ACP stderr: ${c.toString().trim().slice(0, 300)}`));
      child.on('error', (err) => {
        rtLog(`[dsh] SPAWN ERROR: ${err.message}`);
        if (this.child === child) {
          this.child = null;
          this.spawnPromise = null;
        }
        reject(err);
      });
      child.on('close', (code) => {
        rtLog(`[dsh] ACP exited code=${code}`);
        if (this.child === child) {
          this.child = null;
          this.spawnPromise = null;
          for (const k of this.sessions.keys()) this.lostReasons.set(k, 'restart');
          this.sessions.clear();
          this.pending.clear();
          this.activePrompt = null;
          this.lineBuf = '';
        } else if (this.spawnPromise) {
          // 2026-09-01 修复（同 openclaw）：初始化完成前进程退出时清悬挂 spawnPromise
          this.spawnPromise = null;
          rejectSpawn(new Error(`DSH ACP exited during init (code=${code})`));
        }
      });

      // 唯一常驻 stdout 监听器
      child.stdout!.on('data', (c: Buffer) => this.onStdout(c));

      // initialize 握手（走统一 pending 机制）
      const initId = this.nextId++;
      this.sendRequest(child, { jsonrpc: '2.0', id: initId, method: 'initialize', params: {
        protocolVersion: 1, capabilities: {},
        clientInfo: { name: 'agents-to-feishu', version: '0.1.0' },
      }});

      // tsx 首次编译给足 120s
      const timeout = setTimeout(() => {
        if (!this.child) {
          try { child.kill('SIGTERM'); } catch {}
          reject(new Error('DSH ACP initialize timeout'));
        }
      }, 120_000);

      // 等 initialize 响应（保留 60s 兜底，initialize 不应长期挂起）
      this.waitResponse(initId, 60_000).then(
        (msg) => {
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error('DSH ACP initialize failed'));
            return;
          }
          rtLog(`[dsh] ACP initialized`);
          this.child = child;
          resolve(child);
        },
        (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      );
    });

    return this.spawnPromise;
  }

  /** 发请求并返回 promise（等统一监听器分发响应） */
  private sendRequest(child: ChildProcess, msg: unknown): void {
    child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  private waitResponse(id: number, timeoutMs?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      // 兜底超时：默认不超时（长任务可能很久，如访问外部 gateway / 长文本生成）。
      // 仅 initialize / session/new 等必须快速返回的请求显式传 timeoutMs。
      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`ACP request ${id} timeout`));
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * 配置中心勾选的 MCP 池 → ACP `session/new` 的 mcpServers（形态见引擎
   * packages/acp/acp/src/mcp.ts：stdio = {name,command,args,env[{name,value}]}，
   * http = {name,type:'http',url,headers[]}）。
   *
   * name 用配置 id（openmem / win-desktop-helper）而不是 displayName：ACP 会把不合规的
   * 名字 slug 化加哈希尾巴，工具名就不再是 `mcp__openmem__mh_tool` 了。
   * @returns ACP 形态的 MCP 声明；没勾选/JSON 坏了返回空数组（照常建会话）。
   */
  private acpMcpServers(): Array<Record<string, unknown>> {
    const botId = (process.env.CTI_BOT || 'dsh').toUpperCase();
    const raw = process.env[`CTI_BOT_${botId}_MCP_SERVERS`] || '';
    if (!raw.trim()) return [];
    let defs: Array<{ id: string; transport?: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }>;
    try {
      defs = JSON.parse(raw);
    } catch {
      rtLog('[dsh] CTI_BOT_*_MCP_SERVERS JSON 解析失败，本次会话不挂 MCP');
      return [];
    }
    const out: Array<Record<string, unknown>> = [];
    for (const d of defs) {
      if (!d?.id) continue;
      if (d.transport === 'stdio' && d.command) {
        out.push({
          name: d.id,
          command: d.command,
          args: d.args || [],
          env: Object.entries(d.env || {}).map(([name, value]) => ({ name, value })),
        });
      } else if (d.url) {
        out.push({ name: d.id, type: 'http', url: d.url, headers: [] });
      }
    }
    rtLog(`[dsh] session/new 将挂 MCP ${out.length} 个: ${out.map((m) => String(m.name)).join(', ') || '(无)'}`);
    return out;
  }

  /** 在现有进程里开一个新 ACP session */
  private async createSession(cwd: string): Promise<AcpSession> {
    const child = await this.ensureProcess();
    // [根治 2026-09-17] MCP 由 session/new 下发（旧代码写死 []，且 patch 那条路是坏的 ⇒
    // bot 手上没有 openmem / 桌面助手 / 桥接内置工具）。ACP 侧强制 failOnStartupError=true，
    // 所以某个 MCP 起不来会让建会话失败 —— 这里退回「不挂 MCP」重试一次，宁可本次会话少工具，
    // 也不能让 bot 连会话都建不出来（并在 rt 日志里留响亮的证据）。
    const mcpServers = this.acpMcpServers();

    let msg: any;
    // [2026-09-18 根治「一个 MCP 起不来，全批陪葬」] 旧逻辑是失败即退回「一个 MCP 都不挂」，
    // 于是某个无关 MCP 起不来 ⇒ openmem / 飞书工具整批消失（只留一行日志），
    // 现象就是 bot「不会用记忆、不会发图」。改为从尾部逐个剔除可疑项重试：
    // 配置里越靠后的越先被扔（把 openmem 这类命根子排前面），最后才退到「一个都不挂」。
    let activeMcp = mcpServers.slice();
    for (let attempt = 0; ; attempt++) {
      const sessionNewId = this.nextId++;
      this.sendRequest(child, {
        jsonrpc: '2.0', id: sessionNewId, method: 'session/new',
        params: { cwd, mcpServers: activeMcp },
      });

      let failure: string | null = null;
      try {
        msg = await this.waitResponse(sessionNewId, 60_000);
        if (!msg?.result) failure = msg?.error?.message ? String(msg.error.message) : 'no result';
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      if (!failure) {
        if (attempt > 0) {
          rtLog(`[dsh] session/new 最终以 ${activeMcp.length}/${mcpServers.length} 个 MCP 建成功（剔除了起不来的，见上方日志）`);
        }
        break;
      }
      if (activeMcp.length > 0) {
        const dropped = activeMcp[activeMcp.length - 1] as Record<string, unknown>;
        activeMcp = activeMcp.slice(0, -1);
        rtLog(`[dsh] session/new 失败（${failure}）→ 剔除 MCP "${String(dropped.name)}" 重试，剩余 ${activeMcp.length} 个`);
        continue;
      }
      // [根治 A②③] 会话创建超时/失败 = 该进程已进入不可信状态：配置树装配缺行时
      // harness 侧是永久悬空 await（既不报错也不退出），而旧代码只把错误 yield 出去，
      // 下一条消息还在同一个僵尸进程上重试 → 再挂 60 秒，永远好不了（今早「重启也没用」
      // 之后其实就是这个循环）。现在：留痕 + 销毁进程 + 清 spawnPromise，下条消息全新
      // spawn；若配置仍不合法，会在 spawn 阶段被 A① 校验拦成一句人话错误。
      rtLog(`[dsh] session/new FAILED (${failure}) → 销毁 ACP 进程并清空 spawnPromise，下条消息重建`);
      this.killProcess();
      this.spawnPromise = null;
      throw new Error(`DSH 会话创建失败（${failure}）：已销毁可疑进程，下一条消息会自动重建引擎。`);
    }
    if (!msg.result) throw new Error('DSH ACP session/new failed');

    const sessionId = (msg.result as Record<string, unknown>).sessionId as string | undefined;
    if (!sessionId) throw new Error('DSH ACP session/new: missing sessionId');

    rtLog(`[dsh] session/new OK: ${sessionId.slice(0, 8)}`);
    this.pruneOldSessions();
    return { sessionId, cwd, lastUsed: Date.now(), personaInjected: false };
  }

  /**
   * 自动清理旧会话记录：保留最近 N 个 session 目录（按修改时间），更早的删除。
   * 对齐"新建聊天记录，旧记录备份保留 N 条"的语义。N 由 CTI_DSH_SESSION_KEEP 控制（默认 10）。
   */
  private pruneOldSessions(): void {
    try {
      const keep = parseInt(process.env.CTI_DSH_SESSION_KEEP || '10', 10);
      if (keep < 1) return;
      // 会话记录根目录：<DSH_HOME>/<bot>-bot/sessions/<cwd编码>/
      const acpConfig = process.env.CTI_DSH_ACP_CONFIG || '';
      const m = acpConfig.match(/\\(\w+)-bot\\(cordis\.yml)$/i) || acpConfig.match(/\/(\w+)-bot\/(cordis\.yml)$/i);
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const botSessionsRoot = m
        ? path.join(home, `${m[1]}-bot`, 'sessions')
        : path.join(home, 'dsh-bot', 'sessions');
      if (!fs.existsSync(botSessionsRoot)) return;
      const cwdDir = '--C-D-opt--';
      const dir = path.join(botSessionsRoot, cwdDir);
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); // 最新在前
      if (entries.length <= keep) return;
      const toRemove = entries.slice(keep);
      for (const p of toRemove) {
        try {
          // 只清纯 session 记录目录（内含 session.jsonl.zstd），不碰 db 索引
          fs.rmSync(p, { recursive: true, force: true });
          rtLog(`[dsh] pruned old session: ${path.basename(p)}`);
        } catch (e) {
          console.warn(`[dsh] prune session failed ${p}:`, e);
        }
      }
      rtLog(`[dsh] prune done: kept=${keep}, removed=${toRemove.length}`);
    } catch (e) {
      // 清理失败不影响主流程
      console.warn(`[dsh] pruneOldSessions error:`, e);
    }
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    const { sessionKey } = params;
    let session = this.sessions.get(sessionKey);

    // 会话数上限：超出按 LRU 淘汰最久未用的（进程内删绑定，进程不杀）
    if (this.sessions.size >= DshProvider.MAX_SESSIONS && !this.sessions.has(sessionKey)) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastUsed < oldestAt) { oldestAt = s.lastUsed; oldestKey = k; }
      }
      if (oldestKey) {
        this.lostReasons.set(oldestKey, 'idle');
        this.sessions.delete(oldestKey);
        rtLog(`[dsh] LRU evict session ${oldestKey.slice(0, 8)} (cap=${DshProvider.MAX_SESSIONS})`);
      }
    }

    // /new 或首次，或该 session 刚被 interrupt 取消：开新 ACP session（复用进程，不杀）
    // （interrupt 后旧 turn 未释放，复用同一 sessionId 会 turn/start 冲突，必须新建）
    const sessionInterrupted = session ? this.interruptedSessionIds.has(session.sessionId) : false;
    // [2026-09-17] 跨消息失忆修复（对齐 reasonix）：history 此前仅 sessionInterrupted 注入，
    // 而 session 可能因空闲回收/进程重启/LRU 被清——这些路径新建会话却不带历史 ⇒ 失忆。
    // 现统一为「本轮新建了会话 && bridge 有历史」就注入。/new 时 context 已清空天然空白。
    const isNewSession = !session || params.freshSession || sessionInterrupted;
    let resumedOk = false;
    if (!session || params.freshSession || sessionInterrupted) {
      if (session && sessionInterrupted) {
        this.interruptedSessionIds.delete(session.sessionId);
        this.lostReasons.set(sessionKey, 'interrupt');
        this.sessions.delete(sessionKey);
        rtLog(`[dsh] interrupted session, opening new one for key ${sessionKey.slice(0, 8)}`);
      }
      // [09-20 裁决] freshSession 两个来源分道：user-new=用户主动 /new（档案作废，绝不复活）；
      // restore=桥重启恢复（先向引擎赎回旧会话，成功=记忆原生连续且不喂影子，失败=退回新建+影子注入照旧）。
      const reviveAllowed = !params.freshSession || params.freshReason === 'restore';
      if (params.freshSession && !reviveAllowed) { this.savedSids.delete(sessionKey); this.saveSids(); }
      const savedCwd = process.env.CTI_DEFAULT_WORKDIR || process.cwd();
      const saved = reviveAllowed ? this.savedSids.get(sessionKey) : undefined;
      if (saved) {
        try {
          await this.resumeSession(saved, savedCwd);
          session = { sessionId: saved, cwd: savedCwd, lastUsed: Date.now(), personaInjected: true };
          this.sessions.set(sessionKey, session);
          this.startCleanupTimer();
          resumedOk = true;
          rtLog(`[dsh] session/resume 赎回 ${saved.slice(0, 8)}：记忆原样，不弹卡`);
        } catch (e) {
          rtLog(`[dsh] session/resume 失败(${e instanceof Error ? e.message.slice(0, 140) : e}) → 新建+照常弹卡`);
          this.savedSids.delete(sessionKey); this.saveSids();
        }
      }
      if (!resumedOk) {
        try {
          session = await this.createSession(savedCwd);
          this.sessions.set(sessionKey, session);
          this.savedSids.set(sessionKey, session.sessionId);
          this.saveSids();
          this.startCleanupTimer();
          if (params.freshSession) rtLog(`[dsh] freshSession: new acp session for key ${sessionKey.slice(0, 8)}`);
        } catch (e) {
          yield { type: 'error', message: `DSH ACP 会话创建失败: ${e instanceof Error ? e.message : String(e)}` };
          yield { type: 'done' };
          return;
        }
      }
    }

    // [兜底 2026-09-20] 上面分支逻辑上必产生有效 session，但 try/catch 内的赋值让 TS
    // 无法收窄（TS18048×8）。此守卫运行时不可达，只作类型收窄 + 异常态响亮报错。
    if (!session) {
      yield { type: 'error', message: 'DSH ACP 会话状态异常（未赎回未新建）' };
      yield { type: 'done' };
      return;
    }

    session.lastUsed = Date.now();

    // 首次注入人设
    let fullPrompt = params.text;
    if (!session.personaInjected) {
      fullPrompt = `${params.systemPrompt || ''}\n\n${params.text}`;
      session.personaInjected = true;
    }
    // [2026-09-17] history 注入条件改为 isNewSession（见上方注释）。
    // 🔴 老大令 2026-09-19：非 /new 的丢失性新建 → 自动 /new（回调桥清 shadow 并告知），影子回灌废除
    if (isNewSession && !resumedOk && !params.freshSession && params.history && params.history.length > 0) {
      const lostReason = this.lostReasons.get(sessionKey) ?? (this.sessions.size <= 1 ? 'restart' : 'unknown');
      this.lostReasons.delete(sessionKey);
      rtLog(`[dsh] engine session lost (${lostReason}, shadow ${params.history.length}) → auto /new`);
      params.onSessionLost?.(lostReason as 'idle' | 'interrupt' | 'restart' | 'unknown');
    }
    // 赎回成功=引擎真记忆回来了，禁喂影子（双重上下文会串话）；仅 user-new/新建路径注入。
    const historyText = isNewSession && params.freshSession && !resumedOk && params.history && params.history.length > 0
      ? params.history.map((m) => `[${m.role === 'user' ? '用户' : '助手'}]\n${m.content}`).join('\n\n')
      : '';
    if (historyText) {
      fullPrompt = `${historyText}\n\n---\n\n${fullPrompt}`;
      rtLog(`[dsh] new session: injected ${params.history?.length ?? 0} history turns`);
    }

    const child = this.child!;
    const promptId = this.nextId++;
    const queue: StreamEvent[] = [];
    let settled = false;
    let settleErr: string | null = null;
    let resolveSettled: () => void = () => {};
    const settledP = new Promise<void>((r) => { resolveSettled = r; });
    let lastOutput = Date.now();

    // 设置活跃 prompt 处理器（统一监听器分发 session/update 到这里）
    // [去重修复 2026-08-25 v3] harness ACP 对一条回复会发两类 agent_message_chunk：
    //   ① text-delta 流式增量（多个，不带 _meta）—— 正文的逐段增量
    //   ② assistant/message 提交时整块再发一次（完整文本，带 _meta.usage）—— 等于增量总和
    // v1（字符串去重）在增量/完整块内容不完全一致时失效 → 重复。
    // v2（只信完整块、丢弃增量）解决了重复，但牺牲流式 → 打断时正文为空"（空回复）"。
    // v3 正解：增量照发（保持流式实时），完整块只收 usage 不再发正文（增量总和即完整正文）。
    // 效果：流式实时 + 不重复 + 打断时已发增量保留（不空回复）。
    // [流式唤醒] queue 空时不能傻等 settledP（会阻塞到 turn 结束，push 全攒 → 一次性 yield）。
    // 用 wakeup 信号：onUpdate push 后 poke() 唤醒 while，实时消费每个 delta。
    let wakeup: () => void = () => {};
    let wakeupP: Promise<void> = Promise.resolve();
    const poke = (): void => { wakeup(); };

    // [2026-09-13] 工具名回退修复（同 gemini.ts）：ACP 失败型 `tool_call_update` 不带 title，
    // 旧写法 `String(u.title || 'tool')` 会渲染成字面量 "tool"，卡片上只剩 `❌ tool`。
    // 按 toolCallId 缓存首个 tool_call 的 title 补全，再兜底 ACP kind。
    const toolTitles = new Map<string, string>();
    const KIND_LABEL: Record<string, string> = {
      read: '读文件', edit: '改文件', delete: '删文件', move: '移动文件',
      search: '搜索', execute: '执行命令', think: '思考', fetch: '抓取', other: '工具',
    };
    const promptHandler: ActivePrompt = {
      promptId,
      sessionId: session.sessionId,
      onUpdate: (msg) => {
        lastOutput = Date.now();
        const update = msg.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text') {
          const delta = update.content.text;
          const metaUsage = (update as { _meta?: { usage?: unknown } })._meta?.usage as UsageInfo | undefined;
          if (metaUsage) {
            // [2026-09-11 0.1.5] usage + text 同 chunk：0.1.5 的 agent_message_chunk 自带
            // _meta.usage 且往往就是唯一正文（不再有先行增量），必须发出文本，否则空回复。
            recordUsage(metaUsage);
            queue.push({ type: 'usage', usage: metaUsage, sessionId: session.sessionId });
            if (delta) {
              queue.push({ type: 'text', text: delta });
              poke();
            }
            rtLog(`[dsh] commit chunk len=${delta?.length || 0} (usage + text)`);
          } else if (delta) {
            // text-delta 增量：实时发出（流式）
            queue.push({ type: 'text', text: delta });
            poke();
            rtLog(`[dsh] text-delta len=${delta.length} preview=${delta.slice(0, 40).replace(/\n/g, '\\n')}`);
          }
        } else if (update?.sessionUpdate === 'agent_thought_chunk' && update?.content?.type === 'text') {
          queue.push({ type: 'thinking', text: update.content.text });
          poke();
        } else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
          const u = update as any;
          const status = String(u.status || (update?.sessionUpdate === 'tool_call' ? 'running' : 'done'));
          // [2026-09-13] title 按 toolCallId 缓存补全（失败型 update 不带 title），详见上方注释
          const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : '';
          const incomingTitle = typeof u.title === 'string' && u.title.trim() ? u.title.trim() : '';
          if (toolCallId && incomingTitle) { toolTitles.set(toolCallId, incomingTitle); }
          const toolName = incomingTitle
            || (toolCallId ? toolTitles.get(toolCallId) ?? '' : '')
            || KIND_LABEL[String(u.kind ?? '')]
            || 'tool';
          queue.push({
            type: 'tool',
            tool: toolName,
            status: status === 'failed' ? 'error' : status === 'completed' ? 'done' : 'running',
            input: typeof u.rawInput === 'string' ? u.rawInput.slice(0, 200) : JSON.stringify(u.rawInput ?? '').slice(0, 200),
            // [2026-09-01] 透传工具结果文本（harness ACP 已带 rawOutput ≤2000 字符）；
            // send_voice 的 voiceId 就在里面，桥接靠它读语音对象投递到飞书
            output: typeof u.rawOutput === 'string' ? u.rawOutput.slice(0, 500) : undefined,
          });
          poke();
        }
      },
      onDone: (err?: string) => {
        if (err) settleErr = err;
        settled = true;
        resolveSettled();
      },
    };
    this.activePrompt = promptHandler;

    // 请求-响应：prompt 完成
    this.waitResponse(promptId).then(
      (msg) => {
        if (this.activePrompt === promptHandler) this.activePrompt = null;
        if (msg.error) promptHandler.onDone(msg.error.message || JSON.stringify(msg.error));
        else promptHandler.onDone();
      },
      () => {
        if (this.activePrompt === promptHandler) this.activePrompt = null;
        promptHandler.onDone('ACP prompt 响应超时');
      },
    );

    // 卡死看门狗：连续无输出判定卡死
    const watchdog = setInterval(() => {
      if (settled) { clearInterval(watchdog); return; }
      if (Date.now() - lastOutput > DshProvider.PROMPT_TIMEOUT_MS) {
        clearInterval(watchdog);
        promptHandler.onDone(`DSH ACP 卡死：连续 ${DshProvider.PROMPT_TIMEOUT_MS / 1000}s 无输出，已中断`);
        rtLog(`[dsh] watchdog timeout promptId=${promptId}`);
      }
    }, 30_000);

    this.sendRequest(child, {
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId: session.sessionId, prompt: [{ type: 'text', text: fullPrompt }] },
    });
    rtLog(`[dsh] prompt sent id=${promptId} session=${session.sessionId.slice(0, 8)}`);

    // 记录当前流的结束点：interrupt() 发 session/cancel 后要等它结束（turn 彻底 quiesce）
    // 才能放行下一条 prompt，否则 "turn/start 2 while turn 1 is still open"。
    let resolveStreamEnd: () => void = () => {};
    const streamEndP = new Promise<void>((r) => { resolveStreamEnd = r; });
    this.currentStreamEnd = streamEndP;
    // [流式修复 2026-08-25] queue 空时不能傻等 settledP（会阻塞到 turn 结束才唤醒，
    // 期间 push 的全攒着 → 一次性 yield = "憋一下全出"）。
    // 改为：push 时唤醒，while 只在"无新元素且未结束"时等待，实时消费每个 delta。
    try {
      while (true) {
        if (queue.length > 0) {
          const ev = queue.shift()!;
          yield ev;
          continue;
        }
        if (settled) break;
        // 等"新元素 或 结束"：每次 poke 重建 wakeupP
        wakeupP = new Promise<void>((r) => { wakeup = r; });
        const raceP = Promise.race([settledP, wakeupP]);
        // 若期间有元素入队或已结束，继续循环
        if (queue.length > 0 || settled) continue;
        await raceP;
      }
    } finally {
      clearInterval(watchdog);
      session.lastUsed = Date.now();
      if (settleErr) yield { type: 'error', message: settleErr };
      yield { type: 'done' };
      resolveStreamEnd();
      if (this.currentStreamEnd === streamEndP) this.currentStreamEnd = null;
    }
  }
}

export function createDshProvider(): DshProvider {
  return new DshProvider();
}
