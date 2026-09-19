/**
 * WorkBuddy Provider —— 第 13 家（老大 2026-09-19 令）。
 *
 * 引擎 = WorkBuddy 桌面版内置的 CodeBuddy CLI，headless 一轮一进程：
 *   node codebuddy.js -p --output-format stream-json -y --model custom-local:<id>
 *     [--resume <sid>] [--append-system-prompt <人设>] "<文本>"
 * 免腾讯登录（实测 CODEBUDDY_API_KEY 指本机 litellm 即可跑通）、免公网回调
 * （飞书 WS 长连接由本桥扛）、模型走 ~/.workbuddy/models.json 的 custom-local 池。
 *
 * stream-json 事件（2026-09-19 实测形状，Anthropic 风格 NDJSON）：
 *   system/init{session_id} → assistant{message.content[]: thinking|text|tool_use}
 *   → user{tool_result} → result{subtype:'success'|'error', result, usage?, session_id}
 *
 * 会话：sessionKey→sessionId 映射落盘（重启续聊）；resume 失败（会话被清）→
 * 调 params.onSessionLost()（老大 09-19 令：禁止静默失忆）并以新会话重跑本轮。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeProvider, StreamChatParams, StreamEvent } from './types.js';
import { buildWindowsPath, getEnvPath } from './win-spawn-env.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

/** CodeBuddy CLI 入口（WorkBuddy 内置）。CTI_WB_CLI 可覆盖。 */
function resolveWbCli(): string {
  const custom = process.env.CTI_WB_CLI || '';
  if (custom && fs.existsSync(custom)) return custom;
  const candidates = [
    'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy.js',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return candidates[0];
}

/** headless 认证 key：环境优先，否则回读 ~/.workbuddy/models.json 里 custom 模型自带的 key。 */
function resolveApiKey(): string {
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY;
  try {
    const home = process.env.CTI_USER_HOME || os.homedir();
    const mj = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'models.json'), 'utf8')) as Array<{ apiKey?: string }>;
    const key = mj.find((m) => m.apiKey)?.apiKey || '';
    if (key) return key;
  } catch { /* 读不到就走环境 */ }
  return '';
}

/** 模型 id：配置中心渲染 CTI_BOT_WORKBUDDY_MODEL → custom-local:<id>（CLI 里自定义模型带前缀）。 */
function resolveModel(): string {
  const raw = process.env.CTI_BOT_WORKBUDDY_MODEL || 'QW3.8F';
  return raw.startsWith('custom-local:') || raw === 'auto' ? raw : `custom-local:${raw}`;
}

function buildSpawnEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('DSH_')) continue;
    clean[k] = v;
  }
  const home = process.env.CTI_USER_HOME || os.homedir();
  if (clean.USERPROFILE === undefined || clean.USERPROFILE.includes('systemprofile')) clean.USERPROFILE = home;
  if (clean.HOME === undefined || clean.HOME.includes('systemprofile')) clean.HOME = home;
  clean.PATH = buildWindowsPath(getEnvPath(clean));
  clean.CODEBUDDY_API_KEY = resolveApiKey();
  return clean;
}

const SESSIONS_FILE = (): string => path.join(
  process.env.CTI_USER_HOME || os.homedir(), '.agents-to-feishu', 'runtime', 'sessions-workbuddy.json',
);

