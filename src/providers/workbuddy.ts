/**
 * WorkBuddy Provider（第 13 家）—— CodeBuddy ACP 常驻（老大 2026-09-19 令：直接改常驻）。
 *
 * 一轮一进程 headless 版（9e19668）已废弃：冷启动+工具循环单轮 120s+。现对齐
 * mimo/opencode 家法：常驻 `node codebuddy.js --acp`（JSON-RPC 2.0 over stdio）。
 *
 * 协议实测 09-19：initialize{protocolVersion:1,loadSession:true} → session/new{cwd,mcpServers}
 *   → session/set_config_option{configId:'model'|'mode'} → session/prompt{prompt:[{type:'text'}]}
 *   流事件 session/update{agent_message_chunk|agent_thought_chunk|tool_call|tool_call_update|
 *   session_info_update|config_option_update}；回合终止=prompt 响应 {stopReason:'end_turn'}；
 *   反向请求 session/request_permission（配 bypassPermissions 兜底自动放行）。
 * 免腾讯登录：CODEBUDDY_API_KEY（本机 litellm key）；模型 custom-local:<id>（models.json 池）。
 * 会话：sessionKey→wbSessionId 落盘 runtime/sessions-wb-acp.json（🔴 与桥 SessionManager 的
 *   sessions-workbuddy.json 分文件，headless 版同路径互踩是自家事故，已避）；重启后
 *   session/load 恢复，load 失败 → onSessionLost + 新会话重跑（09-19 令禁静默失忆）。
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeProvider, StreamChatParams, StreamEvent } from './types.js';
import { buildWindowsPath, getEnvPath } from './win-spawn-env.js';
import { readCtiMcpDefs } from './shared/per-session-mcp.js';
import { resolveMcpArgPaths } from '../tools/mcp-path-resolve.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

function resolveWbCli(): string {
  const custom = process.env.CTI_WB_CLI || '';
  if (custom && fs.existsSync(custom)) return custom;
  return 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy.js';
}

/** 人设交付：新会话首条消息前置 systemPrompt（对齐 12 家老法，不碰 spawn 参数）。 */

function resolveApiKey(): string {
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY;
  try {
    const home = process.env.CTI_USER_HOME || os.homedir();
    const mj = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'models.json'), 'utf8')) as Array<{ apiKey?: string }>;
    return mj.find((m) => m.apiKey)?.apiKey || '';
  } catch { return ''; }
}

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
  // 🔴 LocalSystem 服务账号补丁：codebuddy 会话/配置存储走 APPDATA 系，不改就落在 systemprofile 目录
  clean.APPDATA = path.join(home, 'AppData', 'Roaming');
  clean.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  clean.PATH = buildWindowsPath(getEnvPath(clean));
  clean.CODEBUDDY_API_KEY = resolveApiKey();
  clean.NO_COLOR = '1';
  return clean;
}

/** ACP mcpServers 数组（stdio/http/sse 三形态），配置中心池直读。
 *  20:47 时代以此形态实测六域全绿（lark/openmem/生图真调有痕），是已验证的正解；
 *  09-19 夜曾误判"此路不通"换 --mcp-config 文件+--tools，反把 MCP 池杀光（见 ensureChild 注释）。 */
function buildMcpServers(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  try {
    for (const d of readCtiMcpDefs('workbuddy')) {
      if (d.transport === 'stdio' && d.command) {
        out.push({
          name: d.id,
          command: d.command,
          args: resolveMcpArgPaths(d.id, d.args || []),
          env: Object.entries(d.env || {}).map(([name, value]) => ({ name, value })),
        });
      } else if (d.url) {
        out.push({ name: d.id, type: d.transport === 'sse' ? 'sse' : 'http', url: d.url, headers: [] });
      }
    }
  } catch (e) { rtLog(`[wb-acp] mcp 池读取失败: ${e}`); }
  return out;
}

interface WbSession { sid: string; model: string; gen?: number; }
const MAP_FILE = (): string => path.join(
  process.env.CTI_USER_HOME || os.homedir(), '.agents-to-feishu', 'runtime', 'sessions-wb-acp.json',
);

