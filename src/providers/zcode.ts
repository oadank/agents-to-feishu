/**
 * ZCode Provider — ZCode Protocol (app-server --stdio) 常驻接入本机 ZCode CLI。
 *
 * 由 agents-to-feishu 统一管理人设/记忆/模型：
 * - 人设：params.systemPrompt（config-store 统一注入 + 独立注入），每会话首条消息注入
 * - 记忆：sessionKey → zcode sessionId 映射 + 落盘（桥接重启后 session/resume 续上下文）
 * - 模型：**配置中心穿透**（2026-09-05 老大要求）——config-store 选的 provider/model 经
 *   render 渲染进 config.<bot>.env，本 provider 读 env 组装 ZCode Protocol 的
 *   `runtimeModel`（provider 注册表 + inline apiKey），在 session/create / session/resume
 *   时下发给 app-server。网页切模型 → apply → 下条消息即生效，不改任何 CLI 配置文件。
 *
 * 协议（实测 zcode 0.16.5，换行分隔 JSON，非 JSON-RPC 2.0）：
 *   session/create {workspace:{workspaceKey,workspacePath}, runtimeModel} → result.session.sessionId
 *   session/resume {sessionId, workspace?, runtimeModel?}                  → 恢复持久会话
 *   session/subscribe {sessionId, deliveryKind:"desktop-continuous"}       → 订阅 session/event
 *   session/send {sessionId, content}                                      → 一轮对话
 *   session/stop {sessionId}                                               → 中断当前轮
 *   session/close {sessionId}                                              → /new 清会话
 * 事件（通知 params = {type, payload, sessionId, seq, ...}）：
 *   part.delta{field:"text"|"reasoning",delta} → 正文/思考增量（思考/工具卡受配置中心开关控制，由 engine 过滤）
 *   tool.updated{kind:scheduled|started|progress|result|error, toolName,...} → 工具卡
 *   turn.completed{response,tokenCount,resultType,...} / turn.failed{error}   → 终态
 * 服务器→客户端请求（必须应答，15s 超时）：
 *   session/requestRuntimePreferences / interaction/requestPermission /
 *   interaction/requestUserInput / interaction/requestOfficialMcpAuthHeaders
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeProvider, StreamChatParams, StreamEvent, UsageInfo } from './types.js';
import { buildWindowsPath } from './win-spawn-env.js';
import { resolveMcpArgPaths } from '../tools/mcp-path-resolve.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

/** 定位 zcode.cjs（ZCode 桌面版内置 CLI）。CTI_ZCODE_CLI 可覆盖。 */
function resolveZcodeCli(): string {
  const custom = process.env.CTI_ZCODE_CLI || '';
  if (custom && fs.existsSync(custom)) return custom;
  const candidates = [
    'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return 'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs';
}

/** 补齐 Windows 必需系统变量（NSSM 环境残缺），对齐 opencode.ts */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue;
    clean[key] = value;
  }
  if (clean.USERPROFILE === undefined || clean.USERPROFILE.includes('systemprofile')) {
    clean.USERPROFILE = process.env.CTI_USER_HOME || os.homedir();
  }
  if (clean.HOME === undefined || clean.HOME.includes('systemprofile')) {
    clean.HOME = clean.USERPROFILE;
  }
  if (process.platform !== 'win32') return clean;
  return {
    ...clean,
    ComSpec: clean.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe',
    SystemRoot: clean.SystemRoot || 'C:\\WINDOWS',
    PATH: buildWindowsPath(clean.PATH),
  };
}

// ── 配置中心穿透：config.<bot>.env → env → runtimeModel / mcpServers ──

/** 配置中心 MCP 池条目（render 写进 CTI_BOT_<ID>_MCP_SERVERS 的 JSON） */
interface CtiMcpDef { id: string; displayName?: string; transport?: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }

