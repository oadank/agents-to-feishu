#!/usr/bin/env node
/**
 * mcp-capability-check.mjs — 12 bot × mh_* / lark_* / 桌面 / 视觉 / 生图 只读体检器
 *
 * 用法（限流铁律见下，勿高峰跑全量）：
 *   node scripts/mcp-capability-check.mjs --quick claude,dsh
 *   node scripts/mcp-capability-check.mjs --quick claude --domain desktop,vision
 *   node scripts/mcp-capability-check.mjs --quick dsh --domain gen
 *   node scripts/mcp-capability-check.mjs --all --serial-slow
 *
 * --domain: mh,lark,desktop,vision,gen（默认 mh,lark）
 *
 * ⚠️ 2026-09-18：曾因 --all 叠打把 qwen3.8 并发打满。默认禁止裸 --all。
 * 只读验证：user 身份发飞书强制实调 → 限时读回复 → 打矩阵。
 * 不改任何配置、不重启服务。
 * 若 api-gate 拦 lark-cli：先在 openmem 调 mh_tool(name="飞书操作规范") 再跑。
 * 启动时自动 warm-up（吃 gate 每 CTI_BOT×域 5min 首拦），并运行时解析 p2p chat_id。
 * 撞 429/网关限流 → 立刻停，不要重试。
 *
 * 判定三态：
 *   ✅ native — 模型直接调工具成功（工具卡 + 正文给出结果；视觉须复述 CTI-PROBE-2026）
 *   ⚠️ bypass — 靠 curl :3466/mcp 或桥接代调才成
 *   ❌ fail   — 看不见工具 / unsupported call / 超时 / 空回复 / 复述错误
 *
 * 退出码：0=全通过；1=存在 ❌ 或超时。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

const USAGE =
  'node scripts/mcp-capability-check.mjs --quick b1,b2   # mh+lark\n' +
  'node scripts/mcp-capability-check.mjs --quick b1 --domain desktop,vision\n' +
  'node scripts/mcp-capability-check.mjs --all --serial-slow   # 全量（必须限流，勿在高峰跑）';

/** 团队 bot 花名册（config-center id）。chat_id 运行时从 lark chat-list 解析，不硬编码。 */
const BOT_IDS = [
  'claude', 'gemini', 'openclaw', 'reasonix', 'codex', 'openakita',
  'dsh', 'zcode', 'hermes', 'opencode', 'mimo',
];
const DEEPTUTOR_NA = 'deeptutor';
const ALL_DOMAINS = ['mh', 'lark', 'desktop', 'vision', 'gen'];
const GEN_BOTS = new Set(['dsh', 'zcode']);

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
const PROBE_DESKTOP =
  '[MiMo] 体检·桌面：请真调 win-desktop-helper 只读工具（active_window / list_apps / window_info 类），回「前台窗口名 + 窗口数」。禁止点击/按键/拖拽/截图写操作。没有工具就说：没有桌面。';
const PROBE_VISION =
  '[MiMo] 体检·视觉：请真调 visionqa/look_image OCR 或 describe，读 C:\\D\\opt\\agents-to-feishu\\team-artifacts\\probe-ocr.png，只复述图中文字（原样英文数字）。禁止 curl；没有工具就说：没有视觉。';
const PROBE_GEN =
  '[MiMo] 体检·生图：请真调 generate_image/comfy，512x512 简笔「简笔画：一只猫」，120秒内出图即算成功，回「已出图」+图片路径或 image_key。没有工具就说：没有生图。';

const PROBES = {
  mh: PROBE_MH,
  lark: PROBE_LARK,
  desktop: PROBE_DESKTOP,
  vision: PROBE_VISION,
  gen: PROBE_GEN,
};
const OCR_TEXT = 'CTI-PROBE-2026';

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
  const k0 = String(key).slice(0, 44);
  let r = await run(LARK_CLI, [
    'im', '+messages-send',
    '--chat-id', chatId,
    '--text', text,
    '--as', 'user',
    '--idempotency-key', `${k0}a0`.slice(0, 50),
  ], 45000);
  const blob = `${r.out || ''}${r.err || ''}`;
  if (looksLikeGate(blob)) {
    r = await run(LARK_CLI, [
      'im', '+messages-send',
      '--chat-id', chatId,
      '--text', text,
      '--as', 'user',
      '--idempotency-key', `${k0}a1`.slice(0, 50),
    ], 45000);
  }
  const b2 = `${r.out || ''}${r.err || ''}`;
  if (!/"ok"\s*:\s*true/i.test(b2) && /"type"\s*:\s*"validation"|invalid_argument/i.test(b2)) {
    r = await run(LARK_CLI, [
      'im', '+messages-send',
      '--chat-id', chatId,
      '--text', text,
      '--as', 'user',
      '--idempotency-key', `${k0}a2`.slice(0, 50),
    ], 45000);
  }
  return r;
}

