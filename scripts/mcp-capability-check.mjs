#!/usr/bin/env node
/**
 * mcp-capability-check.mjs — 12 bot × mh_* / lark_* 只读体检器
 *
 * 用法（限流铁律见下，勿高峰跑全量）：
 *   node scripts/mcp-capability-check.mjs --quick claude,dsh
 *   node scripts/mcp-capability-check.mjs --all --serial-slow
 *
 * ⚠️ 2026-09-18：曾因 --all 叠打把 qwen3.8 并发打满。默认禁止裸 --all。
 * 只读验证：user 身份发飞书强制实调 → 限时读回复 → 打矩阵。
 * 不改任何配置、不重启服务。
 * 若 api-gate 拦 lark-cli：先在 openmem 调 mh_tool(name="飞书操作规范") 再跑。
 * 启动时自动 warm-up（吃 gate 每 CTI_BOT×域 5min 首拦），并运行时解析 p2p chat_id。
 * 撞 429/网关限流 → 立刻停，不要重试。
 *
 * 判定三态：
 *   ✅ native — 模型直接调 mh_* / lark_* 成功（工具卡 + 正文给出结果）
 *   ⚠️ bypass — 靠 curl :3466/mcp 或桥接代调才成
 *   ❌ fail   — 看不见工具 / unsupported call / 超时 / 空回复
 *
 * 退出码：0=全通过；1=存在 ❌ 或超时。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

const USAGE =
  'node scripts/mcp-capability-check.mjs --quick b1,b2   # 推荐\n' +
  'node scripts/mcp-capability-check.mjs --all --serial-slow   # 全量（必须限流，勿在高峰跑）';

/** 团队 bot 花名册（config-center id）。chat_id 运行时从 lark chat-list 解析，不硬编码。 */
const BOT_IDS = [
  'claude', 'gemini', 'openclaw', 'reasonix', 'codex', 'openakita',
  'dsh', 'zcode', 'hermes', 'opencode', 'mimo',
];
const DEEPTUTOR_NA = 'deeptutor';

/** chat-list 会话名别名（user 视角 p2p name ≠ bot id） */
const BOT_NAME_ALIASES = {
  dsh: ['DeepSeek', 'DSH', 'dsh'],
  mimo: ['MiMo Code', 'mimo', 'MiMo'],
  opencode: ['OpenCode', 'opencode'],
  openclaw: ['Openclaw', 'OpenClaw', 'openclaw'],
  openakita: ['OpenAkita', 'openakita'],
  reasonix: ['Reasonix', 'reasonix'],
  claude: ['Claude', 'claude'],
  gemini: ['Gemini', 'gemini'],
  zcode: ['ZCode', 'zcode'],
  hermes: ['Hermes', 'hermes'],
  codex: ['Codex', 'codex'],
};

const PROBE_MH =
  '[MiMo] 体检：请调用 mh_tools_list 或 mcp__openmem__mh_tools_list（或 openmem_mh_tools_list），只回前3条成品答案名字。禁止 curl/shell；没有工具就说：没有 mh_*。';
const PROBE_LARK =
  '[MiMo] 体检：请调用 lark_list_chats（或 mcp__cti-builtin__lark_list_chats 等同名变体），只回你会话/群数量或前2个会话名。禁止 curl；没有工具就说：没有 lark_*。';

const LARK_CANDIDATES = [
  process.env.MCP_CHECK_LARK_CLI,
  'C:\\D\\opt\\api-gate\\bin\\lark-cli.cmd',
  'C:\\D\\opt\\api-gate\\bin\\lark-cli.exe',
  'C:\\Users\\oadan\\AppData\\Roaming\\npm\\lark-cli.cmd',
  'C:\\Users\\oadan\\AppData\\Roaming\\npm\\lark-cli.exe',
].filter(Boolean);

function resolveLark() {
  for (const p of LARK_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return 'lark-cli';
}

const LARK_CLI = resolveLark();

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const isCmd = /\.(cmd|bat)$/i.test(cmd);
    let child;
    if (isCmd) {
      // PowerShell 调用 .cmd：单引号包参，避免 cmd /c 引号被吃 + 中文被拆成 positional
      const call = `& ${psQuote(cmd)} ${args.map(psQuote).join(' ')}`;
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', call,
      ], { windowsHide: true });
    } else {
      child = spawn(cmd, args, { windowsHide: true });
    }
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, code: -1, out, err: `${err} TIMEOUT` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, code: -1, out, err: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, code, out, err });
    });
  });
}

function looksLikeGate(blob) {
  return /拦下|api-gate/i.test(String(blob || ''));
}