/** 读配置中心勾选的 MCP 池，映射为 ZCode Protocol 的 mcpServers（stdio / http 两种形态） */
function buildMcpServers(): Array<Record<string, unknown>> | null {
  const botId = (process.env.CTI_BOT || 'zcode').toUpperCase();
  const raw = process.env[`CTI_BOT_${botId}_MCP_SERVERS`] || '';
  if (!raw.trim()) return null;
  let defs: CtiMcpDef[];
  try { defs = JSON.parse(raw); } catch { rtLog('[zcode] MCP_SERVERS JSON 解析失败，忽略'); return null; }
  const out: Array<Record<string, unknown>> = [];
  for (const d of defs) {
    if (d.transport === 'stdio' && d.command) {
      out.push({
        name: d.displayName || d.id,
        command: d.command,
        args: resolveMcpArgPaths(d.id, d.args || []),
        env: Object.entries(d.env || {}).map(([name, value]) => ({ name, value })),
      });
    } else if (d.url) {
      // streamable-http / sse → 协议的 http / sse
      out.push({
        name: d.displayName || d.id,
        type: d.transport === 'sse' ? 'sse' : 'http',
        url: d.url,
        headers: [] as Array<{ name: string; value: string }>,
      });
    }
  }
  rtLog(`[zcode] mcpServers 配置中心穿透 ${out.length} 个: ${out.map((m) => m.name).join(', ')}`);
  return out.length > 0 ? out : null;
}

/** 组装 runtimeModel（ZCode Protocol $f：客户端下发的模型注册表）。缺配置返回 null。 */
function buildRuntimeModel(): Record<string, unknown> | null {
  const botId = (process.env.CTI_BOT || 'zcode').toUpperCase();
  const p = `CTI_BOT_${botId}_`;
  const modelId = process.env[`${p}MODEL`] || '';
  if (!modelId) return null;
  // openai-compatible 走 chat completions：baseURL 缺 /v1 时补齐（LiteLLM baseURL 常不带）
  let baseURL = (process.env[`${p}BASE_URL`] || process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
  if (baseURL && !/\/v\d+$/.test(baseURL)) baseURL += '/v1';
  const apiKey = process.env[`${p}API_KEY`] || process.env.OPENAI_API_KEY || '';
  if (!baseURL || !apiKey) {
    rtLog(`[zcode] runtimeModel 配置不全：baseURL="${baseURL}" apiKey=${apiKey ? '有' : '无'}（配置中心检查 provider/baseURL/key）`);
    if (!baseURL) return null;
  }
  const contextWindow = Number(process.env[`${p}CONTEXT_WINDOW`] || '') || 1000000;
  const providerLabel = process.env[`${p}MODEL_PROVIDER`] || 'config-center';
  // 思考深度穿透（配置中心 agent.thinkingLevel）：off = 关思考提效（GLM-5.3 默认思考可达 1.9 万字/轮）
  const thinkingLevelEnv = (process.env[`${p}THINKING_LEVEL`] || '').toLowerCase();
  const thoughtLevel = thinkingLevelEnv === 'off' ? 'disabled' : 'enabled';
  return {
    revision: '1',
    generatedAt: Date.now(),
    model: { providerId: 'zcc', modelId },
    thoughtLevel,
    provider: {
      providerId: 'zcc',
      kind: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      label: providerLabel,
      source: 'workspace',
      baseURL,
      apiKey: { source: 'inline', value: apiKey },
      apiKeyRequired: true,
      models: [{
        modelId,
        label: modelId,
        contextWindow,
        maxOutputTokens: 128000,
        supportsImages: true,
        supportsTools: true,
      }],
    },
  };
}

// ── 会话持久化（桥接重启后 resume 续上下文，对齐 claude.ts 重启保记忆）──

function sessionStoreFile(): string {
  const home = process.env.CTI_HOME
    || path.join(process.env.CTI_USER_HOME || process.env.USERPROFILE || os.homedir(), '.agents-to-feishu');
  return path.join(home, 'runtime', 'zcode-sessions.json');
}

function loadPersistedSessionId(sessionKey: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(sessionStoreFile(), 'utf-8')) as Record<string, { sessionId?: string }>;
    const sid = j[sessionKey]?.sessionId;
    return typeof sid === 'string' && sid.startsWith('sess_') ? sid : null;
  } catch { return null; }
}