function parseSendTimeMs(sentOut) {
  try {
    const j = JSON.parse(String(sentOut || ''));
    const ct = j?.data?.create_time;
    if (!ct) return Date.now();
    const ts = Date.parse(String(ct).replace(' ', 'T'));
    return Number.isFinite(ts) ? ts : Date.now();
  } catch {
    return Date.now();
  }
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
  if (/正在处理上一条|已自动插队/.test(t) && !/✅|成品答案|CTI-PROBE|窗口|出图|已生成/.test(t)) return false;
  if (/⏳\s*正在处理/.test(t) && !/✅|成品答案|没有 mh_|没有 lark_|没有桌面|没有视觉|没有生图|unsupported|调用成功|CTI-PROBE|窗口数|已出图|已生成/.test(t)) {
    return false;
  }
  return /成品答案|agent 花名册|GitHub 访问通道|本机环境事实速查|没有 mh_|没有 lark_|没有桌面|没有视觉|没有生图|unsupported call|调用成功|会话|群列表|count\s*[:=]|✅|❌|CTI-PROBE|窗口数|窗口名|前台窗口|已出图|出图成功|image_key/i.test(t);
}

async function waitBotReply(chatId, totalWaitMs, afterMs = 0) {
  const start = Date.now();
  let lastAll = '';
  let lastBot = '';
  let lastMeta = null;
  const pickFresh = async () => {
    const r = await larkRead(chatId, 8);
    const fresh = (r.msgs || []).filter((m) => {
      if (afterMs <= 0) return true;
      const ts = Date.parse(String(m.create_time || '').replace(' ', 'T'));
      return Number.isFinite(ts) ? ts >= afterMs - 2000 : true;
    });
    return { r, fresh, bot: pickBotReply(fresh) };
  };
  while (Date.now() - start < totalWaitMs) {
    const { r, fresh, bot } = await pickFresh();
    lastAll = r.all || r.text || '';
    lastBot = bot;
    if (lastBot && isFinalBotReply(lastBot)) {
      const hit = fresh.find((m) => String(m.content || '') === lastBot);
      lastMeta = hit ? { mid: hit.message_id, at: hit.create_time } : null;
      return { bot: lastBot, all: lastAll, meta: lastMeta };
    }
    await new Promise((res) => setTimeout(res, 8000));
  }
  const { r, fresh, bot } = await pickFresh();
  lastBot = bot;
  lastAll = r.all || r.text || '';
  const hit = fresh.find((m) => String(m.content || '') === lastBot);
  lastMeta = hit ? { mid: hit.message_id, at: hit.create_time } : null;
  return { bot: lastBot, all: lastAll, meta: lastMeta };
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
  if (/\bAPI 报错\b|BadRequestError|Process exited with code|unsupported call/i.test(t) && !hasMhNames(t)) {
    if (/unsupported call/i.test(t)) return { state: '❌', note: 'unsupported call' };
    return { state: '❌', note: 'API报错/未进工具' };
  }
  const bypass = /curl\s+(-s\s+)?-X\s+POST|127\.0\.0\.1:3466|桥接代调|callOpenmemBypass/i.test(t);
  const hasNativeTool =
    /mcp__openmem__mh_tools_list|openmem_mh_tools_list|openmem__mh_tools_list|call_mcp_tool|mh_tools_list/i.test(t) &&
    /工具执行|tool call succeeded|已调用|调用成功|✅|native/i.test(t);
  const hasNames = hasMhNames(t);
  const unsupported = /unsupported call/i.test(t);
  const noTool = /没有 mh_\*|没有 mh_|no mh_|\bNO_MCP_TOOLS\b/i.test(t);
  if (noTool && !hasNames) return { state: '❌', note: '无mh_*' };
  if (unsupported && !hasNames) return { state: '❌', note: 'unsupported call' };
  if (hasNames && hasNativeTool && !bypass) return { state: '✅', note: 'native' };
  if (hasNames && bypass) return { state: '⚠️', note: 'curl/绕过' };
  if (hasNames) return { state: '✅', note: '有结果(未明示工具名)' };
  if (hasNativeTool && !bypass) return { state: '⏳', note: 'tool-ok-names-pending' };
  if (bypass && !hasNames) return { state: '⚠️', note: '仅curl/无成品名' };
  return { state: '❌', note: '未命中mh判定' };
}