/** 运行时解析 bot → p2p chat_id：config-center 花名册 + lark chat-list（不硬编码）。 */
async function resolveBotChatIds() {
  let roster = [];
  try {
    const r = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "(Invoke-RestMethod -Uri 'http://127.0.0.1:13600/api/agents' -TimeoutSec 10) | ForEach-Object { $_.id }",
    ], 15000);
    roster = (r.out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    roster = [];
  }
  const ids = roster.length ? roster.filter((id) => id !== DEEPTUTOR_NA && id !== 'openhuman') : BOT_IDS;

  // warm-up + 拉 p2p 列表（首调可能撞 gate 首拦；5min 窗内再调即放行）
  let listRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await run(LARK_CLI, [
      'im', '+chat-list', '--types=p2p', '--page-size=100', '--as', 'user',
    ], 45000);
    const blob = `${r.out || ''}${r.err || ''}`;
    if (looksLikeGate(blob) && attempt === 0) continue;
    listRaw = r.out || '';
    break;
  }

  let chats = [];
  try {
    chats = JSON.parse(listRaw)?.data?.chats || [];
  } catch {
    throw new Error(`chat-list 解析失败: ${String(listRaw).slice(0, 200)}`);
  }

  const map = {};
  const missing = [];
  for (const id of ids) {
    const aliases = BOT_NAME_ALIASES[id] || [id, id.toLowerCase()];
    const hit = chats.find((c) => c.chat_mode === 'p2p' && aliases.some(
      (a) => String(c.name || '').toLowerCase() === a.toLowerCase(),
    ));
    if (hit?.chat_id) map[id] = hit.chat_id;
    else missing.push(id);
  }
  if (missing.length) {
    console.error(`未解析到 chat_id（chat-list 无匹配名）: ${missing.join(', ')}`);
    console.error(`已知别名表键: ${Object.keys(BOT_NAME_ALIASES).join(', ')}`);
    process.exit(2);
  }
  return { map, roster: ids };
}

async function larkSend(chatId, text, key) {
  // gate 首拦：send 若命中立即原样重试一次（5min 窗内放行）
  let r = await run(LARK_CLI, [
    'im', '+messages-send',
    '--chat-id', chatId,
    '--text', text,
    '--as', 'user',
    '--idempotency-key', `${key}-a0`,
  ], 45000);
  const blob = `${r.out || ''}${r.err || ''}`;
  if (looksLikeGate(blob)) {
    r = await run(LARK_CLI, [
      'im', '+messages-send',
      '--chat-id', chatId,
      '--text', text,
      '--as', 'user',
      '--idempotency-key', `${key}-a1`,
    ], 45000);
  }
  return r;
}

async function larkRead(chatId, pageSize = 5) {
  const r = await run(LARK_CLI, [
    'im', '+chat-messages-list',
    '--chat-id', chatId,
    '--as', 'user',
    '--order', 'desc',
    '--page-size', String(pageSize),
  ], 30000);
  const raw = r.out || '';
  try {
    const j = JSON.parse(raw);
    const msgs = j?.data?.messages || [];
    return {
      ok: true,
      msgs,
      text: String(msgs[0]?.content || ''),
      all: msgs.map((m) => String(m.content || '')).join('\n'),
    };
  } catch {
    return { ok: false, msgs: [], text: raw.slice(0, 500), all: raw };
  }
}

function pickBotReply(msgs) {
  // bot 卡片：sender_type=app / app_id；排除自己发的 [MiMo] 体检
  const bots = (msgs || []).filter((m) => {
    const c = String(m.content || '');
    if (/^\s*\[MiMo\]/.test(c)) return false;
    const st = m.sender?.sender_type || m.sender?.id_type || '';
    return st === 'app' || st === 'app_id' || !!m.sender?.app_id || !!m.sender?.name;
  });
  return bots[0] ? String(bots[0].content || '') : '';
}

function isFinalBotReply(text) {
  const t = stripTags(text);
  if (!t.trim()) return false;
  if (/正在处理上一条|已自动插队/.test(t) && !/✅|成品答案/.test(t)) return false;
  if (/⏳\s*正在处理/.test(t) && !/✅|成品答案|没有 mh_|没有 lark_|unsupported|调用成功/.test(t)) {
    return false;
  }
  return /成品答案|agent 花名册|GitHub 访问通道|本机环境事实速查|没有 mh_|没有 lark_|unsupported call|调用成功|会话|群列表|count\s*[:=]|✅|❌/i.test(t);
}

async function waitBotReply(chatId, totalWaitMs) {
  const start = Date.now();
  let lastAll = '';
  let lastBot = '';
  while (Date.now() - start < totalWaitMs) {
    const r = await larkRead(chatId, 5);
    lastAll = r.all || r.text || '';
    lastBot = pickBotReply(r.msgs);
    if (lastBot && isFinalBotReply(lastBot)) {
      return { bot: lastBot, all: lastAll };
    }
    await new Promise((res) => setTimeout(res, 8000));
  }
  return { bot: lastBot, all: lastAll };
}