function persistSessionId(sessionKey: string, sessionId: string): void {
  try {
    const f = sessionStoreFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {};
    j[sessionKey] = { sessionId, updatedAt: new Date().toISOString() };
    // 防膨胀：只留最近 64 个
    const keys = Object.keys(j);
    if (keys.length > 64) for (const k of keys.slice(0, keys.length - 64)) delete j[k];
    fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf-8');
  } catch { /* 落盘失败不阻塞 */ }
}

function deletePersistedSession(sessionKey: string): void {
  try {
    const f = sessionStoreFile();
    if (!fs.existsSync(f)) return;
    const j = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, unknown>;
    delete j[sessionKey];
    fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf-8');
  } catch { /* 忽略 */ }
}

// ── 运行时类型 ──

interface ZcodeSession {
  sessionId: string;
  cwd: string;
  lastUsed: number;
  personaInjected: boolean;
}

interface TurnSink {
  chatId: string;
  sessionId: string;
  emit: (ev: StreamEvent) => void;
  lastEventAt: number;
  /** 本轮是否已发过 usage（telemetry usage.delta 先到则 turn.completed 不重复发） */
  usageSent: boolean;
  /** 思考流策略（2026-09-05 二次修复）：GLM 工具循环每轮都出新思考，💭尾部滑动窗口会整窗
   * 轮转（视觉=正文反复从头重打）。流式只转发前 THINK_STREAM_HEAD 字后冻结💭；终态补发真实
   * 思考尾部（终卡仍显示 1500 字尾部，保真不闪）。 */
  reasoningBuf: string;
  reasoningFull: string;
  reasoningForwarded: number;
  reasoningLastEmit: number;
  reasoningFrozen: boolean;
  /** 终态收尾：结束 streamChat 的事件循环（queue 先排空再退出，保证顺序） */
  settle: (err?: string) => void;
}

/** 流式阶段转发的思考上限（字符）：💭 尾窗 400，转 400 字后冻结，杜绝整窗轮转 */
const THINK_STREAM_HEAD = Number(process.env.CTI_ZCODE_THINK_HEAD || 400);
/** 终态补发的思考尾部长度（引擎终卡显示 1500 字尾窗） */
const THINK_TAIL = 1100;
/** 思考流合并窗口（毫秒）：低于引擎 1.8s 的💭节流即无意义 */
const THINK_MERGE_MS = 1200;

export class ZcodeProvider implements RuntimeProvider {
  readonly name = 'zcode';

