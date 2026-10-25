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
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeProvider, StreamChatParams, StreamEvent } from './types.js';

/**
 * 🔴 2026-10-14 根因定罪 + 修法：WorkBuddy 2.161.0 升级后 `--acp` 的 stdio 通道已废
 * （父进程常驻但零输出、不回 initialize，且旧 `--effort medium --max-turns 40` 直接秒退）。
 * 实测 2.161 的 ACP 默认就是 streamable-http：要自己起一个 HTTP serve，再走
 *   POST /api/v1/acp/connect          → 拿 connectionId
 *   POST /api/v1/acp（带 acp-connection-id + x-codebuddy-request:1，Accept: SSE）
 *                                        → 发 JSON-RPC，响应是 SSE 长连，帧结构和 stdio 一致
 * 所以这里 spawn `--serve --port ACP_PORT --host 127.0.0.1`（父进程常驻 HTTP，实测稳定），
 * 内部 rpc/notify 改走 HTTP-SSE，帧解析（onNotify）原样复用。
 */
/**
 * bot 维度隔离（2026-10-24 接 CEO：runtime=workbuddy 的第二个 bot 上线）：
 * - ACP_PORT：serve 端口按 bot 分。workbuddy 自家 18753（历史值不动）；其他 bot 必须
 *   在下面 ACP_PORT_MAP 登记，否则 fallback 18753 会 EADDRINUSE 且 spawn 前 killPort
 *   会把上家 serve 当残留杀掉（两家互杀，不是假设是代码路径）。
 * - OFFICIAL_CONFIG_DIR：官方登录态目录。默认共用主目录（登录态无独立凭据文件，跟着
 *   CONFIG_DIR 体系走）；实测共用有互踩（storage.json/agent-home 覆盖）的 bot 在
 *   CONFIG_DIR_MAP 登记独立目录（cp -r 主目录过去即可带上登录态）。
 * - resolveModel：模型 env 按 bot id 动态取（CTI_BOT_<ID>_MODEL，render.ts 267 行同款）。
 * - MCP 池：readCtiMcpDefs 按 bot id 取（CTI_BOT_<ID>_MCP_SERVERS），写死 'workbuddy'
 *   会让第二个 bot 读到空池。
 * - 会话存档：按 bot 分文件；workbuddy 自家保持 sessions-wb-acp.json 原名（存量会话不丢）。
 */
const BOT_SLUG = process.env.CTI_BOT || 'workbuddy';
const ACP_PORT_MAP: Record<string, number> = { ceo: 18754 };
const ACP_PORT = ACP_PORT_MAP[BOT_SLUG] ?? 18753;
const ACP_HOST = '127.0.0.1';

/**
 * 官方账号模式（2026-10-23，老大拍板）：配置中心给该 bot 选了 officialAuth=true 的 provider
 * （codebuddy-official）时，render 下发 CTI_BOT_<ID>_OFFICIAL_AUTH=1。此模式下引擎换成
 * 官方完整版 codebuddy-cli（bin\codebuddy），认证走专用 CODEBUDDY_CONFIG_DIR 里的官方
 * 登录态（磁盘持久化，重启不掉），不注 CODEBUDDY_API_KEY、模型不拼 custom-local: 前缀，
 * 模型路由由官方接手（auto = 官方默认；具体 id = 官方模型）。切回 litellm provider 即还原旧路。
 */
const OFFICIAL_CONFIG_DIR_MAP: Record<string, string> = {};
const OFFICIAL_CONFIG_DIR = OFFICIAL_CONFIG_DIR_MAP[BOT_SLUG] || 'C:\\D\\opt\\codebuddy-cli\\home';
const OFFICIAL_CLI = 'C:\\D\\opt\\codebuddy-cli\\app\\bin\\codebuddy';
const isOfficialAuth = (): boolean =>
  process.env[`CTI_BOT_${(process.env.CTI_BOT || 'workbuddy').toUpperCase()}_OFFICIAL_AUTH`] === '1';
import { buildWindowsPath, getEnvPath } from './win-spawn-env.js';
import { readCtiMcpDefs } from './shared/per-session-mcp.js';
import { isInFlightResumeError, reviveInFlightSession } from './shared/revive.js';
import { resolveMcpArgPaths } from '../tools/mcp-path-resolve.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

