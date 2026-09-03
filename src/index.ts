/**
 * agents-to-feishu 入口 —— 装配 + 启动。
 *
 * 事件订阅模式：WebSocket 长连接（飞书官方 SDK WSClient + EventDispatcher）。
 * 消息进来 → 鉴权 → 命令判断 → 引擎处理。
 */

import lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { FeishuClient } from './feishu/client.js';
import { SessionManager } from './bridge/session.js';
import { MessageEngine } from './bridge/engine.js';
import { createDshProvider } from './providers/dsh.js';
import { createDeeptutorProvider } from './providers/deeptutor.js';
import { createOpenClawProvider } from './providers/openclaw.js';
import { createOpencodeProvider } from './providers/opencode.js';
import { createReasonixProvider } from './providers/reasonix.js';
import { createMiMoProvider } from './providers/mimo.js';
import { createOpenAkitaProvider } from './providers/openakita.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createHermesProvider } from './providers/hermes.js';
import { createCodexProvider } from './providers/codex.js';
import { createClaudeProvider } from './providers/claude.js';
import { handleCommand } from './commands.js';
import type { RuntimeProvider } from './providers/types.js';
import { transcribe } from './voice/asr.js';
import { lookImage } from './vision/look.js';
import { DEFAULT_SPEECH, readStore } from './config-center/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendAsUserToBot } from './tools/lark-tools.js';
import { registerPending, consumePending, manualReceiptRecent } from './bridge/auto-receipt.js';

// ── pending 图片（对齐 agents-to-im：先发图，文本到达后合并）──
// key = chatId；收到图片先挂号提醒补文本，收到文本时把图片路径合并给 agent（agent 用 look_image 按需求看图）
const pendingImages = new Map<string, { imagePath: string; messageId: string; ts: number }>();
const PENDING_IMG_TTL_MS = 10 * 60 * 1000; // 10 分钟未补文本自动过期
/** 下载中的图片任务（chatId → job）：修复"文字跑在图片下载前面"的竞态，文字先到时等它落盘 */
const pendingImageJobs = new Map<string, Promise<string | null>>();
/** 文字侧已决定等待/合并的 chat：图片落盘后跳过"请发送文字需求"提醒（避免答案之后才收到提醒） */
const pendingImageConsumed = new Set<string>();

/** 清理过期的 pending 图片 */
function prunePendingImages(now = Date.now()): void {
  for (const [k, v] of pendingImages) {
    if (now - v.ts > PENDING_IMG_TTL_MS) pendingImages.delete(k);
  }
}

// ── 看图"桥接代劳"（2026-08-30 能力配齐：对齐 claude/dsh 标杆）──
// claude（SDK 进程内工具）/ dsh（ACP 插件）自带 look_image，路径注入即可；
// 其余 runtime 的 CLI 没有看图工具 ⇒ 桥接 pre 代劳：先 look_image 识别，把描述注入 prompt。
function hasBuiltinVision(): boolean {
  try {
    const bot = process.env.CTI_BOT || '';
    const agent = readStore().agents.find((a) => a.id === bot);
    const rt = agent?.runtime || 'dsh';
    return rt === 'claude' || rt === 'dsh';
  } catch {
    return false;
  }
}

/** 图片注入文本：自带看图工具的给路径（agent 自己调 look_image）；其余桥接代劳识别后注入描述 */
async function imagePromptFor(imagePath: string): Promise<string> {
  const pathOnly = `[用户附了一张图片，本地路径: ${imagePath}]`;
  if (hasBuiltinVision()) return pathOnly;
  try {
    const r = await lookImage({ imagePath, task: 'describe' });
    const desc = (r.ok && r.text ? r.text : '').trim();
    if (desc) {
      console.log(`[agents-to-feishu] 桥接代劳看图完成 path=${imagePath} desc.len=${desc.length}`);
      return `[用户发来一张图片，已由桥接代为识别。\n图片本地路径: ${imagePath}\n图片内容描述: ${desc}]`;
    }
    console.warn(`[agents-to-feishu] 桥接代劳看图无输出，回退路径注入 path=${imagePath}`);
  } catch (e) {
    console.warn(`[agents-to-feishu] 桥接代劳看图失败，回退路径注入: ${e instanceof Error ? e.message : String(e)}`);
  }
  return pathOnly;
}