  private child: ChildProcess | null = null;
  private lineBuf = '';
  private nextId = 1;
  /** 客户端→服务器请求的响应等待（按数字 id） */
  private pending = new Map<number, { resolve: (msg: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** sessionKey → zcode 会话 */
  private sessions = new Map<string, ZcodeSession>();
  /** sessionId → 当前轮 sink（同一会话同时只有一轮；bridge 按 chat 串行保证） */
  private turns = new Map<string, TurnSink>();
  private spawnPromise: Promise<ChildProcess> | null = null;

  private static STALL_MS = parseInt(process.env.CTI_ZCODE_STALL_MS || '300000', 10);

  async prepare(): Promise<void> {
    try { await this.ensureProcess(); }
    catch (e) { console.warn('[zcode] prepare pre-spawn failed:', e); }
  }

  async resetSession(sessionKey?: string): Promise<void> {
    // /new：真重置——server 端 close 会话 + 丢弃映射，下一条消息必然全新会话
    const keys = sessionKey ? [sessionKey] : [...this.sessions.keys()];
    for (const k of keys) {
      const s = this.sessions.get(k);
      if (s) {
        try { this.request('session/close', { sessionId: s.sessionId }, 8000).catch(() => {}); } catch { /* 已退出 */ }
        this.turns.delete(s.sessionId);
      }
      this.sessions.delete(k);
      deletePersistedSession(k);
    }
    rtLog(`[zcode] resetSession: ${keys.length} 个会话已清`);
  }

  async interrupt(): Promise<void> {
    // /stop：中断所有活跃轮（正常只有一轮）
    for (const [sessionId] of this.turns) {
      try { this.request('session/stop', { sessionId }, 8000).catch(() => {}); } catch { /* 忽略 */ }
      rtLog(`[zcode] interrupt: session/stop ${sessionId.slice(0, 8)}`);
    }
  }

  async dispose(): Promise<void> {
    if (this.child && !this.child.killed) { try { this.child.kill('SIGTERM'); } catch { /* 忽略 */ } }
    this.child = null;
    this.spawnPromise = null;
    this.sessions.clear();
    this.pending.clear();
    this.lineBuf = '';
    for (const [, t] of this.turns) {
      try { t.emit({ type: 'error', message: 'ZCode 进程已释放' }); } catch { /* 忽略 */ }
    }
    this.turns.clear();
    rtLog('[zcode] dispose');
  }

  // ── 进程与协议 ──

  private ensureProcess(): Promise<ChildProcess> {
    if (this.child && this.child.exitCode === null) return Promise.resolve(this.child);
    if (this.spawnPromise) return this.spawnPromise;

    let rejectSpawn: (e: Error) => void = () => {};
    this.spawnPromise = new Promise<ChildProcess>((resolve, reject) => {
      rejectSpawn = reject;
      const cli = resolveZcodeCli();
      const args = [cli, 'app-server', '--stdio'];
      let child: ChildProcess;
      try { child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: buildSpawnEnv() }); }
      catch (e) { this.spawnPromise = null; reject(e); return; }

      rtLog(`[zcode] app-server spawned pid=${child.pid} cli=${cli}`);
      child.stderr?.on('data', (c: Buffer) => {
        const t = c.toString().trim();
        if (t) rtLog(`[zcode] stderr: ${t.slice(0, 300)}`);
      });
      child.on('error', (err) => {
        rtLog(`[zcode] SPAWN ERROR: ${err.message}`);
        if (this.child === child) { this.child = null; this.spawnPromise = null; }
        reject(err);
      });
      child.on('close', (code) => {
        rtLog(`[zcode] app-server exited code=${code}`);
        if (this.child === child) {
          this.child = null; this.spawnPromise = null;
          this.pending.clear();
          this.lineBuf = '';
          for (const [, t] of this.turns) {
            try { t.emit({ type: 'error', message: `ZCode 进程退出（code=${code}）` }); } catch { /* 忽略 */ }
          }
          this.turns.clear();
        } else if (this.spawnPromise) {
          this.spawnPromise = null;
          rejectSpawn(new Error(`ZCode app-server exited during init (code=${code})`));
        }
      });

      child.stdout!.on('data', (c: Buffer) => this.onStdout(c));
      this.child = child;
      resolve(child);
    });
    return this.spawnPromise;
  }