function resolveWbCli(): string {
  // 官方账号模式优先：官方完整版 CLI（在 CTI_WB_CLI 判定之前，防 nssm 旧值 short-circuit）
  if (isOfficialAuth() && fs.existsSync(OFFICIAL_CLI)) return OFFICIAL_CLI;
  const custom = process.env.CTI_WB_CLI || '';
  if (custom && fs.existsSync(custom)) return custom;
  // WorkBuddy 2026-09-21 升级后 dist/codebuddy.js（TUI 包）已删，只剩 headless / lite-wb。
  // --acp 是 headless 场景，按 现行 headless → 旧 TUI → bin 启动器 顺序认。
  const root = 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli';
  const candidates = [
    root + '\\dist\\codebuddy-headless.js',
    root + '\\dist\\codebuddy.js',
    // 2026-10-14 实锤：WorkBuddy 2.161.0 升级后 dist/ 只剩 codebuddy-lite-wb.mjs（--acp 支持，
    // 实测可起）；bin\codebuddy 启动器 require('../dist/codebuddy') MODULE_NOT_FOUND，必崩。
    root + '\\dist\\codebuddy-lite-wb.mjs',
    root + '\\bin\\codebuddy',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}

/** 人设交付：新会话首条消息前置 systemPrompt（对齐 12 家老法，不碰 spawn 参数）。 */

// ⚠ 09-29 夜实测后撤回的尝试（留字为证，别再走一遍）：曾以为病根是"取的钥匙不对"——旧写法
// 无脑取 process.env.CODEBUDDY_API_KEY / 模型池第一条（= deepseek-v4-flash 那把 35 位），改成
// "按 resolveModel() 到 ~/.workbuddy/models.json 里精确取所选模型的 apiKey"。tsc 全绿、22:51:46
// 重启装载、22:52:09 实测：取到了本机 litellm 钥匙（9 位 sk-200*）**仍然 504**（第 6 次）。
// ⇒ 假设被否：腾讯 wb.tencentbuddy.com 那句"API key verification service temporarily unavailable"
// 与我们递哪把钥匙无关。真实约束见 openmem 4b9e1343 与本票 T-0028 全文轨。
/** 官方账号模式用的托管 node（22.x 最新版，8322 实测稳）；普通模式沿用桥自身 node。 */
function resolveManagedNode(): string {
  if (!isOfficialAuth()) return process.execPath;
  try {
    const root = 'C:\\Users\\oadan\\.workbuddy\\binaries\\node\\versions';
    const vers = fs.readdirSync(root).filter((d) => /^22\./.test(d)).sort().reverse();
    if (vers[0]) return path.join(root, vers[0], 'node.exe');
  } catch { /* 探测失败回落桥自身 node */ }
  return process.execPath;
}

function resolveApiKey(): string {
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY;
  try {
    const home = process.env.CTI_USER_HOME || os.homedir();
    const mj = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy', 'models.json'), 'utf8')) as Array<{ apiKey?: string }>;
    return mj.find((m) => m.apiKey)?.apiKey || '';
  } catch { return ''; }
}

function resolveModel(): string {
  const raw = (process.env[`CTI_BOT_${BOT_SLUG.toUpperCase()}_MODEL`] || 'DV4F').trim();
  // 官方账号模式：auto / 官方模型 id 原样直传——custom-local: 是本机模型池语法，官方路由不认
  if (isOfficialAuth()) return raw;
  // 🔴 2026-10-14：litellm(127.0.0.1:4000) 上 GLM5.3 系(wb-glm5.3f/fx)流式返回空 delta → CLI 收空 →
  // "empty response output from model" → abort/cancelled。DV4F(deepseek 系)流式 content 正常。
  // 在 litellm 流式修复前，任何 glm5.3f 误设一律回落 DV4F。
  const safe = /glm5\.3f/i.test(raw) ? 'DV4F' : raw;
  return safe.startsWith('custom-local:') || safe === 'auto' ? safe : `custom-local:${safe}`;
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
  const official = isOfficialAuth();
  if (official) {
    // ── 官方账号模式（2026-10-23）：官方登录态在专用 CONFIG_DIR（磁盘持久化），
    // 不注 CODEBUDDY_API_KEY（防 CLI 切到 key 认证架空官方登录态，也绕开 T-0028 的
    // wb.tencentbuddy.com 504 验证坑）；模型原值直传，auto 则不设让官方默认接管。──
    clean.CODEBUDDY_CONFIG_DIR = OFFICIAL_CONFIG_DIR;
    // 🔴 2026-10-23 修 ACP "Authentication required"：serve 网关 auth 模式优先读 env
    // （CODEBUDDY_GATEWAY_AUTH=password|none），settings.json 的 gateway.auth=password
    // 是在 Web UI 场景写的；本 CLI 子进程只绑 127.0.0.1 供本桥 provider 直连，
    // 没有浏览器会话可带 token → 每代 serve 都被 auth 挡死，bot 陷入启动崩溃循环。
    // 显式关掉（纯 env、只作用于本子进程，不动 settings.json、不影响 :8322 主实例）。
    clean.CODEBUDDY_GATEWAY_AUTH = 'none';
    const wbModelId = resolveModel();
    if (wbModelId && wbModelId !== 'auto') clean.CODEBUDDY_MODEL = wbModelId;
    else delete clean.CODEBUDDY_MODEL;
    delete clean.CODEBUDDY_API_KEY;
    rtLog(`[${BOT_SLUG}-acp] 官方账号模式: CONFIG_DIR=${OFFICIAL_CONFIG_DIR} CODEBUDDY_MODEL=${clean.CODEBUDDY_MODEL || '(unset→官方默认)'}`);
  } else {
    clean.CODEBUDDY_API_KEY = resolveApiKey();
    // [T-0028 甲方案 · 09-29 夜，只用环境变量、不改厂家任何文件] 从 CLI 自身代码里读出来的开关（398 个
    // CODEBUDDY_* 变量中筛出的）：CODEBUDDY_MODEL / CODEBUDDY_DISABLE_BUILTIN_MODELS。
    // 现象依据：CLI 日志自报 `[SettingsEndpointProductProvider] resolved endpoint=<unset> env=internal`
    // 即"回落到厂家内网路由"，随后 `Prompt refused … (target: https://wb.tencentbuddy.com)` 504 skipRun；
    // 而桥外同参数同钥匙同会话探针能正常回话 ⇒ 差别在"这一代进程开工时认定的模型/路由"。
    // 这里显式把它钉在我们自己的网关模型上，别再去厂家内网验身。若无效整段删掉即可（纯 env，可秒回滚）。
    const wbModelId = resolveModel();
    // 🔴 2026-10-14 修：无条件覆盖（原 `if(!clean.CODEBUDDY_MODEL)` 盖不住 WorkBuddy 自己配置文件里写的
    // CODEBUDDY_MODEL=wb-glm5.3f 死模型 → 钉死导致 CustomModelConfigError 拒跑 refusal）
    clean.CODEBUDDY_MODEL = wbModelId;
    rtLog(`[${BOT_SLUG}-acp] 甲方案钉模型: CODEBUDDY_MODEL=${clean.CODEBUDDY_MODEL}`);
  }
  clean.NO_COLOR = '1';
  // [T-0028c 09-29 夜 · 老大令修] 子进程环境**白名单化**：原先把服务进程的 94 个变量整盆端给腾讯的
  // codebuddy 子进程，里面混着别家钥匙与老大机器凭据（GATEWAY/LITELLM/OPENAI/ANYSEARCH/QWEN/REASONIX/
  // N5105_SSH_PASSWORD…）——既是不该泄的攻击面，也是本次"桥内 skipRun、桥外同参同钥匙正常回话"唯一
  // 没排除的差异。这里只剥"与我们/厂家无关或含密钥"的项，保留运行必需的（PATH/HOME/APPDATA/系统目录）。
  // 实测口径：剥完重启 → 发一句 → 看 FINAL text.len 是否 >0；若仍 0，回来把本段整块删掉即可（不影响原逻辑）。
  const strip = /^(CTI_|DSH_|NSSM|ANYSEARCH_|QWEN_TOKEN|REASONIX_|N5105_|GH_|GITHUB_|GIT_|PAGER|VOLC_|ARK_|DEEPSEEK_|MINIMAX_|XAI_|TOGETHER_)|(_API_KEY|_SECRET|_PASSWORD|_TOKEN|_KEY_ID)$/;
  const before = Object.keys(clean).length;
  for (const k of Object.keys(clean)) {
    if (k === 'CODEBUDDY_API_KEY') continue; // 厂家唯一要的那把，保留
    if (strip.test(k)) delete clean[k];
  }
  rtLog(`[${BOT_SLUG}-acp] 子进程环境净化 ${before}→${Object.keys(clean).length} 项（剥掉别家钥匙与内部变量）`);
  return clean;
}

/** ACP mcpServers 数组（stdio/http/sse 三形态），配置中心池直读。
 *  20:47 时代以此形态实测六域全绿（lark/openmem/生图真调有痕），是已验证的正解；
 *  09-19 夜曾误判"此路不通"换 --mcp-config 文件+--tools，反把 MCP 池杀光（见 ensureChild 注释）。 */
function buildMcpServers(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  try {
    for (const d of readCtiMcpDefs(BOT_SLUG)) {
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
  } catch (e) { rtLog(`[${BOT_SLUG}-acp] mcp 池读取失败: ${e}`); }
  return out;
}

interface WbSession { sid: string; model: string; gen?: number; }
/** 会话存档按 bot 分文件；workbuddy 自家保持 sessions-wb-acp.json 原名（存量会话存档不丢） */
const SESSIONS_BASENAME = BOT_SLUG !== 'workbuddy' ? `sessions-${BOT_SLUG}-acp.json` : 'sessions-wb-acp.json';
const MAP_FILE = (): string => path.join(
  process.env.CTI_USER_HOME || os.homedir(), '.agents-to-feishu', 'runtime', SESSIONS_BASENAME,
);

export function createWorkBuddyProvider(): RuntimeProvider {
  let child: ChildProcess | null = null;
  let startPromise: Promise<void> | null = null;
  let idc = 0;
  const pend = new Map<number, (m: Record<string, unknown>) => void>();
  // 当前 prompt 的收流器：sessionKey → 回调
  let active: { key: string; onUpdate: (u: Record<string, unknown>) => void } | null = null;
  const sessions = new Map<string, WbSession>();
  /* 工具参数快照缓存：toolCallId → {tool, input, pushed, pretty}
   * ACP 工具参数流式拼装（初始 {} → update 快照 → completed 时 undefined），
   * 必须按 id 缓存才能在终态补全参数。每轮 prompt 结束清空防泄漏。 */
  const toolSnap = new Map<string, { tool: string; input: string; pushed: boolean; pretty: string }>();
  const outTxtOf = (u: Record<string, unknown>): string | undefined =>
    u.rawOutput !== undefined ? String(JSON.stringify(u.rawOutput)).slice(0, 4000) : undefined;
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

  // ── ACP over HTTP（streamable-http，2.161 唯一可用通道）──
  let connId = '';
  const base = (): string => `http://${ACP_HOST}:${ACP_PORT}`;

  // POST /api/v1/acp/connect → connectionId（每代 serve 取一次）
  const connectAcp = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: ACP_HOST, port: ACP_PORT, path: '/api/v1/acp/connect', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-codebuddy-request': '1' } }, (res) => {
        let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
          try { const j = JSON.parse(b); if (j.connectionId) resolve(j.connectionId); else reject(new Error('connect 无 connectionId: ' + b.slice(0, 120))); }
          catch (e) { reject(new Error('connect 解析失败: ' + String(e))); }
        });
      });
      req.on('error', (e) => reject(e)); req.end();
    });

  // 发一个 JSON-RPC 请求，响应是 SSE 长连：本请求的 result 帧 resolve，期间通知帧走 onNotify。
  const acpRequest = (method: string, params: Record<string, unknown>, timeoutMs = 180000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (!connId) return reject(new Error('WB ACP 未连接'));
      const id = ++idc;
      pend.set(id, resolve);
      const req = http.request({ host: ACP_HOST, port: ACP_PORT, path: '/api/v1/acp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-codebuddy-request': '1', 'acp-connection-id': connId } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line.startsWith('event: ')) { ev = line.slice(7).trim(); }
            else if (line.startsWith('data: ')) {
              const payload = line.slice(6).trim();
              if (!payload) continue;
              let m: Record<string, unknown>; try { m = JSON.parse(payload); } catch { ev = ''; continue; }
              if (typeof m.id === 'number' && pend.has(m.id)) { const cb = pend.get(m.id)!; pend.delete(m.id); cb(m); }
              else if (m.method) { onNotify(m); }
              ev = '';
            }
          }
        });
        res.on('end', () => { /* 流自然结束，result 已 resolve */ });
        res.on('error', () => { failConn(); });
      });
      let ev = '';
      req.on('error', (e) => { failConn(); reject(new Error(`WB ACP 请求 ${method} 失败: ${String(e).slice(0, 120)}`)); });
      req.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      req.end();
      // 🔴 09-19 事故：prompt 曾同吃 180s 保险丝，长任务回合（生图/审计）没到终点先被我们枪毙。调用方给 prompt 传 15min。
      setTimeout(() => { if (pend.has(id)) { pend.delete(id); reject(new Error(`${method} 超时 ${Math.round(timeoutMs / 1000)}s`)); } }, timeoutMs);
    });

  const failConn = (): void => {
    for (const [pid, res] of [...pend]) { pend.delete(pid); res({ error: { message: 'WB ACP serve 已断' } }); }
    if (child) { hardKill(child); child = null; startPromise = null; }
    connId = '';
  };

  // 发一个无 id 的通知帧（如 session/cancel），response 不关心（仍要 drain 避免挂连接）
  const acpNotify = (method: string, params: Record<string, unknown>): void => {
    if (!connId) return;
    const req = http.request({ host: ACP_HOST, port: ACP_PORT, path: '/api/v1/acp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-codebuddy-request': '1', 'acp-connection-id': connId } }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {});
    try { req.write(JSON.stringify({ jsonrpc: '2.0', method, params })); req.end(); } catch { /* 尽力 */ }
  };
  // 业务代码沿用的旧名 → 新传输层别名（语义不变）
  const rpc = acpRequest;
  const notify = acpNotify;
  // 回一个 request 的 result（如 request_permission 放行），独立 POST，response 不关心
  const acpRespond = (id: unknown, result: Record<string, unknown>): void => {
    if (!connId) return;
    const req = http.request({ host: ACP_HOST, port: ACP_PORT, path: '/api/v1/acp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-codebuddy-request': '1', 'acp-connection-id': connId } }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {});
    try { req.write(JSON.stringify({ jsonrpc: '2.0', id, result })); req.end(); } catch { /* 尽力 */ }
  };

  // 通知/请求分发（替代旧 onLine 的 method 分支）：session/update 进收流器；request_permission 自动放行
  const onNotify = (m: Record<string, unknown>): void => {
    if (m.method === 'session/update') { active?.onUpdate((m.params as { update?: Record<string, unknown> })?.update || {}); return; }
    if (m.method === 'session/request_permission') {
      // 🔴 09-30 定罪（T-0029 验收实测撞出）：应答结构字段名 `outcomeSel` 是错的，应是 `result.outcome = { outcome:'selected', optionId }`。
      // 字段名不对，interruption-service 解析不出"批准"按拒绝处理 → 用户侧"跑 21 次工具一句话不说"。
      const opts = ((m.params as { options?: Array<{ optionId?: string }> })?.options) || [];
      const allow = opts.find((o) => /allow/i.test(String(o?.optionId || '')))?.optionId || opts[0]?.optionId || 'allow_once';
      acpRespond(m.id, { outcome: { outcome: 'selected', optionId: allow } });
      rtLog(`[${BOT_SLUG}-acp] request_permission 放行 optionId=${allow}（可选=${opts.map((o) => o?.optionId).join('|') || '无'}；bypassPermissions 已配还来问=查 mode）`);
    }
  };

  // 🔴 codebuddy 吞 SIGTERM（09-19 实锤：换代后老进程 3 代同堂堆积）——整树强杀
  const hardKill = (c: ChildProcess | null): void => {
    if (!c?.pid) return;
    try { execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' }); } catch { /* 已死 */ }
  };
  // spawn 前清掉 ACP_PORT 残留占用（上代 serve 异常没死干净时），避免 EADDRINUSE
  const killPort = (port: number): void => {
    try {
      const out = execFileSync('netstat.exe', ['-ano'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const lines = out.split('\n').filter((l) => l.includes(`:${port} `) && /LISTENING/.test(l));
      for (const l of lines) {
        const pid = l.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) { try { execFileSync('taskkill.exe', ['/T', '/F', '/PID', pid], { stdio: 'ignore' }); } catch { /* */ } }
      }
    } catch { /* 没占用或查不到都无所谓 */ }
  };

  async function ensureChild(): Promise<void> {
    // 判活：我们 spawn 的 serve 进程在 + connectionId 有效 → 直接复用
    if (child && child.exitCode === null && child.signalCode === null && connId) return;
    if (startPromise) return startPromise;
    startPromise = (async (): Promise<void> => {
      killPort(ACP_PORT);
      // 🔴 2026-10-14：2.161 起 `--acp` 的 stdio 已废，必须走 HTTP serve。父进程常驻，实测稳定。
      const cliArgs = [resolveWbCli(), '--serve', '--port', String(ACP_PORT), '--host', ACP_HOST];
      const proc = spawn(resolveManagedNode(), cliArgs, { cwd: cwdOf(), env: buildSpawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      child = proc;
      let stderr = '';
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (d: string) => {
        stderr = (stderr + d).slice(-4000);
        // 🔴 2026-10-14：serve 子进程拒答/配置错关键词实时落盘，免得下次又去抓 CLI 日志才看得到根因
        const k = d.toLowerCase();
        if (/refus|custommodel|skiprun|endpoint.*unset|has no endpoint|504|invalid params/.test(k)) {
          rtLog(`[${BOT_SLUG}-acp][serve-stderr] ${d.trim().slice(0, 300)}`);
        }
      });
      proc.on('exit', (code) => {
        rtLog(`[${BOT_SLUG}-acp] serve 子进程退出 code=${code} stderr尾=${stderr.slice(-200)}`);
        // 进程死了，在途 rpc 当场以 error 唤醒，避免卡片假死
        for (const [pid, res] of [...pend]) { pend.delete(pid); res({ error: { message: `WB ACP serve 已退出 code=${code}` } }); }
        if (child === proc) { child = null; startPromise = null; connId = ''; }
      });
      // 轮询端口直到 18753 就绪（serve 启动 + Web UI 初始化要几秒）——用 TCP 探活，不占 connectionId 额度
      const probe = (): Promise<boolean> => new Promise((res) => {
        const s = new net.Socket(); s.setTimeout(800);
        s.on('connect', () => { s.destroy(); res(true); }).on('error', () => { res(false); }).on('timeout', () => { s.destroy(); res(false); });
        s.connect(ACP_PORT, ACP_HOST);
      });
      let ready = false;
      for (let i = 0; i < 40; i++) { if (await probe()) { ready = true; break; } await new Promise((s) => setTimeout(s, 500)); }
      if (!ready) { if (child === proc) { hardKill(proc); child = null; startPromise = null; } throw new Error('WB serve 端口 18753 起不来'); }
      connId = await connectAcp();
      try {
        const r = await acpRequest('initialize', { protocolVersion: 1, clientCapabilities: {} });
        if (!r.result) throw new Error('WB ACP initialize 失败');
        rtLog(`[${BOT_SLUG}-acp] initialize OK`);
      } catch (e) {
        console.warn(`[${BOT_SLUG}-acp] initialize 失败 → 强杀当代子进程待重建: ${String(e).slice(0, 160)}`);
        rtLog(`[${BOT_SLUG}-acp] initialize 失败 → hardKill 当代待重建: ${String(e).slice(0, 160)}`);
        if (child === proc) { hardKill(proc); child = null; startPromise = null; connId = ''; }
        throw e;
      }
    })();
    try { await startPromise; } finally { if (!child) startPromise = null; }
  }

  async function newSession(workdir: string): Promise<string> {
    const r = await rpc('session/new', { cwd: workdir, mcpServers: buildMcpServers() });
    const sid = String((r.result as { sessionId?: string })?.sessionId || '');
    if (!sid) throw new Error(`WB ACP session/new 失败: ${JSON.stringify(r.error || {}).slice(0, 200)}`);
    // 🔴 2026-10-14 修：configId 必须是 permissionMode（不是 mode），否则 CLI 忽略 → 权限恒 default →
    // non-interactive 下 SandboxAgentRunInterceptor 直接 skipRun=cancelled。bypassPermissions 为有效值（CLI 日志可证）。
    try { await rpc('session/set_config_option', { sessionId: sid, configId: 'permissionMode', value: 'bypassPermissions' }); }
    catch (e) { rtLog(`[${BOT_SLUG}-acp] permissionMode 设置失败（不致命）: ${e}`); }
    try { await rpc('session/set_config_option', { sessionId: sid, configId: 'model', value: resolveModel() }); }
    catch (e) { rtLog(`[${BOT_SLUG}-acp] model 设置失败（不致命）: ${e}`); }
    return sid;
  }

  return {
    name: BOT_SLUG,
    async prepare(): Promise<void> {
      if (!fs.existsSync(resolveWbCli())) throw new Error(`CodeBuddy CLI 不存在: ${resolveWbCli()}`);
      // 官方账号模式：认证走官方登录态（CONFIG_DIR），无 key 可查
      if (!isOfficialAuth() && !resolveApiKey()) throw new Error('WB 认证 key 缺失（CODEBUDDY_API_KEY / models.json 均无）');
      await ensureChild();
    },
    async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
      const workdir = cwdOf(params.workdir);
      await ensureChild();
      // 09-19 晚间纠错：codebuddy 有真记忆系统（~/.codebuddy/projects/*/memory/MEMORY.md + 词文件），
      // session/load 重启恢复实测有效（老大亲证）。恢复 load 路径，"换代强制失忆"补丁为误判产物，废除。
      // [票 T-0028 09-29 老大验收口径「不失忆」] 与 zcode 同型病，且比它更重一档：
// 这道门历来只看"是不是 fresh"，不看"为什么 fresh"。桥侧 09-20 裁决（session.ts:141-160）
// 把「重启恢复」打成 freshReason='restore'、「用户 /new」打成 'user-new' —— 两者语义不同：
// restore ≠ 用户要重开，provider 应赎回。旧写法把重启也当 /new ⇒ wantSid 直接置空
// ⇒ 连 session/load 都不发起（唯一的"load 失败"弹卡日志在 if(wantSid) 里，所以全程零痕迹），
// 随后 :289-290 用新 sid 覆盖旧 sid ⇒ 账本层永久无门。codex 直证：sid 01a0d7b6(09-25)→01a0ec95
// (09-29 boot 后 1.6 秒)，被覆盖那条引擎档案仍在盘上。
// 修法照家族现成写法（dsh.ts:1001 / mimo.ts:522 / zcode.ts:700），不新造机制。
const reviveAllowed = !params.freshSession || params.freshReason === 'restore';
const wantSid = reviveAllowed ? (sessions.get(params.sessionKey)?.sid || '') : '';
if (params.freshSession && params.freshReason === 'restore' && wantSid) {
  rtLog(`[${BOT_SLUG}-acp] 重启恢复(restore)≠用户 /new：发起赎回 sid=${wantSid.slice(0, 8)} key=${params.sessionKey.slice(0, 8)}`);
}
      let sid = '';
      if (wantSid) {
        const loadOnce = async (): Promise<string> => {
          const r = await rpc('session/load', { sessionId: wantSid, cwd: workdir, mcpServers: buildMcpServers() });
          if (r.error) {
            const em = (r.error as { message?: string }).message;
            throw new Error(em || JSON.stringify(r.error).slice(0, 160));
          }
          return wantSid;
        };
        try {
          sid = await loadOnce();
        } catch (e) {
          // [T-0016 家法 09-27] "上一轮还在飞"≠档案丢了 → 摘掉在飞 turn 再 load，记忆原样。
          // 命中不了错误特征就维持原样落新建（codebuddy 错误措辞未经实测，不做投机分支）。
          if (isInFlightResumeError(e)) {
            sid = (await reviveInFlightSession<string>({
              label: BOT_SLUG,
              sid: wantSid,
              log: rtLog,
              cancelInFlight: async () => {
                await rpc('session/cancel', { sessionId: wantSid });
              },
              retryResume: loadOnce,
            })) || '';
          }
        }
        if (!sid) {
          params.onSessionLost?.();
          sessions.delete(params.sessionKey);
          saveMap();
          rtLog(`[${BOT_SLUG}-acp] load 真失败 key=${params.sessionKey.slice(0, 10)} → 弹卡+新建`);
        }
      }
      if (!sid) sid = await newSession(workdir);
      // 人设交付：新建会话的首条消息前置 systemPrompt（load 恢复成功的老会话不重复灌，
      // 防止长会话每轮重放纪律被当新指令）。
      // [2026-10-18] 斜杠命令轮不拼人设：拼了前缀后引擎看到的就不是 leading-slash，
      // "/compact" 之类的命令会退化成普通聊天文本（claude.ts 09-29 同款坑，这里补齐）。
      const isSlashCommand = /^\//.test(params.text.trim());
      const promptText = (!wantSid && params.systemPrompt && !isSlashCommand)
        ? `${params.systemPrompt}\n\n${params.text}`
        : params.text;
      if (!sid) throw new Error('WB ACP 无法建立会话');
      sessions.set(params.sessionKey, { sid, model: resolveModel() });
      saveMap();

      const queue: StreamEvent[] = [];
      let rtLoggedUsage = false;
      // [2026-10-14 老大令·方案1] <think> 剥离（同 dsh.ts / gemini.ts）：思考标签混正文会糊满飞书卡
      let thinkBuf = '';
      const splitThink = (text: string): void => {
        const tagStart = '<think>';
        const tagEnd = '</think>';
        if (thinkBuf) {
          thinkBuf += text;
          const endIdx = thinkBuf.indexOf(tagEnd);
          if (endIdx < 0) return;
          const thinkingText = thinkBuf.slice(tagStart.length, endIdx).trim();
          const bodyText = thinkBuf.slice(endIdx + tagEnd.length).trim();
          thinkBuf = '';
          if (thinkingText) { queue.push({ type: 'thinking', text: thinkingText }); }
          if (bodyText) { queue.push({ type: 'text', text: bodyText }); }
          return;
        }
        const s = text.indexOf(tagStart);
        if (s < 0) { queue.push({ type: 'text', text }); return; }
        const head = text.slice(0, s).trim();
        if (head) { queue.push({ type: 'text', text: head }); }
        thinkBuf = text.slice(s);
      };
      let doneMark: (() => void) | null = null;
      active = {
        key: params.sessionKey,
        onUpdate: (u) => {
          const s = String(u.sessionUpdate || '');
          if (s === 'agent_message_chunk' && (u.content as { type?: string })?.type === 'text' && (u.content as { text?: string })?.text) {
            splitThink(String((u.content as { text: string }).text));
          } else if (s === 'agent_thought_chunk' && (u.content as { type?: string })?.type === 'text' && (u.content as { text?: string })?.text) {
            queue.push({ type: 'thinking', text: String((u.content as { text: string }).text) });
          } else if (s === 'tool_call' || s === 'tool_call_update') {
            /* 🔴 2026-10-24 修「工具执行块参数是 {}」bug（老大截图实锤）：
             * codebuddy ACP 的工具参数是流式拼装的——
             *   ① tool_call 初始帧 rawInput/input 恒为 {}（就是截图里 "Read — {}" 的来源）
             *   ② tool_call_update 帧 rawInput 是逐步完整的快照（{"file_path":""} → 完整）
             *   ③ completed 帧 rawInput 变 undefined（要沿用缓存，不能丢参数）
             * 真工具名在 _meta["codebuddy.ai/toolName"]（每帧都有，title 时有时无）。
             * 修法：按 toolCallId 缓存参数快照；空参数不显示 "— {}"；
             *       in_progress/update 中间帧吞掉只更缓存，pending（参数齐+title 漂亮）才推首行，
             *       completed/failed 推终态——防半成品刷屏。 */
            const meta = (u._meta as Record<string, unknown>) || {};
            const toolName = String(meta['codebuddy.ai/toolName'] || u.title || u.kind || 'tool');
            const st = String(u.status || 'running');
            const tcid = String(u.toolCallId || '');
            let snap = toolSnap.get(tcid);
            if (!snap) { snap = { tool: toolName, input: '', pushed: false, pretty: '' }; toolSnap.set(tcid, snap); }
            const rawIn = (u.rawInput !== undefined ? u.rawInput : u.input) as Record<string, unknown> | undefined;
            if (rawIn && typeof rawIn === 'object' && Object.keys(rawIn).length > 0) {
              snap.input = JSON.stringify(rawIn).slice(0, 2000);
            }
            if (u.title && !/^[`]/.test(String(u.title)) && String(u.title) !== toolName) snap.pretty = String(u.title).slice(0, 80);
            const isTerminal = st === 'completed' || st === 'failed';
            const isPending = st === 'pending';           // pending 帧 = 参数齐 + title 人类可读
            if (!snap.pushed && (isPending || (isTerminal && snap.input))) {
              snap.pushed = true;
              queue.push({ type: 'tool', tool: snap.pretty || toolName, input: snap.input || undefined, status: 'running' });
            }
            if (isTerminal && snap.pushed) {
              queue.push({ type: 'tool', tool: snap.pretty || toolName, input: snap.input || undefined, status: st === 'completed' ? 'done' : 'error', output: outTxtOf(u) });
            }
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
            if (!rtLoggedUsage) { rtLoggedUsage = true; rtLog(`[${BOT_SLUG}-acp] usage_update 首见: used=${u.used} size=${u.size} cat=${JSON.stringify(cat).slice(0, 300)}`); }
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
        }).catch((e: unknown) => {
          const msg = String(e);
          queue.push({ type: 'error', message: `WB 回合失败: ${msg.slice(0, 200)}` });
          /* 🔴 2026-10-24 根治「900s 超时后僵尸引擎」：session/prompt 超时 = ACP 子进程
           * 活着但不回话（进程死亡路径已有 exit 兜底唤醒，唯独挂死无治）。以前超时后
           * 子进程原样留着，下一条消息 ensureChild 复用同一个僵尸 → 再挂 900s 连环坑。
           * 现在超时即强杀当代子进程，下条消息 ensureChild 自动重生新引擎。 */
          if (/超时 900s/.test(msg) && child) {
            rtLog(`[${BOT_SLUG}-acp] session/prompt 900s 超时 → 强杀挂死子进程待重生（根治僵尸引擎）`);
            console.warn(`[${BOT_SLUG}-acp] session/prompt 900s 超时 → hardKill 挂死子进程待重生`);
            hardKill(child); child = null; startPromise = null; connId = '';
            queue.push({ type: 'error', message: '引擎 15 分钟无响应已挂起，已自动重启引擎——直接重发刚才的消息即可。' });
          }
          doneMark?.();
        });
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
        toolSnap.clear();   // 每轮 prompt 结束清空工具快照缓存，防跨轮串味/泄漏
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
      startPromise = null; // 09-20 wb-1③：不清则销毁后再 ensureChild 会 await 复用的死 promise 永挂
    },
  };
}