function hasMhNames(t) {
  return /agent 花名册|GitHub 访问通道|本机环境事实速查/i.test(String(t || ''));
}

function judgeLark(raw) {
  const t = stripTags(raw);
  if (!t.trim()) return { state: '❌', note: 'timeout/empty' };
  if (/api-gate|拦下：这是飞书/i.test(t)) return { state: '❌', note: 'api-gate拦门' };
  // 模型层 API 报错（未进工具层）按 fail，不进 hasResult
  if (/\bAPI 报错\b|BadRequestError|Process exited with code/i.test(t)) {
    return { state: '❌', note: 'API报错/未进工具' };
  }
  const bypass = /curl\s|127\.0\.0\.1:135|http:\/\/127\.0\.0\.1/i.test(t) && /lark|chat/i.test(t);
  const hasNative =
    /lark_list_chats|mcp__cti-builtin__lark|cti_builtin__lark|cti-builtin__lark/i.test(t) &&
    /工具执行|调用成功|✅|tool/i.test(t);
  // 只认会话计数/列表结果；不拿状态栏里的 bot 名当结果（防 Codex/Reasnix 等误报）
  const hasResult = /\d+\s*(个)?(会话|聊天|群)|count\s*[:=]\s*\d+|共\s*\d+/i.test(t) ||
    /前\s*\d+\s*(个)?(会话|聊天|群)|团队群[A-Z]|群聊）/i.test(t);
  const noTool = /没有 lark_|no lark_/i.test(t);
  if (noTool) return { state: '❌', note: '无lark_*' };
  if (hasNative && hasResult && !bypass) return { state: '✅', note: 'native' };
  if (hasResult && bypass) return { state: '⚠️', note: 'curl/绕过' };
  if (hasResult) return { state: '✅', note: '有会话结果' };
  if (hasNative) return { state: '✅', note: '工具调用成功' };
  if (/\bAPI 报错\b|BadRequestError|unsupported call/i.test(t)) {
    return { state: '❌', note: 'API报错/未进工具' };
  }
  return { state: '❌', note: '未命中lark判定' };
}

function judgeDesktop(raw) {
  const t = stripTags(raw);
  if (!t.trim()) return { state: '❌', note: 'timeout/empty' };
  if (/api-gate|拦下：这是飞书/i.test(t)) return { state: '❌', note: 'api-gate拦门' };
  if (/\bAPI 报错\b|BadRequestError|Process exited with code/i.test(t)) {
    return { state: '❌', note: 'API报错/未进工具' };
  }
  const noTool = /没有桌面|no desktop|没有 win-desktop/i.test(t);
  if (noTool) return { state: '❌', note: '无桌面' };
  const toolHit =
    /active_window|list_apps|window_info|win_desktop|win-desktop-helper|窗口数|前台窗口/i.test(t) &&
    /工具执行|调用成功|✅|tool|窗口/i.test(t);
  const hasCount = /\d+\s*个窗口|窗口数\s*[:：]?\s*\d+|共\s*\d+\s*个|windows?\s*[:=]\s*\d+/i.test(t);
  const hasName = /前台窗口|active|front|title\s*[:=]/i.test(t) && /[A-Za-z一-鿿]/.test(t);
  if ((hasCount || hasName) && toolHit) return { state: '✅', note: 'native' };
  if (hasCount || (hasName && /窗口/.test(t))) return { state: '✅', note: '有窗口结果' };
  if (toolHit) return { state: '⏳', note: 'tool-ok-result-pending' };
  if (/unsupported call/i.test(t)) return { state: '❌', note: 'unsupported call' };
  return { state: '❌', note: '未命中desktop判定' };
}