// ── 收图磁盘清理策略（2026-08-30 老大提出：垃圾越来越多）──
/** 收图落盘目录（与 feishu/client.ts downloadResource 同源：os.tmpdir()/agents-to-feishu） */
function imageDir(): string {
  return path.join(os.tmpdir(), 'agents-to-feishu');
}
/** 图片文件保留时长，默认 24 小时（0 = 永不自动清理） */
const IMAGE_TTL_MS = parseInt(process.env.CTI_IMAGE_TTL_MS || String(24 * 60 * 60 * 1000), 10);

/**
 * 删除超过 TTL 的收图文件。保留 pendingImages 里正在用的（在途会话不能删）。
 * 调用时机：每次成功下载后顺带清 + 进程内每 30 分钟定时清。
 */
function pruneImageFiles(): void {
  if (!Number.isFinite(IMAGE_TTL_MS) || IMAGE_TTL_MS <= 0) return;
  const dir = imageDir();
  try {
    if (!fs.existsSync(dir)) return;
    const keep = new Set([...pendingImages.values()].map((v) => v.imagePath));
    const now = Date.now();
    let count = 0, bytes = 0;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (keep.has(p)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < IMAGE_TTL_MS) continue;
      try { fs.unlinkSync(p); count++; bytes += st.size; } catch { /* 占用中，下次再清 */ }
    }
    if (count) {
      console.log(`[agents-to-feishu] 收图清理：删除 ${count} 个过期文件（>${Math.round(IMAGE_TTL_MS / 3600000)}h），释放 ${(bytes / 1048576).toFixed(1)} MB`);
    }
    // 2026-08-30 补：TTS 待发语音目录（agents-to-feishu-tts）正常发完即删，
    // 但进程崩溃/强杀会残留孤儿文件——同一 TTL 兜底扫描。在途文件 mtime 很新不会被误删。
    const ttsDir = path.join(os.tmpdir(), 'agents-to-feishu-tts');
    try {
      if (!fs.existsSync(ttsDir)) return;
      const now = Date.now();
      let tc = 0;
      for (const name of fs.readdirSync(ttsDir)) {
        const p = path.join(ttsDir, name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile() || now - st.mtimeMs < IMAGE_TTL_MS) continue;
        try { fs.unlinkSync(p); tc++; } catch { /* 占用中，下次再清 */ }
      }
      if (tc) console.log(`[agents-to-feishu] TTS 残留清理：删除 ${tc} 个孤儿语音文件`);
    } catch { /* tts 目录清理失败不影响主流程 */ }
  } catch (e) {
    console.warn(`[agents-to-feishu] 收图清理失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function rtLog(msg: string): void {
  const file = process.env.CTI_RT_LOG || '';
  if (!file) return;
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}

const BOT_RUNTIMES: Record<string, () => RuntimeProvider> = {
  dsh: createDshProvider,
  deeptutor: createDeeptutorProvider,
  openclaw: createOpenClawProvider,
  opencode: createOpencodeProvider,
  reasonix: createReasonixProvider,
  mimo: createMiMoProvider,
  openakita: createOpenAkitaProvider,
  gemini: createGeminiProvider,
  hermes: createHermesProvider,
  codex: createCodexProvider,
  claude: createClaudeProvider,
};

function resolveProvider(runtime: string): RuntimeProvider {
  const factory = BOT_RUNTIMES[runtime];
  if (!factory) {
    throw new Error(`未知运行时: ${runtime}（已支持: ${Object.keys(BOT_RUNTIMES).join(', ')}）`);
  }
  return factory();
}

/** 飞书 im.message.receive_v1 事件结构 */
interface FeishuMessageEventData {
  sender: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: 'p2p' | 'group' | string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{ key: string; id: { open_id?: string; user_id?: string }; name?: string }>;
  };
}

/**
 * 过期消息保护（2026-08-29）：普通消息按 chat 串行排队，若某一轮卡死（网关挂住连接/
 * 截断流但不回终止事件），后面排队的消息会一直堵着，等恢复后集中补跑——用户就会看到
 * "一小时前的提问被翻出来回答"。超过此年龄的消息轮到时直接跳过并提示，不再喂给模型。
 *
 * 覆盖两种情况：① 投递延迟（bot 掉线后迟到的事件）② 排队等待过久。
 * 默认 10 分钟（CTI_MSG_MAX_AGE_MS 可调，单位毫秒；0 = 不限制）。
 */
const MSG_MAX_AGE_MS = Number(process.env.CTI_MSG_MAX_AGE_MS ?? 600_000);

/** 解析飞书 create_time（毫秒；个别场景为秒）为"距今毫秒数"；无法解析/未来时间返回 null */
function msgAgeMs(createTime: string | undefined): number | null {
  if (!createTime) return null;
  const raw = Number(createTime);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw < 1e12 ? raw * 1000 : raw; // 秒级时间戳兜底
  const age = Date.now() - ms;
  return age >= 0 ? age : null; // 时钟漂移/未来时间：不判过期，宁可放行
}

async function main(): Promise<void> {
  const { global, bot, botName } = loadConfig();
  console.log(`[agents-to-feishu] 启动 bot=${botName} runtime=${bot.runtime} agent=${bot.agentName}`);

  // 把 config.env 的键灌回 process.env（nssm 服务环境没有这些变量，
  // provider 内部按 process.env 读取；已存在的环境变量优先不覆盖）
  // 注入键（CTI_SYSTEM_PROMPT_GLOBAL / CTI_BOT_*_SYSTEM_PROMPT）排除：由 loadConfig 已按
  // JSON 编码正确还原到 bot.systemPrompt，不再作为明文灌入，避免剥离引号破坏多行注入。
  for (const [k, v] of Object.entries(global)) {
    if (k === 'CTI_SYSTEM_PROMPT_GLOBAL' || /^CTI_BOT_.*_SYSTEM_PROMPT$/.test(k)) continue;
    if (process.env[k] === undefined) process.env[k] = v;
  }
  // USERPROFILE 兜底：nssm 以 LocalSystem 跑时 os.homedir() 指向 systemprofile
  if (process.env.USERPROFILE === undefined || process.env.USERPROFILE?.includes('systemprofile')) {
    process.env.USERPROFILE = process.env.CTI_USER_HOME || 'C:\\Users\\oadan';
  }
  if (process.env.HOME === undefined || process.env.HOME?.includes('systemprofile')) {
    process.env.HOME = process.env.CTI_USER_HOME || 'C:\\Users\\oadan';
  }

  // 飞书客户端
  const feishu = new FeishuClient({ appId: bot.appId, appSecret: bot.appSecret });

  // provider
  const provider = resolveProvider(bot.runtime);

  // Phase 1（2026-08-29 方向定调）：桥接内置工具接线 —— 进程内函数直调，无 HTTP 无配置。
  // claude = SDK 进程内工具；必须在 provider.prepare() 之前接线（mcpServers 只在 query() 创建时生效）。
  // engine 此刻还没建 → 用 engineRef 晚绑定。
  let engineRef: MessageEngine | null = null;
  provider.attachBridgeTools?.({
    sendVoice: (chatId: string, text: string) => engineRef!.sendVoiceReply(chatId, text),
    getSpeech: () => engineRef?.speech,
  });

  await provider.prepare();
  console.log(`[agents-to-feishu] provider 就绪: ${provider.name}`);

  // 会话管理 + 引擎
  const sessions = new SessionManager({
    defaultWorkdir: bot.defaultWorkdir,
    // 2026-08-31 重启保记忆：会话（含 context 历史）落盘，启动自动恢复
    persistFile: path.join(process.env.CTI_USER_HOME || 'C:/Users/oadan', '.agents-to-feishu', 'runtime', `sessions-${process.env.CTI_BOT || 'default'}.json`),
    // 2026-08-29 修复：把 chatId 透传给 provider.resetSession —— 此前丢弃导致
    // in-process 组（dsh 等 6 个）的 map 条目从不删除，只能靠空闲回收/LRU 兜底。
    onSessionReset: async (chatId: string) => { await provider.resetSession(chatId); },
  });
  sessions.restore();
  const engine = new MessageEngine({
    feishu,
    provider,
    sessions,
    botName: bot.agentName,
    modelGroup: bot.modelGroup,
    modelProvider: bot.modelProvider,
    providerId: bot.providerId,
    providerBaseUrl: bot.providerBaseUrl,
    contextWindow: bot.contextWindow,
    showToolCallCards: bot.showToolCallCards,
    showAgentDivider: bot.showAgentDivider,
    showThinkingCards: bot.showThinkingCards,
    systemPrompt: bot.systemPrompt || undefined,
    speech: bot.speech,
      // 2026-08-31 自动回执：回复发出后，若该会话挂着派活登记，自动把回复转发给派活 bot
    onReplySent: async (chatId: string, replyText: string) => {
      if (manualReceiptRecent()) return; // bot 刚用工具回执过 → 跳过自动转发（防双份）
      const fromBot = consumePending(chatId);
      if (!fromBot) return;
      const me = process.env.CTI_BOT || 'unknown';
      const trimmed = replyText.length > 2000 ? replyText.slice(0, 2000) + '…' : replyText;
      try {
        await sendAsUserToBot(fromBot, `[${me}]（自动回执）
${trimmed}`);
        rtLog(`[auto-receipt] 已把对 ${fromBot} 派活的回复自动转发（chat=${chatId.slice(0, 12)}）`);
      } catch (e) {
        rtLog(`[auto-receipt] 转发失败: ${(e as Error).message}`);
      }
    },
  });
  engineRef = engine;

  // 收图磁盘清理：进程内每 30 分钟跑一次（CTI_IMAGE_TTL_MS=0 可关闭）
  setInterval(pruneImageFiles, 30 * 60 * 1000).unref?.();

  // WebSocket 长连接（事件订阅）
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      try {
        await handleIncoming(data as FeishuMessageEventData, engine, sessions, bot.allowedUsers);
      } catch (e) {
        console.error(`[agents-to-feishu] handleIncoming error:`, e);
      }
    },
    // 卡片按钮回调（插队卡：interrupt:yes/no/cancel:chatId:messageId）
    // ⚠️ 必须 return 处理结果（含 card:{type:'raw',data:新卡}）：SDK 会把它作为回调响应发回飞书，
    // 飞书据此原子替换按钮卡——比异步 HTTP PATCH 可靠（PATCH 会被飞书回滚，表现为"点按钮后卡片
    // 短暂变终态又还原成原卡"，根因见 agents-to-im session-handler.ts handleInterruptCardAction）。
    'card.action.trigger': async (data: unknown) => {
      try {
        return await handleCardAction(data, engine);
      } catch (e) {
        console.error(`[agents-to-feishu] card.action.trigger error:`, e);
        return { toast: { type: 'error', content: '交互处理失败，请稍后重试。' } };
      }
    },
  });

  const wsClient = new lark.WSClient({
    appId: bot.appId,
    appSecret: bot.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });
  await wsClient.start({ eventDispatcher: dispatcher });

  console.log(`[agents-to-feishu] 飞书 WebSocket 已连接，等待消息…`);
}

/** 统一入口：解析事件 → 鉴权 → 命令 / 消息 */
const processedMessageIds = new Set<string>();  // 去重：飞书 SDK 偶发对同一条消息 dispatch 多次
const MAX_PROCESSED_IDS = 500;

let myBotOpenId: string | null = null;
let myBotOpenIdPromise: Promise<string | null> | null = null;
/** 本 bot 的 open_id（群聊 @ 过滤用），启动后获取一次 */
function getMyBotOpenId(): Promise<string | null> {
  if (myBotOpenIdPromise) return myBotOpenIdPromise;
  myBotOpenIdPromise = (async () => {
    try {
      const st = readStore();
      const a = st.agents.find((x) => x.id === (process.env.CTI_BOT || ''));
      if (!a?.appId || !a?.appSecret) return null;
      const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: a.appId, app_secret: a.appSecret }),
      });
      const j = (await r.json()) as { tenant_access_token?: string };
      if (!j.tenant_access_token) return null;
      const r2 = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${j.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const j2 = (await r2.json()) as { bot?: { open_id?: string } };
      myBotOpenId = j2?.bot?.open_id ?? null;
      console.log(`[agents-to-feishu] 本 bot open_id=${myBotOpenId ? myBotOpenId.slice(0, 12) : '(未取到)'}（群聊@过滤用）`);
      return myBotOpenId;
    } catch (e) {
      // P1 修复：失败不缓存 promise，下条群消息自动重试（否则直到重启都不过滤）
      myBotOpenIdPromise = null;
      console.log(`[agents-to-feishu] 本 bot open_id 获取失败（@ 过滤降级为不过滤，下条消息重试）: ${(e as Error).message}`);
      return null;
    }
  })();
  return myBotOpenIdPromise;
}

async function handleIncoming(
  ev: FeishuMessageEventData,
  engine: MessageEngine,
  sessions: SessionManager,
  allowedUsers: string[],
): Promise<void> {
  const msg = ev.message;
  if (!msg || !msg.chat_id) return;

  const chatId = msg.chat_id;
  const senderId = ev.sender?.sender_id?.open_id ?? '';
  const fullId = msg.message_id ?? '';
  let text = parseContent(msg.content, msg.message_type);
  let isAudio = false;

  // 排查重复事件：记录每次 handleIncoming 触发
  // 2026-09-01：补文本预览——此前只打 text.len，bot 该回语音却只回文字时，日志里看不出
  // 到底是用户没说"用语音"还是 wantsVoiceReply 漏判，只能靠猜（老大为此骂了半天）
  console.log(`[agents-to-feishu] handleIncoming chat=${chatId} mid=${fullId.slice(0, 24)} sender=${senderId.slice(0, 8)} msgType=${msg.message_type} text.len=${text.length} text="${text.replace(/\s+/g, ' ').slice(0, 40)}"`);
  rtLog(`[handleIncoming] chat=${chatId} mid=${fullId.slice(0, 24)} text=${text.slice(0, 100)}`);

  // 命令消息豁免去重：命令幂等（重复执行无害），必须保证不被 SDK 重复 dispatch 在首次执行前判重跳过
  // （否则 /new 等边命令可能"被吞"）。普通消息仍正常去重。先 trim 防前导空格/不可见字符。
  const isCommand = text.trim().startsWith('/');
  if (fullId && processedMessageIds.has(fullId) && !isCommand) {
    rtLog(`[handleIncoming] SKIP duplicate mid=${fullId.slice(0, 24)}`);
    return;
  }
  if (fullId) {
    processedMessageIds.add(fullId);
    // LRU 简单清理
    if (processedMessageIds.size > MAX_PROCESSED_IDS) {
      const first = processedMessageIds.values().next().value;
      if (first) processedMessageIds.delete(first);
    }
    // 群聊仅@回复（2026-08-31）：群消息必须 @ 本 bot 才处理（对人类和 bot 一致，天然防循环）
    if (msg.chat_type === 'group' && (readStore().settings?.groupMentionOnly ?? true) !== false) {
      const myId = await getMyBotOpenId();
      // @所有人：①mentions 里 id 为 "all"（飞书 UI 标准）②部分客户端/lark-cli 发的 @所有人
      // mentions 为空但原始 content 里有 <at user_id="all">——两条路都要认，否则全员漏收
      const rawAtAll = text.includes('@_all'); // lark-cli 文本方式 @所有人 的占位符（无真 mention）
      const mentioned = myId ? (msg.mentions ?? []).some((mn) => {
        const oid = mn.id?.open_id || '';
        const uid = mn.id?.user_id || '';
        const name = mn.name || '';
        return oid === myId || oid === 'all' || uid === 'all' || /所有人|everyone/i.test(name);
      }) || rawAtAll : true;
      if (!mentioned) {
        rtLog(`[handleIncoming] SKIP 群消息未@本bot mid=${fullId.slice(0, 24)}`);
        return;
      }
    }
  }

  // 鉴权：allowlist（* = 所有人）—— 必须在 audio/image 分支之前。
  // 2026-08-29 审核发现：原先放在 audio(下载+ASR)/image(下载) 之后，
  // 未授权用户也会先触发一次资源下载与转写才被拦。
  if (!(allowedUsers.includes('*') || allowedUsers.includes(senderId))) {
    console.warn(`[agents-to-feishu] 拒绝未授权用户 ${senderId}`);
    return;
  }

  // 2026-08-31 自动回执登记：p2p 消息若带 (from-bot:X) 标记（send_as_user 派活），登记待回执；
  // 该 bot 之后在本会话的回复由 onReplySent 自动转发给 X。自动回执消息（含"自动回执"字样）不再登记，防循环。
  if (msg.chat_type === 'p2p' && text.includes('(from-bot:') && !text.includes('自动回执')) {
    const m = /\(from-bot:([a-zA-Z0-9_-]+)/.exec(text);
    if (m && m[1] && m[1] !== (process.env.CTI_BOT || '')) {
      registerPending(chatId, m[1]);
      rtLog(`[auto-receipt] 登记待回执：chat=${chatId.slice(0, 12)} → 派活方=${m[1]}`);
    }
  }

  // 语音消息：下载音频 → ASR 转写 → 回「语音转写」回执 → 转文本继续处理（对齐旧 agents-to-im）
  if (msg.message_type === 'audio') {
    isAudio = true;
    const audioKey = parseAudioFileKey(msg.content);
    if (!audioKey) {
      await engine.sendText(chatId, '已收到语音消息，但读取语音文件失败。请重新发送语音。');
      return;
    }
    try {
      const asrT0 = Date.now(); // ASR 速度量化（2026-08-30 老大要求"识别要快"）
      const audioPath = await engine.feishu.downloadResource(msg.message_id, audioKey, 'opus');
      if (!audioPath) {
        await engine.sendText(chatId, '语音文件下载失败，请重新发送。');
        return;
      }
      const bytes = await fs.promises.readFile(audioPath);
      const asrCfg = engine.speech?.asr ?? DEFAULT_SPEECH.asr;
      const res = await transcribe(bytes, asrCfg);
      const transcribed = (res.ok && res.text ? res.text : '').trim();
      if (!transcribed) {
        await engine.sendText(chatId, `语音转写失败：${res.error ?? '未识别到语音内容'}`);
        return;
      }
      await engine.sendText(chatId, `语音转写：「${transcribed}」`);
      text = transcribed;
      console.log(`[agents-to-feishu] 语音转写成功: "${transcribed.slice(0, 60)}" (耗时 ${((Date.now() - asrT0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      await engine.sendText(chatId, `语音转写失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }

  // 图片消息：仅下载挂号（pending），不预识别、不触发。
  // 对齐 agents-to-im：收到图片提醒用户补文字需求；等文本到达后合并，
  // 把图片本地路径交给 agent，agent 用 look_image 工具（describe/reverse/text）按文本需求自行看图。
  if (msg.message_type === 'image') {
    const imageKey = parseImageFileKey(msg.content);
    if (!imageKey) {
      await engine.sendText(chatId, '已收到图片，但读取图片文件失败。请重新发送。');
      return;
    }
    // 先把下载任务挂进 pendingImageJobs 再开始下载：文字若在下载完成前到达，
    // 可等待本任务拿到路径（修复竞态——此前文字先到时 pendingImages 还是空，
    // 图片路径丢出 prompt，agent 收不到图只能瞎猜，看错图）。
    const job = (async (): Promise<string | null> => {
      try {
        return await engine.feishu.downloadResource(msg.message_id, imageKey, 'png');
      } catch (e) {
        await engine.sendText(chatId, `图片下载失败：${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    })();
    pendingImageJobs.set(chatId, job);
    try {
      const imagePath = await job;
      if (!imagePath) {
        await engine.sendText(chatId, '图片下载失败，请重新发送。');
        return;
      }
      prunePendingImages();
      pendingImages.set(chatId, { imagePath, messageId: msg.message_id, ts: Date.now() });
      pruneImageFiles(); // 顺带清一次过期收图（在途的会被保留）
      // 文字侧已在等待/合并这张图 ⇒ 不再发"请发送文字需求"提醒（会排在答案后面，倒反天罡）
      if (!pendingImageConsumed.has(chatId)) {
        await engine.sendText(
          chatId,
          '已收到图片。请发送文字需求（如：描述这张图 / 提取图中文字 / 反推生图提示词 / 检查图中内容…），我会连同图片一起处理。',
        );
      }
      console.log(`[agents-to-feishu] 图片已挂号 pending chat=${chatId.slice(0, 12)} path=${imagePath}`);
    } finally {
      pendingImageJobs.delete(chatId);
      pendingImageConsumed.delete(chatId);
    }
    return; // 不触发处理，等文本
  }

  // 文本消息：合并 pending 图片（先发图后补文本的场景），把图片路径交给 agent
  let pending = pendingImages.get(chatId);
  if (!pending && text && pendingImageJobs.has(chatId)) {
    // 竞态修复：图片还在下载，等它落盘（最多 15s）再合并
    console.log(`[agents-to-feishu] 图片仍在下载，等待落盘后合并 chat=${chatId.slice(0, 12)}`);
    pendingImageConsumed.add(chatId);
    await Promise.race([
      pendingImageJobs.get(chatId)!,
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    pending = pendingImages.get(chatId);
  }
  if (pending && text) {
    prunePendingImages();
    // 图片路径拼进文本；无内置看图工具的 runtime 由桥接代劳识别（能力配齐 2026-08-30）
    text = `${await imagePromptFor(pending.imagePath)}\n${text}`;
    console.log(`[agents-to-feishu] 合并 pending 图片 chat=${chatId.slice(0, 12)} path=${pending.imagePath}`);
    pendingImages.delete(chatId);
    pendingImageConsumed.delete(chatId);
  }

  // post 富文本内嵌图（用户"粘贴图+文字"一起发就是 post）：此前 img 元素被静默丢弃
  // ⇒ agent 收不到图片路径，只能瞎猜看错图（2026-08-29 老大实测抓到）
  if (msg.message_type === 'post') {
    const postImageKey = parsePostImageKey(msg.content);
    if (postImageKey) {
      const imagePath = await engine.feishu.downloadResource(msg.message_id, postImageKey, 'png').catch((e: unknown) => {
        console.warn(`[agents-to-feishu] post 内嵌图片下载失败: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (imagePath && text) {
        text = `${await imagePromptFor(imagePath)}\n${text}`;
        console.log(`[agents-to-feishu] post 内嵌图片已合并 chat=${chatId.slice(0, 12)} path=${imagePath}`);
        pruneImageFiles();
      } else if (imagePath && !text) {
        // 纯图 post：与 msgType=image 同款挂号，等下一条文本
        prunePendingImages();
        pendingImages.set(chatId, { imagePath, messageId: msg.message_id, ts: Date.now() });
        await engine.sendText(chatId, '已收到图片。请发送文字需求（如：描述这张图 / 提取图中文字 / 反推生图提示词），我会连同图片一起处理。');
        console.log(`[agents-to-feishu] post 内嵌图片已挂号 pending chat=${chatId.slice(0, 12)} path=${imagePath}`);
        pruneImageFiles();
        return;
      } else {
        await engine.sendText(chatId, '图片下载失败，请重新发送。');
        return;
      }
    }
  }

  if (!text) return;

  // 命令？isCommand 已在去重段算出（已 trim 并判 / 开头）。鉴权已前移到去重之后。
  if (isCommand) {
    await handleCommand(text, chatId, engine, sessions);
    return;
  }

  // 普通消息：按 chat 串行入队（前一条处理完再处理下一条）
  // busy 时先弹插队卡（消息仍在队列，用户可选插队/取消/稍后）
  const wasBusy = engine.isBusy(chatId);
  if (wasBusy) {
    // 先弹插队卡（在消息处理前，让用户可选插队/取消/稍后）——必须在 enqueueChat 之前，
    // 否则 await 队列会等消息处理完才弹卡（= 插队卡纯摆设）
    await engine.sendInterruptCard(chatId, msg.message_id);
  }
  await engine.enqueueChat(chatId, async () => {
    // 过期消息保护：排队/投递过久的旧消息轮到时直接跳过，不回答过时问题（见 MSG_MAX_AGE_MS 注释）
    if (MSG_MAX_AGE_MS > 0) {
      const ageMs = msgAgeMs(msg.create_time);
      if (ageMs != null && ageMs > MSG_MAX_AGE_MS) {
        const mins = Math.round(ageMs / 60_000);
        console.log(`[agents-to-feishu] SKIP stale message mid=${msg.message_id.slice(0, 12)} age=${mins}min > ${Math.round(MSG_MAX_AGE_MS / 60_000)}min`);
        await engine.sendText(chatId, `⏭️ 该消息发送于约 ${mins} 分钟前，等待过久已判定为过期，未处理。如仍需处理请重新发送。`);
        return;
      }
    }
    // 排队轮到时，若该消息已被插队卡"取消"则跳过
    if (msg.message_id && engine.isMessageCancelled(msg.message_id)) {
      engine.clearCancelled(msg.message_id);
      console.log(`[agents-to-feishu] queued message ${msg.message_id.slice(0, 12)} cancelled via interrupt card, skipped`);
      return;
    }
    await engine.handleText(chatId, text, msg.message_id, {
      replyAudio: isAudio || wantsVoiceReply(text),
    });
  });
}

/** 解析语音消息 content 的 file_key / audio_key */
function parseAudioFileKey(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const k = typeof parsed.file_key === 'string' ? parsed.file_key : typeof parsed.audio_key === 'string' ? parsed.audio_key : '';
    return k.trim();
  } catch {
    return '';
  }
}

/** 解析图片消息 content 的 image_key（对齐旧 agents-to-im utils：image_key 或 file_key） */
function parseImageFileKey(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const k = typeof parsed.image_key === 'string' ? parsed.image_key : typeof parsed.file_key === 'string' ? parsed.file_key : '';
    return k.trim();
  } catch {
    return '';
  }
}

/** 用户明确要求语音回复时（文字消息也回语音，对齐 DSH 语音规则 2）
 *  2026-09-01 放宽：老正则只认"语音回复/用语音/发语音"等少数固定说法，
 *  "说句话/念出来/读给我听/出个声/讲两句/语音来一段"全漏判 → bot 只回文字不出声。
 *  判定口径：出现「语音|声音」且带回复意图，或明确的口语化"念/读/说给我听"类指令。 */
function wantsVoiceReply(text: string): boolean {
  return /((发|说|来|讲|播|念|读|整|给|回|用|听)[^\n]{0,4}(语音|声音))|((语音|声音)[^\n]{0,4}(回复|回答|回我|回话|回个|来说|说|讲|播|念|读|来|发|给我|听))|(念出来|读出来|说出来|念给|读给|说给|念一|读一|开口说|出个?声|说句话|讲两句|说两句|来一段)/i.test(text);
}

/** 解析 post 富文本里的内嵌图片 key（用户粘贴图+文字一起发就是 post；此前 img 元素被静默丢弃） */
function parsePostImageKey(content: string | undefined): string {
  if (!content) return '';
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    const body = (o.zh_cn && typeof o.zh_cn === 'object' ? o.zh_cn : o) as {
      content?: unknown[][];
    };
    if (!Array.isArray(body?.content)) return '';
    for (const line of body.content) {
      if (!Array.isArray(line)) continue;
      for (const el of line) {
        const e = el as { tag?: string; image_key?: string; file_key?: string };
        if (e.tag === 'img') {
          const k = (e.image_key ?? e.file_key ?? '').trim();
          if (k) return k;
        }
      }
    }
    return '';
  } catch {
    return '';
  }
}

/** 解析消息 content（text 类型为 JSON {text}；post 富文本提取纯文本，2026-08-29 修复） */
function parseContent(content: string | undefined, msgType: string | undefined): string {
  if (!content) return '';
  if (msgType === 'text') {
    try {
      return JSON.parse(content).text ?? '';
    } catch {
      return content;
    }
  }
  if (msgType === 'post') {
    // 富文本（群聊 @bot 的消息就是 post）：提取全部 text/a 元素的文字拼成纯文本。
    // 注意：发送 API 的 content 带 zh_cn 包装，但事件回调里的 content 是解包后的
    // {title, content} —— 两种形态都要兼容（2026-08-29 二次修复，实测事件形态无 zh_cn）。
    try {
      const o = JSON.parse(content) as Record<string, unknown>;
      const body = (o.zh_cn && typeof o.zh_cn === 'object' ? o.zh_cn : o) as {
        title?: string;
        content?: unknown[][];
      };
      if (!Array.isArray(body?.content)) return '';
      const parts: string[] = [];
      for (const line of body.content) {
        if (!Array.isArray(line)) continue;
        for (const el of line) {
          const e = el as { tag?: string; text?: string };
          if ((e.tag === 'text' || e.tag === 'a') && e.text) parts.push(e.text);
        }
      }
      return parts.join('').trim();
    } catch {
      return '';
    }
  }
  // 其他类型（image/audio）不在此解析：image 走挂号合并，audio 走 ASR 转写
  return '';
}

/**
 * 卡片按钮回调（card.action.trigger）。
 * 插队卡按钮 value: { callback: "interrupt:<yes|no|cancel>:<chatId>:<messageId>" }
 * 返回 { toast, card:{type:'raw',data:新卡} } 让飞书原子替换按钮卡（官方可靠方式）。
 */
async function handleCardAction(
  data: unknown,
  engine: MessageEngine,
): Promise<{ toast?: { type: string; content: string }; card?: { type: 'raw'; data: unknown } }> {
  const d = data as {
    action?: { value?: { callback?: string } };
    operator?: { operator_id?: { open_id?: string } };
  };
  const callback = d?.action?.value?.callback || '';
  const parts = callback.split(':');
  if (parts[0] !== 'interrupt' || parts.length < 4) {
    console.warn(`[agents-to-feishu] unknown card callback: ${callback}`);
    return {};
  }
  const action = parts[1];
  const chatId = parts[2];
  const messageId = parts.slice(3).join(':');
  console.log(`[agents-to-feishu] card action: ${action} chatId=${chatId} mid=${messageId.slice(0, 12)}`);
  return engine.handleInterruptAction(action, chatId, messageId);
}

main().catch((e) => {
  console.error(`[agents-to-feishu] 启动失败:`, e);
  process.exit(1);
});
