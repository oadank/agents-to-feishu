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
import { isInFlightResumeError, reviveInFlightSession } from './shared/revive.js';
import { resolveMcpArgPaths } from '../tools/mcp-path-resolve.js';

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

function resolveWbCli(): string {
  const custom = process.env.CTI_WB_CLI || '';
  if (custom && fs.existsSync(custom)) return custom;
  // WorkBuddy 2026-09-21 升级后 dist/codebuddy.js（TUI 包）已删，只剩 headless / lite-wb。
  // --acp 是 headless 场景，按 现行 headless → 旧 TUI → bin 启动器 顺序认。
  const root = 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli';
  const candidates = [
    root + '\\dist\\codebuddy-headless.js',
    root + '\\dist\\codebuddy.js',
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
  // [T-0028 甲方案 · 09-29 夜，只用环境变量、不改厂家任何文件] 从 CLI 自身代码里读出来的开关（398 个
  // CODEBUDDY_* 变量中筛出的）：CODEBUDDY_MODEL / CODEBUDDY_DISABLE_BUILTIN_MODELS。
  // 现象依据：CLI 日志自报 `[SettingsEndpointProductProvider] resolved endpoint=<unset> env=internal`
  // 即"回落到厂家内网路由"，随后 `Prompt refused … (target: https://wb.tencentbuddy.com)` 504 skipRun；
  // 而桥外同参数同钥匙同会话探针能正常回话 ⇒ 差别在"这一代进程开工时认定的模型/路由"。
  // 这里显式把它钉在我们自己的网关模型上，别再去厂家内网验身。若无效整段删掉即可（纯 env，可秒回滚）。
  const wbModelId = resolveModel();
  if (!clean.CODEBUDDY_MODEL) clean.CODEBUDDY_MODEL = wbModelId;
  rtLog(`[wb-acp] 甲方案钉模型: CODEBUDDY_MODEL=${clean.CODEBUDDY_MODEL}`);
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
  rtLog(`[wb-acp] 子进程环境净化 ${before}→${Object.keys(clean).length} 项（剥掉别家钥匙与内部变量）`);
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
      // 🔴 09-30 定罪（T-0029 验收实测撞出）：这里过去写的是 `outcomeSel:'selected'` —— **应答结构字段名错了**。
      // ACP 规定 `result.outcome = { outcome:'selected', optionId }`；字段名不对，它家 interruption-service
      // 解析不出"批准"，直接按拒绝处理：实测 CLI 日志 `Tool rejected in interruption-service, tool name: PowerShell`
      // → `prompt() completed with stopReason: cancelled`，用户侧表现为"跑了 21 次工具，最后一句话都不说"。
      // 另外 6 家 ACP provider（mimo/dsh/openclaw/opencode/reasonix/openakita）全都是正确写法，只这一处手误。
      // 选项也改成**按语义挑 allow**（旧写法取 opts[0]，若它把 reject 排前面就等于我们自己点了拒绝）。
      const opts = ((m.params as { options?: Array<{ optionId?: string }> })?.options) || [];
      const allow = opts.find((o) => /allow/i.test(String(o?.optionId || '')))?.optionId || opts[0]?.optionId || 'allow_once';
      try {
        child?.stdin?.write(JSON.stringify({
          jsonrpc: '2.0', id: m.id,
          result: { outcome: { outcome: 'selected', optionId: allow } },
        }) + '\n');
      } catch { /* 死了有看门狗 */ }
      rtLog(`[wb-acp] request_permission 放行 optionId=${allow}（可选=${opts.map((o) => o?.optionId).join('|') || '无'}；bypassPermissions 已配还来问=查 mode）`);
    }
  };

  async function ensureChild(): Promise<void> {
    // 票 hand-3①（对齐 ACP 六家 0317046 双尺）：判活补 signalCode。Windows 下 kill()
    // （TerminateProcess）式死亡 exitCode 恒 null、只有 signalCode 置位 —— 只判 exitCode 会把
    // 被杀型死的进程当活的复用（stdin.writable 在进程刚死时仍可能为 true），下面每轮 rpc 白等一次。
    if (child?.stdin?.writable && child.exitCode === null && child.signalCode === null) return;
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
        // 🔴 09-20 wb-1③ 自愈（8e7cf9a/caf59ff 同类病）：进程死了，所有在途 rpc 之前要干等
        // 最长 900s 保险丝才报错、卡片全程假死。现在当场以 error 响应唤醒 pend，在途轮次秒级收尾。
        for (const [pid, res] of [...pend]) { pend.delete(pid); res({ error: { message: `WB ACP 子进程已退出 code=${code}` } }); }
        if (child === proc) { child = null; startPromise = null; }
      });
      try {
        const r = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
        if (!r.result) throw new Error('WB ACP initialize 失败');
        rtLog('[wb-acp] initialize OK');
      } catch (e) {
        // 🔴 09-20 wb-1③ 根治同类病："重投 prompt 不重建进程"的变体=init 失败不清尸——
        // 原来 initialize 超时/失败后 spawn 出的 proc 仍挂在 child 上活着，下轮 ensureChild
        // 判 stdin.writable+exitCode===null 直接复用这具半死尸体，之后每轮 rpc 全部超时死循环。
        // 修法：失败即强杀当代+清把手，下条消息真重建（老大 09-20 令：先给能自愈的代码）。
        console.warn(`[wb-acp] initialize 失败 → 强杀当代子进程待重建: ${String(e).slice(0, 160)}`);
        rtLog(`[wb-acp] initialize 失败 → hardKill 当代待重建: ${String(e).slice(0, 160)}`);
        if (child === proc) { hardKill(proc); child = null; startPromise = null; }
        throw e;
      }
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
  rtLog(`[wb-acp] 重启恢复(restore)≠用户 /new：发起赎回 sid=${wantSid.slice(0, 8)} key=${params.sessionKey.slice(0, 8)}`);
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
              label: 'workbuddy',
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
      startPromise = null; // 09-20 wb-1③：不清则销毁后再 ensureChild 会 await 复用的死 promise 永挂
    },
  };
}