function judgeVision(raw) {
  const t = stripTags(raw);
  if (!t.trim()) return { state: '❌', note: 'timeout/empty' };
  if (/api-gate|拦下：这是飞书/i.test(t)) return { state: '❌', note: 'api-gate拦门' };
  if (/\bAPI 报错\b|BadRequestError|Process exited with code/i.test(t)) {
    return { state: '❌', note: 'API报错/未进工具' };
  }
  const noTool = /没有视觉|no vision|没有 visionqa|没有 look_image/i.test(t);
  if (noTool) return { state: '❌', note: '无视觉' };
  // 复述对 OCR 文本才算过；差一个字符不算
  const saidOk = t.includes(OCR_TEXT);
  const toolHit =
    /look_image|visionqa|ocr|describe|视觉/i.test(t) &&
    /工具执行|调用成功|✅|tool|复述|图中/i.test(t);
  if (saidOk && (toolHit || true)) return { state: '✅', note: 'native·复述正确' };
  if (saidOk) return { state: '✅', note: '复述正确' };
  if (toolHit && !saidOk) return { state: '❌', note: '复述不符(非CTI-PROBE-2026)' };
  if (/unsupported call/i.test(t)) return { state: '❌', note: 'unsupported call' };
  return { state: '❌', note: '未命中vision判定' };
}

function judgeGen(raw) {
  const t = stripTags(raw);
  if (!t.trim()) return { state: '❌', note: 'timeout/empty' };
  if (/api-gate|拦下：这是飞书/i.test(t)) return { state: '❌', note: 'api-gate拦门' };
  if (/\bAPI 报错\b|BadRequestError|Process exited with code/i.test(t)) {
    return { state: '❌', note: 'API报错/未进工具' };
  }
  const noTool = /没有生图|no gen|没有 generate_image|没有 comfy|XDN 关机/i.test(t);
  if (noTool) return { state: '❌', note: '无生图/引擎不在线' };
  const saidOk = /已出图|出图成功|image_key|generated successfully|图片已生成|\.png|\.jpg/i.test(t) &&
    /猫|简笔|512|出图|生成/i.test(t);
  const toolHit =
    /generate_image|comfy__generate|cti_builtin__generate|mcp__.*generate/i.test(t) &&
    /工具执行|调用成功|✅|tool/i.test(t);
  if (saidOk && toolHit) return { state: '✅', note: 'native' };
  if (saidOk) return { state: '✅', note: '已出图' };
  if (toolHit) return { state: '⏳', note: 'tool-ok-image-pending' };
  if (/timeout|超时|120s/i.test(t)) return { state: '❌', note: '超时' };
  if (/unsupported call/i.test(t)) return { state: '❌', note: 'unsupported call' };
  return { state: '❌', note: '未命中gen判定' };
}

const JUDGES = {
  mh: judgeMh,
  lark: judgeLark,
  desktop: judgeDesktop,
  vision: judgeVision,
  gen: judgeGen,
};

function defaultWaitMs(kind) {
  if (kind === 'gen') return 130000;
  if (kind === 'vision' || kind === 'desktop') return 70000;
  return 50000;
}