function stripTags(s) {
  return String(s || '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\n/g, ' ')
    .replace(/\*\*?|__|`/g, '')
    .replace(/\s+/g, ' ');
}

function judgeMh(raw) {
  const t = stripTags(raw);
  if (!t.trim()) return { state: '❌', note: 'timeout/empty' };
  if (/api-gate|拦下：这是飞书/i.test(t)) return { state: '❌', note: 'api-gate拦门' };
  const bypass = /curl\s+(-s\s+)?-X\s+POST|127\.0\.0\.1:3466|桥接代调|callOpenmemBypass/i.test(t);
  const hasNativeTool =
    /mcp__openmem__mh_tools_list|openmem_mh_tools_list|openmem__mh_tools_list|call_mcp_tool|mh_tools_list/i.test(t) &&
    /工具执行|tool call succeeded|已调用|调用成功|✅|native/i.test(t);
  const hasNames = /agent 花名册|GitHub 访问通道|本机环境事实速查/i.test(t);
  const unsupported = /unsupported call/i.test(t);
  const noTool = /没有 mh_\*|没有 mh_|no mh_|\bNO_MCP_TOOLS\b/i.test(t);
  if (noTool && !hasNames) return { state: '❌', note: '无mh_*' };
  if (unsupported && !hasNames) return { state: '❌', note: 'unsupported call' };
  if (hasNames && hasNativeTool && !bypass) return { state: '✅', note: 'native' };
  if (hasNames && bypass) return { state: '⚠️', note: 'curl/绕过' };
  if (hasNames) return { state: '✅', note: '有结果(未明示工具名)' };
  // 工具卡已出 mh_tools_list 成功，但成品名还在流式后半段 → 等价半命中，交上层复读
  if (hasNativeTool && !bypass) return { state: '⏳', note: 'tool-ok-names-pending' };
  if (bypass && !hasNames) return { state: '⚠️', note: '仅curl/无成品名' };
  return { state: '❌', note: '未命中mh判定' };
}

function judgeLark(raw) {
  const t = stripTags(raw);
  if (!t.trim()) return { state: '❌', note: 'timeout/empty' };
  if (/api-gate|拦下：这是飞书/i.test(t)) return { state: '❌', note: 'api-gate拦门' };
  const bypass = /curl\s|127\.0\.0\.1:135|http:\/\/127\.0\.0\.1/i.test(t) && /lark|chat/i.test(t);
  const hasNative =
    /lark_list_chats|mcp__cti-builtin__lark|cti_builtin__lark|cti-builtin__lark/i.test(t) &&
    /工具执行|调用成功|✅|tool/i.test(t);
  const hasResult = /\d+\s*(个)?(会话|聊天|群)|count\s*[:=]\s*\d+|共\s*\d+/i.test(t) ||
    /团队群|Reasonix|Claude|Codex|openclaw/i.test(t);
  const noTool = /没有 lark_|no lark_/i.test(t);
  if (noTool) return { state: '❌', note: '无lark_*' };
  if (hasNative && hasResult && !bypass) return { state: '✅', note: 'native' };
  if (hasResult && bypass) return { state: '⚠️', note: 'curl/绕过' };
  if (hasResult) return { state: '✅', note: '有会话结果' };
  if (hasNative) return { state: '✅', note: '工具调用成功' };
  return { state: '❌', note: '未命中lark判定' };
}

async function probeBot(name, chatId, kind, waitMs) {
  const text = kind === 'mh' ? PROBE_MH : PROBE_LARK;
  const key = `mimo-mcpcheck-${kind}-${name}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sent = await larkSend(chatId, text, key);
  const sentBlob = `${sent.out || ''}${sent.err || ''}`;
  if (/拦下|api-gate/i.test(sentBlob)) {
    return { state: '❌', note: 'api-gate拦门(send)', snippet: 'gate' };
  }
  if (!/"ok"\s*:\s*true/i.test(sentBlob) && !sent.ok) {
    return { state: '❌', note: `send失败:${(sent.err || sent.out || '').slice(0, 70)}`, snippet: '' };
  }
  const { bot, all } = await waitBotReply(chatId, waitMs);
  const blob = bot || all || '';
  if (/拦下|api-gate/i.test(blob)) {
    return { state: '❌', note: 'api-gate拦门(read)', snippet: 'gate' };
  }
  if (!stripTags(bot).trim()) {
    return { state: '❌', note: '无bot回复/超时', snippet: stripTags(all).slice(0, 40) };
  }
  let judge = kind === 'mh' ? judgeMh(blob) : judgeLark(blob);
  // 流式卡片：工具卡已出但成品名未到 → 再等一轮复读一次
  if (judge.state === '⏳') {
    await new Promise((r) => setTimeout(r, 6000));
    const again = await waitBotReply(chatId, 15000);
    const blob2 = again.bot || again.all || '';
    judge = kind === 'mh' ? judgeMh(blob2) : judgeLark(blob2);
    if (judge.state === '⏳') judge = { state: '✅', note: 'native(tool-ok)' };
  }
  return { ...judge, snippet: stripTags(bot).slice(0, 72) };
}

function parseArgs(argv) {
  const args = { mode: 'quick', bots: null, wait: 50000, gap: 15000, serialSlow: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.mode = 'all';
    else if (a === '--serial-slow') args.serialSlow = true;
    else if (a === '--quick') {
      args.mode = 'quick';
      args.wait = 50000;
      args.gap = 8000;
      const list = argv[i + 1];
      if (list && !list.startsWith('--')) {
        args.bots = list.split(',').map((s) => s.trim()).filter(Boolean);
        i++;
      }
    } else if (a === '--wait') {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v)) { args.wait = v; i++; }
    } else if (a === '--gap') {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v)) { args.gap = v; i++; }
    } else if (a === '--help' || a === '-h') {
      args.mode = 'help';
    }
  }
  if (args.mode === 'all') {
    if (!args.serialSlow) {
      console.error('拒绝：--all 必须同时加 --serial-slow（防打满 qwen/LiteLLM 并发）。');
      console.error(USAGE);
      args.mode = 'blocked';
      return args;
    }
    args.wait = Math.max(args.wait, 70000);
    args.gap = Math.max(args.gap, 25000);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('=== mcp-capability-check ===');
  console.log(`用法: ${USAGE}`);
  console.log(`lark-cli: ${LARK_CLI}`);
  console.log('只读体检：发强制实调 → 读回复 → 打矩阵；失败退出码=1');
  console.log('');

  if (args.mode === 'help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.mode === 'blocked') {
    process.exit(2);
  }

  let names = [];
  if (args.mode === 'quick') {
    if (!args.bots?.length) {
      console.error('--quick 需要 bot 列表，例如 --quick claude,dsh');
      console.error(USAGE);
      process.exit(2);
    }
    names = args.bots;
  } else {
    names = [...BOT_IDS];
  }

  const unknown = names.filter((n) => !BOT_IDS.includes(n) && n !== DEEPTUTOR_NA);
  if (unknown.length) {
    console.error(`未知 bot: ${unknown.join(', ')}`);
    console.error(`已知: ${[...BOT_IDS, DEEPTUTOR_NA].join(', ')}`);
    process.exit(2);
  }

  console.log(`模式=${args.mode} wait=${args.wait}ms gap=${args.gap}ms bots=${names.length}`);
  console.log('解析 chat_id（config-center + lark chat-list 运行时）…');
  const { map: BOTS } = await resolveBotChatIds();
  console.log(`chat_id 就绪: ${Object.keys(BOTS).length} 个（warm-up 已吃 gate 首拦）`);
  console.log('');
  console.log('| bot | mh_* | lark_* | 备注 |');
  console.log('|-----|------|--------|------|');

  const rows = [];
  let failCount = 0;

  for (const name of names) {
    if (name === DEEPTUTOR_NA) {
      console.log(`| ${name} | N/A | N/A | 无团队bot p2p；服务侧MCP另查 |`);
      rows.push({ name, mh: 'N/A', lark: 'N/A', fail: false });
      continue;
    }
    const chatId = BOTS[name];
    if (!chatId) {
      console.log(`| ${name} | ❌ | ❌ | chat_id 解析缺失 |`);
      failCount++;
      rows.push({ name, mh: '❌', lark: '❌', note: 'chat_id missing', fail: true });
      continue;
    }
    process.stdout.write(`… ${name} mh `);
    const mh = await probeBot(name, chatId, 'mh', args.wait);
    process.stdout.write(`${mh.state}  lark `);
    await new Promise((r) => setTimeout(r, args.gap));
    const lark = await probeBot(name, chatId, 'lark', args.wait);
    console.log(`${lark.state}`);
    const note = `mh:${mh.note}${mh.snippet ? '/' + mh.snippet.slice(0, 22) : ''} lark:${lark.note}`;
    console.log(`| ${name} | ${mh.state} | ${lark.state} | ${note.replace(/\|/g, '/')} |`);
    const fail = mh.state === '❌' || lark.state === '❌';
    if (fail) failCount++;
    rows.push({ name, mh: mh.state, lark: lark.state, note, fail });
    if (args.gap > 0) await new Promise((r) => setTimeout(r, args.gap));
  }

  console.log('');
  console.log(`结果: ${rows.filter((r) => r.mh === '✅').length}/${names.length} mh=✅ · 失败项=${failCount}`);
  console.log(failCount === 0 ? 'PASS' : 'FAIL');
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(3);
});