export function createWorkBuddyProvider(): RuntimeProvider {
  const sessions = new Map<string, string>();
  let currentChild: ReturnType<typeof spawn> | null = null;
  let aborted = false;

  const loadSessions = (): void => {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE(), 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) sessions.set(k, v);
    } catch { /* 首跑无文件 */ }
  };
  const saveSessions = (): void => {
    try {
      fs.mkdirSync(path.dirname(SESSIONS_FILE()), { recursive: true });
      fs.writeFileSync(SESSIONS_FILE(), JSON.stringify(Object.fromEntries(sessions)), 'utf8');
    } catch (e) { rtLog(`[wb] 会话落盘失败: ${e}`); }
  };
  loadSessions();

  async function* runTurn(args: string[], cwd: string, env: NodeJS.ProcessEnv, onSid: (sid: string) => void): AsyncGenerator<StreamEvent> {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    currentChild = child;
    let buf = '';
    let stderr = '';
    const queue: StreamEvent[] = [];
    let notify: (() => void) | null = null;
    let closed = false;
    const wake = (): void => { notify?.(); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { continue; }
        const t = String(ev.type);
        if (t === 'system' && ev.session_id) onSid(String(ev.session_id));
        if (t === 'assistant') {
          const content = (ev.message as { content?: Array<Record<string, unknown>> })?.content || [];
          for (const c of content) {
            const ct = String(c.type);
            if (ct === 'text' && c.text) queue.push({ type: 'text', text: String(c.text) });
            else if (ct === 'thinking' && c.thinking) queue.push({ type: 'thinking', text: String(c.thinking) });
            else if (ct === 'tool_use') queue.push({ type: 'tool', tool: String(c.name || 'tool'), input: JSON.stringify(c.input ?? {}), status: 'running' });
          }
        } else if (t === 'user') {
          const content = (ev.message as { content?: Array<Record<string, unknown>> })?.content || [];
          for (const c of content) {
            if (String(c.type) === 'tool_result') {
              const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
              queue.push({ type: 'tool', tool: 'tool_result', input: undefined, status: c.is_error ? 'error' : 'done', output: String(txt).slice(0, 4000) });
            }
          }
        } else if (t === 'result') {
          const sid = String(ev.session_id || '');
          if (sid) onSid(sid);
          const u = ev.usage as Record<string, number> | undefined;
          if (u) {
            queue.push({ type: 'usage', usage: {
              inputTokens: u.input_tokens || u.prompt_tokens || 0,
              outputTokens: u.output_tokens || u.completion_tokens || 0,
              cacheReadTokens: u.cache_read_input_tokens || 0,
              cacheWriteTokens: u.cache_creation_input_tokens || 0,
            }, sessionId: sid || undefined });
          }
          if (ev.is_error) queue.push({ type: 'error', message: String(ev.result || 'WB 引擎报错') });
          rtLog(`[wb] result subtype=${ev.subtype} sid=${sid} usage=${u ? '有' : '无'}`);
        }
        wake();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-4000); });
    child.on('close', () => { closed = true; wake(); });
    child.on('error', (e) => { queue.push({ type: 'error', message: `WB CLI 启动失败: ${e.message}` }); closed = true; wake(); });

    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) break;
        if (aborted) { try { child.kill('SIGKILL'); } catch {} break; }
        await new Promise<void>((r) => { notify = r; setTimeout(r, 300); });
      }
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      notify = null;
      currentChild = null;
    }
    if (aborted) yield { type: 'done' };
    else if (!stderr.includes('No conversation found')) yield { type: 'done' };
    else yield { type: 'error', message: `WB_RESUME_LOST:${stderr.slice(-300)}` };
  }

  return {
    name: 'workbuddy',
    async prepare(): Promise<void> {
      if (!fs.existsSync(resolveWbCli())) throw new Error(`WorkBuddy CLI 不存在: ${resolveWbCli()}`);
      if (!resolveApiKey()) throw new Error('WB 认证 key 缺失（CODEBUDDY_API_KEY / models.json 均无）');
    },
    async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
      aborted = false;
      const env = buildSpawnEnv();
      const cwd = params.workdir || process.env.CTI_WORKDIR || 'C:\\D\\opt';
      const sid = params.freshSession ? undefined : sessions.get(params.sessionKey);
      const mkArgs = (resume: string | undefined): string[] => {
        const a = [resolveWbCli(), '-p', '--output-format', 'stream-json', '-y', '--model', resolveModel()];
        if (resume) a.push('--resume', resume);
        else if (params.systemPrompt) a.push('--append-system-prompt', params.systemPrompt);
        a.push(params.text);
        return a;
      };
      let lostDetected = false;
      const onSid = (s: string): void => { if (s) { sessions.set(params.sessionKey, s); saveSessions(); } };
      for await (const ev of runTurn(mkArgs(sid), cwd, env, onSid)) {
        if (ev.type === 'error' && ev.message.startsWith('WB_RESUME_LOST:')) { lostDetected = true; break; }
        yield ev;
      }
      if (lostDetected) {
        params.onSessionLost?.();
        sessions.delete(params.sessionKey);
        saveSessions();
        rtLog(`[wb] resume 丢失 → onSessionLost + 新会话重跑 key=${params.sessionKey}`);
        for await (const ev of runTurn(mkArgs(undefined), cwd, env, onSid)) yield ev;
      }
    },
    async resetSession(sessionKey?: string): Promise<void> {
      if (sessionKey) sessions.delete(sessionKey);
      else sessions.clear();
      saveSessions();
      if (currentChild) { try { currentChild.kill('SIGKILL'); } catch {} }
    },
    async interrupt(): Promise<void> {
      aborted = true;
      if (currentChild) { try { currentChild.kill('SIGKILL'); } catch { /* 已退出 */ } }
    },
    async dispose(): Promise<void> {
      if (currentChild) { try { currentChild.kill('SIGKILL'); } catch {} }
    },
  };
}