async function probeBot(name, chatId, kind, waitMs) {
  const text = PROBES[kind];
  if (!text) return { state: '❌', note: `未知域:${kind}`, snippet: '' };
  // lark-cli: idempotency-key ≤50 chars
  const key = `mc${kind[0]}${name.slice(0, 6)}${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    .replace(/-/g, '').slice(0, 44);
  const sent = await larkSend(chatId, text, key);
  const sentBlob = `${sent.out || ''}${sent.err || ''}`;
  if (/拦下|api-gate/i.test(sentBlob)) {
    return { state: '❌', note: 'api-gate拦门(send)', snippet: 'gate' };
  }
  if (!/"ok"\s*:\s*true/i.test(sentBlob) && !sent.ok) {
    return { state: '❌', note: `send失败:${(sent.err || sent.out || '').slice(0, 70)}`, snippet: '' };
  }
  const afterMs = parseSendTimeMs(sent.out);
  const { bot, all, meta } = await waitBotReply(chatId, waitMs, afterMs);
  const blob = bot || all || '';
  if (/拦下|api-gate/i.test(blob)) {
    return { state: '❌', note: 'api-gate拦门(read)', snippet: 'gate', mid: meta?.mid, at: meta?.at };
  }
  if (!stripTags(bot).trim()) {
    return { state: '❌', note: '无bot回复/超时', snippet: stripTags(all).slice(0, 40), mid: meta?.mid, at: meta?.at };
  }
  let judge = (JUDGES[kind] || judgeMh)(blob);
  // 流式卡片：工具卡已出但正文未到 → 再等一轮复读一次
  if (judge.state === '⏳') {
    await new Promise((r) => setTimeout(r, 6000));
    const again = await waitBotReply(chatId, 15000, afterMs);
    const blob2 = again.bot || again.all || '';
    judge = (JUDGES[kind] || judgeMh)(blob2);
    if (judge.state === '⏳') judge = { state: '✅', note: 'native(tool-ok)' };
    if (again.meta?.mid) {
      return { ...judge, snippet: stripTags(again.bot || bot).slice(0, 72), mid: again.meta.mid, at: again.meta.at };
    }
  }
  return { ...judge, snippet: stripTags(bot).slice(0, 72), mid: meta?.mid, at: meta?.at };
}

function parseArgs(argv) {
  const args = { mode: 'quick', bots: null, wait: 50000, gap: 15000, serialSlow: false, domains: ['mh', 'lark'] };
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
    } else if (a === '--domain' || a === '--domains') {
      const list = argv[i + 1];
      if (list && !list.startsWith('--')) {
        args.domains = list.split(',').map((s) => s.trim()).filter((s) => ALL_DOMAINS.includes(s));
        i++;
      }
      if (!args.domains.length) {
        console.error(`--domain 需要: ${ALL_DOMAINS.join(',')}`);
        process.exit(2);
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

  console.log(`模式=${args.mode} wait=${args.wait}ms gap=${args.gap}ms bots=${names.length} domains=${args.domains.join(',')}`);
  console.log('解析 chat_id（config-center + lark chat-list 运行时）…');
  const { map: BOTS } = await resolveBotChatIds();
  console.log(`chat_id 就绪: ${Object.keys(BOTS).length} 个（warm-up 已吃 gate 首拦）`);
  console.log('');
  const head = args.domains.map((d) => d === 'mh' ? 'mh_*' : d === 'lark' ? 'lark_*' : d);
  console.log(`| bot | ${head.join(' | ')} | 备注 |`);
  console.log(`|-----|${head.map(() => '---').join('|')}|------|`);

  const rows = [];
  let failCount = 0;

  for (const name of names) {
    if (name === DEEPTUTOR_NA) {
      console.log(`| ${name} | ${head.map(() => 'N/A').join(' | ')} | 无团队bot p2p；服务侧MCP另查 |`);
      rows.push({ name, fail: false, cells: Object.fromEntries(args.domains.map((d) => [d, 'N/A'])) });
      continue;
    }
    const chatId = BOTS[name];
    if (!chatId) {
      console.log(`| ${name} | ${head.map(() => '❌').join(' | ')} | chat_id 解析缺失 |`);
      failCount++;
      rows.push({ name, fail: true, note: 'chat_id missing', cells: Object.fromEntries(args.domains.map((d) => [d, '❌'])) });
      continue;
    }
    const cells = {};
    const notes = [];
    let botFail = false;
    let i = 0;
    for (const kind of args.domains) {
      if (kind === 'gen' && !GEN_BOTS.has(name)) {
        cells[kind] = 'N/A';
        notes.push('gen:N/A');
        continue;
      }
      if (i > 0) await new Promise((r) => setTimeout(r, args.gap));
      process.stdout.write(`… ${name} ${kind} `);
      const waitMs = kind === 'mh' || kind === 'lark'
        ? (kind === 'mh' || kind === 'lark' ? Math.min(args.wait, defaultWaitMs(kind)) || defaultWaitMs(kind) : args.wait)
        : defaultWaitMs(kind);
      const w = (kind === 'mh' || kind === 'lark') ? args.wait : defaultWaitMs(kind);
      const r = await probeBot(name, chatId, kind, w);
      cells[kind] = r.state;
      notes.push(`${kind}:${r.note}${r.mid ? '@' + r.at + '/' + r.mid.slice(-8) : ''}`);
      if (r.state === '❌') botFail = true;
      console.log(`${r.state}${r.mid ? ' ' + r.mid : ''}`);
      i++;
    }
    const note = notes.join(' ');
    console.log(`| ${name} | ${args.domains.map((d) => cells[d]).join(' | ')} | ${note.replace(/\|/g, '/')} |`);
    if (botFail) failCount++;
    rows.push({ name, cells, note, fail: botFail });
    if (args.gap > 0) await new Promise((r) => setTimeout(r, args.gap));
  }

  console.log('');
  const okDomain = (d) => rows.filter((r) => r.cells?.[d] === '✅').length;
  console.log(`结果: ${args.domains.map((d) => `${d}=${okDomain(d)}✅`).join(' ')} · 失败项=${failCount}`);
  console.log(failCount === 0 ? 'PASS' : 'FAIL');
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(3);
});