  private request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('ZCode 进程未就绪'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 请求超时`)); }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { child.stdin!.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  private replyServerRequest(id: string, result: unknown): void {
    try { this.child?.stdin!.write(JSON.stringify({ id, result }) + '\n'); } catch { /* 忽略 */ }
  }

  private replyServerRequestError(id: string, message: string): void {
    try { this.child?.stdin!.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n'); } catch { /* 忽略 */ }
  }

  private onStdout(chunk: Buffer): void {
    this.lineBuf += chunk.toString();
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop() || '';
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) continue;
      let msg: any;
      try { msg = JSON.parse(trimmed); } catch { continue; }

      // ① 客户端请求的响应（数字 id）
      if (msg.id !== undefined && msg.method === undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(String(msg.error.message || JSON.stringify(msg.error).slice(0, 200))));
        else p.resolve(msg.result);
        continue;
      }

      // ② 服务器→客户端请求：必须在 15s 内应答
      if (msg.id !== undefined && typeof msg.id === 'string' && msg.method) {
        this.handleServerRequest(msg);
        continue;
      }

      // ③ 通知分发
      if (msg.method === 'session/event') this.handleSessionEvent(msg.params);
      else if (msg.method === 'v4/telemetry/event') this.handleTelemetry(msg.params);
      // state.updated / process/* / computer-use/* 等无消费方，忽略
    }
  }

  /** 服务器→客户端请求（requestRuntimePreferences / interaction/*），逐类应答 */
  private handleServerRequest(msg: any): void {
    const id = String(msg.id);
    switch (msg.method) {
      case 'session/requestRuntimePreferences':
        // 运行时物化偏好：schema 必填 nativeSearchEnhancementsEnabled，其余走服务端默认
        this.replyServerRequest(id, {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
          modelContextBudgetStrategy: 'preflight-v1',
        });
        break;
      case 'interaction/requestPermission': {
        // 权限申请：按 options 里的 allow 类选项批准（app-server 默认 yolo，此路径一般不触发；
        // 2026-09-05 加固：优先 allow_always > allow_once，与服务器 wNi 映射对齐，防猜错 optionId 被判 deny）
        const options = (msg.params?.options ?? []) as Array<{ optionId?: string; kind?: string; label?: string }>;
        const allow = options.find((o) => String(o.kind || '') === 'allow_always')
          || options.find((o) => String(o.kind || '') === 'allow_once')
          || options.find((o) => /allow|once|always|proceed/i.test(String(o.optionId || '') + String(o.label || '')))
          || options[0];
        rtLog(`[zcode] 权限自动批准 tool=${msg.params?.toolName ?? '?'} risk=${msg.params?.riskLevel ?? '?'} option=${allow?.optionId ?? JSON.stringify(options).slice(0, 120)}`);
        this.replyServerRequest(id, { optionId: allow?.optionId ?? 'allowOnce' });
        break;
      }
      case 'interaction/requestUserInput':
        // 桥接层暂无选择题/填空卡片消费方：接受并交回模型自行决断（decline 会终止整轮）
        rtLog(`[zcode] userInput 自动接受（无交互应答通道）: ${String(msg.params?.prompt ?? '').slice(0, 80)}`);
        this.replyServerRequest(id, { action: 'accept', content: {} });
        break;
      case 'interaction/requestProviderRuntimeHeaders':
        this.replyServerRequest(id, { headers: {} });
        break;
      default:
        // requestOfficialMcpAuthHeaders / browserExecute 等：明确拒绝，不阻塞主流程
        this.replyServerRequestError(id, `provider 未实现: ${msg.method}`);
        break;
    }
  }

  /** session/event：一轮内的流式事件（增量/工具/终态），按 sessionId 路由给当前轮 sink */
  private handleSessionEvent(env: any): void {
    if (!env || typeof env !== 'object') return;
    const sessionId = String(env.sessionId || '');
    const sink = this.turns.get(sessionId);
    if (!sink) return; // 非活跃轮（历史/其他会话）忽略
    sink.lastEventAt = Date.now();
    const type = String(env.type || '');
    const payload = env.payload ?? {};

    switch (type) {
      case 'model.streaming': {
        // 实测正文/思考走这里（part.delta 在 app-server 流里不出现，保留作兼容）
        const kind = String(payload.kind || '');
        const delta = String(payload.delta ?? '');
        if (!delta) break;
        if (kind === 'text_delta') { sink.emit({ type: 'text', text: delta }); break; }
        if (kind === 'reasoning_delta') {
          // 全量留存（终态补发尾部用）；流式只转发头部 THINK_STREAM_HEAD 字后冻结💭
          sink.reasoningFull += delta;
          if (sink.reasoningFrozen) break;
          sink.reasoningBuf += delta;
          const now = Date.now();
          if (sink.reasoningForwarded >= THINK_STREAM_HEAD || (sink.reasoningForwarded + sink.reasoningBuf.length) > THINK_STREAM_HEAD) {
            const head = sink.reasoningBuf.slice(0, Math.max(0, THINK_STREAM_HEAD - sink.reasoningForwarded));
            if (head) { sink.emit({ type: 'thinking', text: head }); sink.reasoningForwarded += head.length; }
            sink.reasoningBuf = '';
            sink.reasoningFrozen = true; // 冻结：杜绝💭尾窗整窗轮转（闪烁根因）
            break;
          }
          if (now - sink.reasoningLastEmit >= THINK_MERGE_MS && sink.reasoningBuf) {
            sink.reasoningLastEmit = now;
            sink.emit({ type: 'thinking', text: sink.reasoningBuf });
            sink.reasoningForwarded += sink.reasoningBuf.length;
            sink.reasoningBuf = '';
          }
        }
        break;
      }
      case 'part.delta': {
        const field = String(payload.field || 'text');
        const delta = String(payload.delta ?? '');
        if (!delta) break;
        if (field === 'text') sink.emit({ type: 'text', text: delta });
        else if (field === 'reasoning') sink.emit({ type: 'thinking', text: delta });
        // field input/output = 工具参数/结果增量，工具卡由 tool.updated 承载
        break;
      }
      case 'tool.updated': {
        const kind = String(payload.kind || '');
        const toolName = String(payload.toolName || payload.toolCallId || 'tool');
        const status = kind === 'result' ? 'done'
          : kind === 'error' ? 'error'
          : kind === 'scheduled' || kind === 'started' || kind === 'progress' ? 'running'
          : null;
        if (!status) break; // batch/raw 忽略
        let input: string | undefined;
        if (payload.input !== undefined) {
          try { input = JSON.stringify(payload.input).slice(0, 200); } catch { input = String(payload.input).slice(0, 200); }
        }
        sink.emit({ type: 'tool', tool: toolName, status: status as 'running' | 'done' | 'error', input });
        break;
      }
      case 'turn.completed': {
        // 终态补发真实思考尾部（流式阶段冻结了💭，终卡仍显示尾部 1500 字窗口，保真）
        if (sink.reasoningFull.length > sink.reasoningForwarded + 100) {
          sink.emit({ type: 'thinking', text: `\n……\n${sink.reasoningFull.slice(-THINK_TAIL)}` });
        }
        sink.reasoningBuf = '';
        if (!sink.usageSent) {
          const usage = this.extractUsage(payload);
          if (usage) { sink.usageSent = true; sink.emit({ type: 'usage', usage, sessionId: sink.sessionId }); }
        }
        const resultType = String(payload.resultType || 'success');
        if (resultType !== 'success' && resultType !== 'cancelled') {
          const resp = String(payload.response ?? '').slice(0, 300);
          sink.emit({ type: 'error', message: `ZCode 轮次异常结束（${resultType}）${resp ? `：${resp}` : ''}` });
        }
        // success/cancelled 由 streamChat finally 统一 yield done，不在这里发，避免双 done
        sink.settle();
        this.turns.delete(sink.sessionId);
        break;
      }
      case 'turn.failed': {
        const err = payload.error as { message?: string; code?: string } | undefined;
        sink.emit({ type: 'error', message: String(err?.message || err?.code || 'ZCode 轮次失败') });
        sink.settle();
        this.turns.delete(sink.sessionId);
        break;
      }
      default:
        break; // turn.started / part.started / message.upserted 等暂无消费方
    }
  }

  /** v4 遥测里的 usage.delta：比 turn.completed 的 tokenCount 更细（含缓存命中） */
  private handleTelemetry(params: any): void {
    if (String(params?.kind || '') !== 'usage.delta') return;
    const sessionId = String(params.sessionId || '');
    const sink = this.turns.get(sessionId);
    if (!sink) return;
    sink.lastEventAt = Date.now();
    const input = Number(params.inputTokens ?? 0);
    const output = Number(params.outputTokens ?? 0);
    if (input <= 0 && output <= 0) return;
    sink.usageSent = true;
    sink.emit({
      type: 'usage',
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: Number(params.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(params.cacheWriteTokens ?? 0) || undefined,
        reasoningTokens: Number(params.reasoningTokens ?? 0) || undefined,
        requests: 1,
      },
      sessionId,
    });
  }

  private extractUsage(payload: any): UsageInfo | null {
    const u = payload?.usage as Record<string, unknown> | undefined;
    const input = Number((u?.inputTokens as number) ?? 0);
    const output = Number((u?.outputTokens as number) ?? 0);
    const tokenCount = Number(payload?.tokenCount ?? 0);
    if (input <= 0 && output <= 0 && tokenCount <= 0) return null;
    return {
      inputTokens: input,
      outputTokens: output > 0 ? output : tokenCount,
      cacheReadTokens: Number((u?.cacheReadTokens as number) ?? 0),
      reasoningTokens: Number((u?.reasoningTokens as number) ?? 0) || undefined,
      requests: 1,
    };
  }

  // ── 会话 ──

  private async ensureSession(params: StreamChatParams): Promise<ZcodeSession> {
    const sessionKey = params.sessionKey;
    const cwd = params.workdir?.trim() || process.env.CTI_DEFAULT_WORKDIR || process.cwd();
    const existing = this.sessions.get(sessionKey);
    if (existing && !params.freshSession && existing.cwd === cwd) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing && params.freshSession) {
      // /new：server 端 close + 丢映射
      try { this.request('session/close', { sessionId: existing.sessionId }, 8000).catch(() => {}); } catch { /* 忽略 */ }
      this.turns.delete(existing.sessionId);
      this.sessions.delete(sessionKey);
    }

    const runtimeModel = buildRuntimeModel();
    const mcpServers = buildMcpServers();
    const workspace = { workspaceKey: cwd, workspacePath: cwd };
    let sessionId = '';

    // 断线续接：桥接重启后从落盘映射 resume（服务端会话持久化），失败回退 create
    const savedId = !params.freshSession && !existing ? loadPersistedSessionId(sessionKey) : null;
    if (savedId) {
      try {
        const r = await this.request('session/resume', {
          sessionId: savedId,
          workspace,
          mode: 'yolo',
          ...(runtimeModel ? { runtimeModel } : {}),
          ...(mcpServers ? { mcpServers } : {}),
        }, 30000);
        sessionId = String(r?.session?.sessionId || r?.sessionId || savedId);
        rtLog(`[zcode] session resumed: ${sessionId.slice(0, 8)} (session=${sessionKey.slice(0, 12)})`);
      } catch (e) {
        rtLog(`[zcode] resume 失败，回退新建: ${e instanceof Error ? e.message : String(e).slice(0, 120)}`);
        sessionId = '';
      }
    }
    if (!sessionId) {
      const r = await this.request('session/create', {
        workspace,
        mode: 'yolo', // 交互会话默认 build=全审批；无头 bot 必须显式 yolo，否则一切工具调用被 "Permission request failed" 拦截
        ...(runtimeModel ? { runtimeModel } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        titleGenerationEnabled: false, // bot 会话无需自动标题，省一次 LLM 调用
      }, 60000);
      sessionId = String(r?.session?.sessionId || r?.sessionId || '');
      if (!sessionId) throw new Error('session/create 未返回 sessionId');
      rtLog(`[zcode] session created: ${sessionId.slice(0, 8)} (session=${sessionKey.slice(0, 12)})`);
    }

    // 订阅会话事件流（不订阅收不到 part.delta / turn.completed）
    try {
      await this.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, 15000);
    } catch (e) {
      rtLog(`[zcode] subscribe 失败（继续，事件可能仍可达）: ${e instanceof Error ? e.message : String(e).slice(0, 120)}`);
    }

    const session: ZcodeSession = { sessionId, cwd, lastUsed: Date.now(), personaInjected: false };
    this.sessions.set(sessionKey, session);
    persistSessionId(sessionKey, sessionId);
    return session;
  }

  // ── 对话 ──

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    let session: ZcodeSession;
    try {
      await this.ensureProcess();
      session = await this.ensureSession(params);
    } catch (e) {
      yield { type: 'error', message: `ZCode 会话创建失败: ${e instanceof Error ? e.message : String(e)}` };
      yield { type: 'done' };
      return;
    }

    // 人设注入：每会话首条消息（对齐 opencode.ts personaInjected 模式）
    let fullPrompt = params.text;
    if (!session.personaInjected && params.systemPrompt) {
      fullPrompt = `${params.systemPrompt}\n\n${params.text}`;
      session.personaInjected = true;
    }
    // /new 后注入历史上下文（含 /compact 摘要，对齐 claude/codex）
    const historyText = params.freshSession && params.history && params.history.length > 0
      ? params.history.map((m) => `[${m.role === 'user' ? '用户' : '助手'}]\n${m.content}`).join('\n\n')
      : '';
    if (historyText) fullPrompt = `${historyText}\n\n---\n\n${fullPrompt}`;

    // 注册 sink 与投递 prompt 连续同步执行（中间无 await），事件按 sessionId 路由
    const queue: StreamEvent[] = [];
    let settled = false;
    let settleErr: string | null = null;
    let resolveSettled: () => void = () => {};
    const settledP = new Promise<void>((r) => { resolveSettled = r; });
    let wakeup: () => void = () => {};
    let wakeupP: Promise<void> = Promise.resolve();
    const poke = (): void => { wakeup(); };

    const sink: TurnSink = {
      chatId: params.sessionKey,
      sessionId: session.sessionId,
      emit: (ev) => { queue.push(ev); poke(); },
      lastEventAt: Date.now(),
      usageSent: false,
      reasoningBuf: '',
      reasoningFull: '',
      reasoningForwarded: 0,
      reasoningLastEmit: 0,
      reasoningFrozen: false,
      settle: (err?: string) => {
        if (err && !settleErr) settleErr = err;
        settled = true;
        resolveSettled();
      },
    };
    this.turns.set(session.sessionId, sink);

    // 空闲看门狗：STALL_MS 内零事件 → session/stop + 报错收尾（活跃生成/工具事件持续刷新 lastEventAt，不误杀长任务）
    const watchdog = setInterval(() => {
      if (settled) { clearInterval(watchdog); return; }
      if (Date.now() - sink.lastEventAt > ZcodeProvider.STALL_MS) {
        clearInterval(watchdog);
        try { this.request('session/stop', { sessionId: session.sessionId }, 8000).catch(() => {}); } catch { /* 忽略 */ }
        sink.settle(`ZCode 连续 ${Math.round(ZcodeProvider.STALL_MS / 1000)}s 无事件，已中断本轮`);
        this.turns.delete(session.sessionId);
      }
    }, 15_000);

    // 中断信号：外部 stop() → session/stop（turn.completed resultType=cancelled 会以 done 收尾）
    const onAbort = (): void => {
      try { this.request('session/stop', { sessionId: session.sessionId }, 8000).catch(() => {}); } catch { /* 忽略 */ }
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    let sendErr: string | null = null;
    try {
      const r = await this.request('session/send', { sessionId: session.sessionId, content: fullPrompt }, 30000);
      if (r?.accepted === false) sendErr = 'session/send 被拒绝（上一轮尚未结束）';
    } catch (e) {
      sendErr = e instanceof Error ? e.message : String(e);
    }
    if (sendErr) {
      clearInterval(watchdog);
      params.signal?.removeEventListener('abort', onAbort);
      this.turns.delete(session.sessionId);
      yield { type: 'error', message: sendErr };
      yield { type: 'done' };
      return;
    }
    rtLog(`[zcode] turn started session=${session.sessionId.slice(0, 8)} chat=${params.sessionKey.slice(0, 12)} text.len=${fullPrompt.length}`);

    try {
      while (true) {
        if (queue.length > 0) { yield queue.shift()!; continue; }
        if (settled) break;
        wakeupP = new Promise<void>((r) => { wakeup = r; });
        if (queue.length > 0 || settled) continue;
        await Promise.race([settledP, wakeupP]);
      }
    } finally {
      clearInterval(watchdog);
      params.signal?.removeEventListener('abort', onAbort);
      this.turns.delete(session.sessionId);
      session.lastUsed = Date.now();
      if (settleErr) yield { type: 'error', message: settleErr };
      yield { type: 'done' };
    }
  }
}

export function createZcodeProvider(): ZcodeProvider {
  return new ZcodeProvider();
}