export function createWorkBuddyProvider(): RuntimeProvider {
  let child: ChildProcess | null = null;
  let startPromise: Promise<void> | null = null;
  let idc = 0;
  const pend = new Map<number, (m: Record<string, unknown>) => void>();
  // 当前 prompt 的收流器：sessionKey → 回调
  let active: { key: string; onUpdate: (u: Record<string, unknown>) => void } | null = null;
  const sessions = new Map<string, WbSession>();
  const cwdOf = (p?: string): string => p || process.env.CTI_WORKDIR || 'C:\\D\\opt';

  try {
    const raw = JSON.parse(fs.readFileSync(MAP_FILE(), 'utf8')) as Record<string, WbSession>;
    for (const [k, v] of Object.entries(raw)) if (v?.sid) sessions.set(k, { sid: v.sid, model: v.model });
  } catch { /* 首跑 */ }
  const saveMap = (): void => {
    try {
      fs.mkdirSync(path.dirname(MAP_FILE()), { recursive: true });
      fs.writeFileSync(MAP_FILE(), JSON.stringify(Object.fromEntries(sessions)), 'utf8');
    } catch { /* 落盘失败不拦主流程 */ }
  };

  const rpc = (method: string, params: Record<string, unknown>, timeoutMs = 180000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (!child?.stdin?.writable) return reject(new Error('WB ACP 子进程不在'));
      const id = ++idc;
      pend.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      // 🔴 09-19 事故：prompt 曾同吃 180s 保险丝，长任务回合（生图/审计）没到终点先被我们枪毙，
      // 卡上留下"session/prompt 超时"假死状。调用方给 prompt 传 15min。
      setTimeout(() => { if (pend.has(id)) { pend.delete(id); reject(new Error(`${method} 超时 ${Math.round(timeoutMs / 1000)}s`)); } }, timeoutMs);
    });
  // 🔴 codebuddy 吞 SIGTERM（09-19 实锤：换代后老进程 3 代同堂堆积）——整树强杀
  const hardKill = (c: ChildProcess | null): void => {
    if (!c?.pid) return;
    try { execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' }); } catch { /* 已死 */ }
  };
  const notify = (method: string, params: Record<string, unknown>): void => {
    try { child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* 尽力 */ }
  };

  const onLine = (line: string): void => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && pend.has(Number(m.id))) {
      const cb = pend.get(Number(m.id))!;
      pend.delete(Number(m.id));
      cb(m);
      return;
    }
    if (m.method === 'session/update') { active?.onUpdate((m.params as { update?: Record<string, unknown> })?.update || {}); return; }
    if (m.method === 'session/request_permission') {
      // bypassPermissions 已配，正常不会来；来了就放行第一项，绝不让它卡死
      const opts = ((m.params as { options?: Array<Record<string, unknown>> })?.options) || [];
      try {
        child?.stdin?.write(JSON.stringify({
          jsonrpc: '2.0', id: m.id,
          result: { outcome: { outcomeSel: 'selected', optionId: opts[0]?.optionId || 'allow_once' } },
        }) + '\n');
      } catch { /* 死了有看门狗 */ }
      rtLog('[wb-acp] request_permission 自动放行（异常路径，查 mode 配置）');
    }
  };

  async function ensureChild(): Promise<void> {
    if (child?.stdin?.writable && child.exitCode === null) return;
    if (startPromise) return startPromise;
    startPromise = (async (): Promise<void> => {
      // 🔴 09-20 复盘定罪：--tools 是全局白名单，把 MCP 池一并杀了（20:47 无刀时六域全绿
      // 真调有痕；22:2x 加刀后 mcp__*=0，还被它带进自报"我只有 6 个工具"）。撤刀。
      // 防失控交回 --max-turns/--effort；MCP 恢复 session/new 数组=20:47 原配正解。
      const cliArgs = [resolveWbCli(), '--acp', '--max-turns', '40', '--effort', 'medium'];
      const proc = spawn(process.execPath, cliArgs, { cwd: cwdOf(), env: buildSpawnEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      child = proc;
      let buf = '';
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l.trim()); }
      });
      let stderr = '';
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (d: string) => { stderr = (stderr + d).slice(-4000); });
      // 🔴 09-19 事故根因（老大当面骂出来的）：老一代进程的 exit 回调晚到，执行 child=null
      // 把刚接手的新一代引用清空 ⇒ 卡上"WB ACP 子进程不在"+ 每轮重生堆积（3 代同堂）。
      // 铁律：只允许清自己那一代（按进程实例判等）。
      proc.on('exit', (code) => {
        rtLog(`[wb-acp] 子进程退出 code=${code} stderr尾=${stderr.slice(-200)}`);
        if (child === proc) { child = null; startPromise = null; }
      });
      const r = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
      if (!r.result) throw new Error('WB ACP initialize 失败');
      rtLog('[wb-acp] initialize OK');
    })();
    try { await startPromise; } finally { if (!child) startPromise = null; }
  }

  async function newSession(workdir: string): Promise<string> {
    const r = await rpc('session/new', { cwd: workdir, mcpServers: buildMcpServers() });
    const sid = String((r.result as { sessionId?: string })?.sessionId || '');
    if (!sid) throw new Error(`WB ACP session/new 失败: ${JSON.stringify(r.error || {}).slice(0, 200)}`);
    try { await rpc('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'bypassPermissions' }); }
    catch (e) { rtLog(`[wb-acp] mode 设置失败（不致命）: ${e}`); }
    try { await rpc('session/set_config_option', { sessionId: sid, configId: 'model', value: resolveModel() }); }
    catch (e) { rtLog(`[wb-acp] model 设置失败（不致命）: ${e}`); }
    return sid;
  }

  return {
    name: 'workbuddy',
    async prepare(): Promise<void> {
      if (!fs.existsSync(resolveWbCli())) throw new Error(`CodeBuddy CLI 不存在: ${resolveWbCli()}`);
      if (!resolveApiKey()) throw new Error('WB 认证 key 缺失（CODEBUDDY_API_KEY / models.json 均无）');
      await ensureChild();
    },
    async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
      const workdir = cwdOf(params.workdir);
      await ensureChild();
      // 09-19 晚间纠错：codebuddy 有真记忆系统（~/.codebuddy/projects/*/memory/MEMORY.md + 词文件），
      // session/load 重启恢复实测有效（老大亲证）。恢复 load 路径，"换代强制失忆"补丁为误判产物，废除。
      const wantSid = params.freshSession ? '' : sessions.get(params.sessionKey)?.sid || '';
      let sid = '';
      if (wantSid) {
        try {
          const r = await rpc('session/load', { sessionId: wantSid, cwd: workdir, mcpServers: buildMcpServers() });
          if (!r.error) sid = wantSid;
        } catch { /* 落新建 */ }
        if (!sid) {
          params.onSessionLost?.();
          sessions.delete(params.sessionKey);
          saveMap();
          rtLog(`[wb-acp] load 真失败 key=${params.sessionKey.slice(0, 10)} → 弹卡+新建`);
        }
      }
      if (!sid) sid = await newSession(workdir);
      // 人设交付：新建会话的首条消息前置 systemPrompt（load 恢复成功的老会话不重复灌，
      // 防止长会话每轮重放纪律被当新指令）。
      const promptText = (!wantSid && params.systemPrompt)
        ? `${params.systemPrompt}\n\n${params.text}`
        : params.text;
      if (!sid) throw new Error('WB ACP 无法建立会话');
      sessions.set(params.sessionKey, { sid, model: resolveModel() });
      saveMap();

      const queue: StreamEvent[] = [];
      let rtLoggedUsage = false;
      let doneMark: (() => void) | null = null;
      active = {
        key: params.sessionKey,
        onUpdate: (u) => {
          const s = String(u.sessionUpdate || '');
          if (s === 'agent_message_chunk' && (u.content as { type?: string })?.type === 'text' && (u.content as { text?: string })?.text) {
            queue.push({ type: 'text', text: String((u.content as { text: string }).text) });
          } else if (s === 'agent_thought_chunk' && (u.content as { type?: string })?.type === 'text' && (u.content as { text?: string })?.text) {
            queue.push({ type: 'thinking', text: String((u.content as { text: string }).text) });
          } else if (s === 'tool_call' || s === 'tool_call_update') {
            const title = String(u.title || u.kind || 'tool');
            const st = String(u.status || (s === 'tool_call' ? 'running' : 'done'));
            const raw = u.rawInput !== undefined ? JSON.stringify(u.rawInput) : undefined;
            const outTxt = u.rawOutput !== undefined ? String(JSON.stringify(u.rawOutput)).slice(0, 4000) : undefined;
            queue.push({ type: 'tool', tool: title.slice(0, 80), input: raw?.slice(0, 2000), status: st === 'failed' ? 'error' : (st === 'completed' ? 'done' : 'running'), output: outTxt });
          } else if (s === 'usage_update') {
            // 🔴 三治之三：codebuddy 原生 usage_update{used,size,_meta['codebuddy.ai/usageByCategory']}
            const meta = (u._meta as Record<string, unknown>) || {};
            const cat = (meta['codebuddy.ai/usageByCategory'] as Record<string, number>) || {};
            const num = (...ks: string[]): number => { for (const k of ks) { const v = cat[k]; if (typeof v === 'number') return v; } return 0; };
            queue.push({ type: 'usage', usage: {
              inputTokens: Number(u.used || 0),
              outputTokens: num('output', 'output_tokens', 'completion'),
              cacheReadTokens: num('cacheRead', 'cache_read', 'cache_read_input_tokens'),
              cacheWriteTokens: num('cacheWrite', 'cache_creation', 'cache_creation_input_tokens'),
            }, sessionId: sid });
            if (!rtLoggedUsage) { rtLoggedUsage = true; rtLog(`[wb-acp] usage_update 首见: used=${u.used} size=${u.size} cat=${JSON.stringify(cat).slice(0, 300)}`); }
          } else if (s === 'session_info_update') {
            const meta = (u._meta as Record<string, unknown>) || u;
            const tok = (meta as { usage?: Record<string, number> }).usage || (meta as { tokens?: Record<string, number> }).tokens;
            if (tok) {
              queue.push({ type: 'usage', usage: { inputTokens: Number(tok.input || tok.input_tokens || 0), outputTokens: Number(tok.output || tok.output_tokens || 0), cacheReadTokens: Number(tok.cacheRead || tok.cache_read_input_tokens || 0), cacheWriteTokens: Number(tok.cacheWrite || tok.cache_creation_input_tokens || 0) }, sessionId: sid });
            }
          }
          doneMark?.();
        },
      };
      try {
        const p = rpc('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: promptText }] }, 900000);
        p.then((res) => {
          if (res.error) queue.push({ type: 'error', message: `WB 引擎报错: ${JSON.stringify(res.error).slice(0, 300)}` });
          else if (res.result && !String((res.result as { stopReason?: string }).stopReason || '').includes('cancel')) {
            /* 正常 end_turn，下面统一 done */
          }
          doneMark?.();
        }).catch((e: unknown) => { queue.push({ type: 'error', message: `WB 回合失败: ${String(e).slice(0, 200)}` }); doneMark?.(); });
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          const finished = await Promise.race([
            p.then(() => true).catch(() => true),
            new Promise<boolean>((r) => { doneMark = () => r(false); setTimeout(() => r(false), 300); }),
          ]);
          if (finished) break;
        }
        while (queue.length > 0) yield queue.shift()!;
        yield { type: 'done' };
      } finally {
        active = null;
        doneMark = null;
      }
    },
    async resetSession(sessionKey?: string): Promise<void> {
      if (sessionKey) sessions.delete(sessionKey);
      else sessions.clear();
      saveMap();
    },
    async interrupt(): Promise<void> {
      const s = active && sessions.get(active.key);
      if (s) notify('session/cancel', { sessionId: s.sid });
    },
    async dispose(): Promise<void> {
      hardKill(child);
      child = null;
    },
  };
}
