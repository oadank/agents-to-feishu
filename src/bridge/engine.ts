/**
 * 消息引擎 —— 飞书消息 → provider 流式事件 → 单卡分层渲染。
 *
 * 渲染模型严格对齐旧 agents-to-im（bridge-manager）：
 * - 一轮对话只有一张流式卡：思考/工具/正文都是卡内 markdown 层，原地 PATCH
 * - 思考层 blockquote / 工具层代码块 / 正文分层；最终态追加状态分割线
 * - 禁止：多卡刷屏、header 横幅、引用用户消息
 * - 节流 PATCH（FLUSH_INTERVAL_MS = 25ms，见 :65；文件头早期写的 800ms 已废弃）；错误写进同一张卡，真实反馈不静默
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FeishuClient } from '../feishu/client.js';
import type { RuntimeProvider, StreamEvent } from '../providers/types.js';
import { SessionManager, type Session } from './session.js';
import { synthesize, toOpus, type TtsConfig } from '../voice/tts.js';
import { readStore, type SpeechConfig } from '../config-center/store.js';
import {
  buildStreamingCardSkeleton,
  buildSimpleCard,
  buildInterruptSkeleton,
  buildInterruptFinalCard,
  buildInterruptStatusText,
  buildStreamMarkdown,
  buildFinalMarkdown,
  buildErrorMarkdown,
  buildDividerText,
  toolStartLine,
  STREAM_ELEMENT_ID,
  type DividerInfo,
  type TurnLayers,
} from '../feishu/cards.js';
import { readArkUsage, readGwBalance, readDeepSeekBalance, readArkUsageCached, readGwBalanceCached, readDeepSeekBalanceCached, readLitellmUpstreamView, readLitellmTurnUsage } from '../config-center/runtime.js';
import { recordStats } from './stats.js';

// 状态行固定全局显示项（管所有 agent；缺省全显示）
export const DIVIDER_FIELDS = ['agent', 'model', 'provider', 'dir', 'session', 'cache', 'avg', 'context', 'usage', 'balance'];
const PROVIDER_SHORT: Record<string, string> = { 'volc-ark': 'Ark', gw: 'GW', 'deepseek-official': 'DeepSeek', litellm: 'LiteLLM' };

export interface EngineOptions {
  feishu: FeishuClient;
  provider: RuntimeProvider;
  sessions: SessionManager;
  botName: string;
  /** 模型组 / Provider 标签（分割线显示） */
  modelGroup: string;
  modelProvider: string;
  /** 原始 provider id（volc-ark/gw/deepseek-official…），状态行短名 + 余额/用量分流 */
  providerId?: string;
  /** provider baseURL（如 https://ark.cn-beijing.volces.com/api/plan），用于按 URL 判用量/余额类型，不硬编码 providerId */
  providerBaseUrl?: string;
  /** 当前模型真实上下文窗口（tokens，来自模型配置 contextWindow） */
  contextWindow?: number;
  /** 是否显示工具调用层 */
  showToolCallCards: boolean;
  /** 是否显示思考层（💭 blockquote）；false = 不积累不渲染，卡片全程无思考过程 */
  showThinkingCards: boolean;
  /** 是否显示 agent 分割线（Agent|Model|Provider|Session|Cache|平均） */
  showAgentDivider: boolean;
  /** 注入的 systemPrompt 内容（统一注入 + 独立注入拼接，来自 config.env）；空则只用内置默认 */
  systemPrompt?: string;
  /** 全局语音配置（ASR+TTS），来自 config-store.json 的 speech 段；缺省关闭语音能力 */
  speech?: SpeechConfig;
  /** 2026-08-31 自动回执：bot 回复发出后回调（桥接层用于把回复自动转发给派活的 bot） */
  onReplySent?: (chatId: string, replyText: string) => Promise<void> | void;
}

const FLUSH_INTERVAL_MS = 25;
const TEXT_FLUSH_INTERVAL_MS = Number(process.env.CTI_TEXT_FLUSH_MS || 1200);
const THINKING_BUFFER_CAP = 20000;

/** 从回复正文提取 agent 专门写的「【语音】…」口语块（TTS 念人话用，不念整段回复）。无块返回空串 */
function extractVoiceBlock(text: string): string {
  // 匹配整个【语音】…块（可多行，直到下一个【或结尾）
  const m = text.match(/【语音】([\s\S]*?)(?=\n*【|$)/);
  if (!m) return '';
  return m[1].trim();
}

/** 从回复正文移除「【语音】…」块，使该块不出现在卡片/历史里 */
function stripVoiceBlock(text: string): string {
  return text.replace(/【语音】[\s\S]*?(?=\n*【|$)/, '').trim();
}

/** [2026-09-17] 按文件魔数判断图片扩展名（send_image 对象池取出的原图字节没有后缀）。不支持返回 null */
function sniffImageExt(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

/** [2026-09-19 票1] 断头轮待投递台账条目：image-object=send_image 附件号（sha256:…），
 *  gen-file=generate_image 本地成品路径。捕获即落盘，投递前销账（见 MessageEngine 台账段）。 */
type PendingDeliveryEntry = { kind: 'image-object' | 'gen-file'; ref: string; chatId: string; ts: number };

/** ComfyUI 成品默认落盘目录（8090 遥控器写到本机 runs） */
const COMFY_RUNS_IMG =
  process.env.COMFY_RUNS_IMG
  || (process.env.OS?.toLowerCase().includes('win') || process.platform === 'win32'
    ? 'C:\\D\\opt\\comfyui\\runs\\img'
    : '/c/D/opt/comfyui/runs/img');

/**
 * [2026-09-18 老大令·写死] 从 generate_image 工具输出提取本地图片绝对路径。
 * 规则：JSON 字段 output_name/path/file/image_path/output + 正文里的绝对路径/成品文件名；
 * 仅文件名时拼到 COMFY_RUNS_IMG。只认 png/jpg/jpeg/webp/gif。
 */
function extractGeneratedImagePaths(output: string): string[] {
  const out = String(output || '');
  const found = new Set<string>();
  const push = (raw: string) => {
    let p = String(raw || '').trim().replace(/^["']|["']$/g, '');
    if (!p) return;
    p = p.replace(/\\\\/g, '\\');
    const looksAbs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
    const base = p.includes('/') || p.includes('\\') ? p.split(/[\\/]/).pop()! : p;
    if (!/\.(png|jpe?g|webp|gif)$/i.test(base)) return;
    if (looksAbs) found.add(p);
    else found.add(path.join(COMFY_RUNS_IMG, base));
  };
  for (const m of out.matchAll(/"(?:output_name|path|file|image_path|output|task_id)"\s*:\s*"([^"]+)"/gi)) push(m[1]);
  // 绝对路径：允许文件名含空格/中文（Krea2 Turbo-文生图_00001.png）
  for (const m of out.matchAll(/[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]+\.(?:png|jpe?g|webp|gif)/gi)) push(m[0]);
  for (const m of out.matchAll(/["']([^"']+\.(?:png|jpe?g|webp|gif))["']/gi)) push(m[1]);
  // 裸文件名（含空格）→ 拼 runs 目录
  for (const m of out.matchAll(/(?<![\\/\w.-])((?:Krea2|Z-IMAGE|ComfyUI_temp)[^"'<>|*\r\n]*\.(?:png|jpe?g|webp|gif))/gi)) push(m[1]);
  return [...found];
}

/** 从 ~/.dsh/<bot>/stats/YYYY-MM-DD.jsonl 读缓存命中率与上下文用量。
 *  传入 sessionId 时只统计该对话的累计（按当前对话算），否则全量统计（按天）。
 *  [票mm-1·09-19 审计] lastRate/avgRate 可为 null = 本会话所有 usage 记录都没有缓存拆分
 *  （引擎未上报 cache 字段），调用方应显示 N/A 而非 0%；整体返回 null = 完全无源（照旧隐藏该段）。 */
export function readCacheStats(contextLimitTokens: number, sessionId?: string): { lastRate: number | null; avgRate: number | null; contextPercent: number; contextUsed: number; contextLimit: number } | null {
  try {
    // stats 目录：优先用 CTI_BOT 确定（对所有 runtime 通用，claude/codex 等非 dsh 也读自己的 stats）；
    // 兜底再走 CTI_DSH_ACP_CONFIG 解析（老 dsh 逻辑），最后 fallback dsh-bot。
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    let statsDir: string | null = null;
    const botId = process.env.CTI_BOT || '';
    if (botId) {
      statsDir = path.join(home, `${botId}-bot`, 'stats');
    } else {
      const acpConfig = process.env.CTI_DSH_ACP_CONFIG || '';
      const m = acpConfig.match(/\\(\w+)-bot\\(cordis\.yml)$/i) || acpConfig.match(/\/(\w+)-bot\/(cordis\.yml)$/i);
      statsDir = m ? path.join(home, `${m[1]}-bot`, 'stats') : path.join(home, 'dsh-bot', 'stats');
    }

    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const file = path.join(statsDir, `${localDate}.jsonl`);
    if (!fs.existsSync(file)) return null;

    let lastRate: number | null = null;
    let sumHit = 0;
    let sumMiss = 0;
    let lastPromptTokens: number | null = null;
    let matched = 0;
    const CONTEXT_LIMIT_TOKENS = contextLimitTokens > 0 ? contextLimitTokens : 1_000_000;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: { source?: string; cache_hit?: number; cache_miss?: number; prompt?: number; session?: string };
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.source !== 'cli') continue;
      // 按当前对话统计：指定了 sessionId 就只算该对话的记录
      if (sessionId && rec.session !== sessionId) continue;
      matched++;
      const hit = Number(rec.cache_hit ?? 0);
      const miss = Number(rec.cache_miss ?? 0);
      // [票mm-1] 📚上下文计数与命中率解耦：无缓存拆分的记录（hit=miss=0）照常参与上下文统计
      if (rec.prompt != null && Number(rec.prompt) > 0) lastPromptTokens = Number(rec.prompt);
      if (hit + miss <= 0) continue; // 分母判 0：无拆分记录不进命中率
      lastRate = (hit / (hit + miss)) * 100;
      sumHit += hit;
      sumMiss += miss;
    }
    const contextPercent = lastPromptTokens != null
      ? Math.min(100, (lastPromptTokens / CONTEXT_LIMIT_TOKENS) * 100)
      : 0;
    if (lastRate == null) {
      // [票mm-1] 有记录但全都没缓存拆分 → 返回 null 率（卡尾显示 N/A）；完全无源 → null（照旧隐藏）
      if (matched <= 0) return null;
      return { lastRate: null, avgRate: null, contextPercent, contextUsed: lastPromptTokens ?? 0, contextLimit: CONTEXT_LIMIT_TOKENS };
    }
    const avgRate = (sumHit / (sumHit + sumMiss)) * 100;
    return { lastRate, avgRate, contextPercent, contextUsed: lastPromptTokens ?? 0, contextLimit: CONTEXT_LIMIT_TOKENS };
  } catch {
    return null;
  }
}

export class MessageEngine {
  private opts: EngineOptions;
  /** chatId → 当前轮流式卡 message_id（一轮一卡） */
  private streamCards = new Map<string, string>();
  // [2026-09-19 票C] 桥侧自动发图跨轮台账（per chat，进程生命周期有效）：正文再提及上一轮的旧图，
  // 兜底捕获(正文)不得再投一次——Z-IMAGE文生图_00003 同路径双发案（本轮台账挡不住跨轮重发）。
  private genAutoDelivered = new Map<string, Set<string>>();
  /** chatId → 串行任务链（同一聊天室的消息排队执行，防止 ACP 并发撞车） */
  private chatQueues = new Map<string, Promise<void>>();
  /** [根治 A③] 每个 chat 当前 busy 周期的起点，用于「排队多久 / 卡住多久」留痕 */
  private chatBusySince = new Map<string, number>();

  readonly modelGroup: string;
  readonly modelProvider: string;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.modelGroup = opts.modelGroup;
    this.modelProvider = opts.modelProvider;
    // [2026-09-19 票1·断头轮补投递] 开机扫账：上一进程被杀/重启腰斩的轮次，图已捕获未投递的
    // 都留在台账里，这里延迟几秒（等飞书客户端就绪）补发。无陈账则静默。
    const bootDelay = parseInt(process.env.CTI_BOOT_RESCUE_DELAY_MS || '2500', 10);
    setTimeout(() => { void this.rescuePendingDeliveriesOnBoot(); }, bootDelay);
  }

  // ── [2026-09-19 票1] 断头轮产物台账 ──
  // 背景（09-19 15:55 家装案）：dsh 生图轮在 generate_image 捕获 Agnes-*.png 之后、自动发图
  // 之前被进程重启腰斩（dsh-out.log:11893 捕获 → :11899 重新开机横幅）——收尾投递链整体没跑，
  // 图只落盘不送达。provider 流被掐成异常时（外层 catch）同理。两层防线：
  //   ① 捕获即落盘（~/.agents-to-feishu/runtime/pending-deliveries-<bot>.json，与 session 落盘同区），
  //     轮次异常结束（catch）时补投递；② 进程重启后开机扫台账补投递。
  // 销账纪律（09-19 双发案红线）：发之前先销账 = 每条最多投递一次；发送明确失败才回账，
  // 等下次开机重试；7 天陈账作废。toolSentPaths（send_image 双发台账）语义不变。

  /** 断头轮待投递台账文件（按 bot 分账，路径惯例对齐 session.ts persistFile） */
  private pendingLedgerFile(): string {
    const home = process.env.CTI_USER_HOME || os.homedir();
    return path.join(home, '.agents-to-feishu', 'runtime', `pending-deliveries-${process.env.CTI_BOT || 'default'}.json`);
  }

  private ledgerLoad(): PendingDeliveryEntry[] {
    try {
      const list = JSON.parse(fs.readFileSync(this.pendingLedgerFile(), 'utf-8'));
      return Array.isArray(list)
        ? list.filter((e: PendingDeliveryEntry) => e && typeof e.ref === 'string' && typeof e.chatId === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private ledgerWrite(list: PendingDeliveryEntry[]): void {
    try {
      const file = this.pendingLedgerFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn(`[engine] 断头轮台账写盘失败:`, e);
    }
  }

  /** 捕获即挂账（按 kind+ref 去重，容量上限 40 防失控） */
  private ledgerAdd(kind: PendingDeliveryEntry['kind'], ref: string, chatId: string, ts = Date.now()): void {
    const list = this.ledgerLoad().filter((e) => !(e.kind === kind && e.ref === ref));
    list.push({ kind, ref, chatId, ts });
    while (list.length > 40) list.shift();
    this.ledgerWrite(list);
  }

  private ledgerRemove(kind: PendingDeliveryEntry['kind'], ref: string): void {
    this.ledgerWrite(this.ledgerLoad().filter((e) => !(e.kind === kind && e.ref === ref)));
  }

  /**
   * 用量/余额类型：ark=火山方舟配额；gw=henry-gao 网关余额；deepseek=DeepSeek 官方余额；
   * litellm=经 LiteLLM(:4000) 中转（按模型组解析真实上游后再分流）；none=不显示。
   * 按 provider baseURL 判类型（不硬编码 providerId），用户改 provider 名/id 也能正确匹配
   * （如 claude 从 GWAnth 切到 Ark，providerId 是自定义的 p1787900370627，但 baseURL 是 ark.cn-beijing.volces.com）。
   */
  private usageKind(): 'ark' | 'gw' | 'deepseek' | 'litellm' | 'none' {
    const pid = this.opts.providerId || '';
    const base = (this.opts.providerBaseUrl || '').toLowerCase();
    if (pid === 'volc-ark' || base.includes('volces') || base.includes('volcengine') || base.includes('ark.cn-beijing')) return 'ark';
    if (pid === 'deepseek-official') return 'deepseek';
    if (pid === 'gw' || pid === 'p1787900927926' || base.includes('henry-gao') || base.includes('gateway.henry-gao')) return 'gw';
    // LiteLLM 中转（2026-08-31）：端口 4000 或 id 含 litellm；解析真实上游延迟到预取阶段
    if (pid.includes('litellm') || /:4000(\/|$)/.test(base)) return 'litellm';
    return 'none';
  }

  /** LiteLLM 中转时解析出的真实上游类型（viewLoaded 预取阶段填充；同步读用） */
  private litellmUpstreamKind: 'gw' | 'ark' | 'none' = 'none';

  /**
   * 按 chat 串行入队执行（移植老项目 enqueueChatTask）。
   * 同一 chat 的消息排队：前一条 handleText 完成后才执行下一条，避免 ACP "already in flight"。
   */
  async enqueueChat(chatId: string, task: () => Promise<void>): Promise<void> {
    const stuckWarnMs = parseInt(process.env.CTI_QUEUE_STUCK_WARN_MS || '120000', 10);
    // [根治 A③ 2026-09-15] 排队留痕。现场出现过「消息只到 handleIncoming，之后 rt.log 再无任何
    // 输出、也不报错」：那是本 chat 的串行队列被一个永不 settle 的任务堵住了，后续消息全排在死
    // promise 后面 —— 用户端就是彻底石沉大海。以前既看不出在排队、也看不出卡了多久。
    if (this.chatQueues.has(chatId)) {
      const waited = Date.now() - (this.chatBusySince.get(chatId) ?? Date.now());
      console.log(`[engine][queue] chat=${chatId.slice(-8)} 排队等待前一个任务（其已运行 ${Math.round(waited / 1000)}s）`);
    }
    if (!this.chatBusySince.has(chatId)) this.chatBusySince.set(chatId, Date.now());
    const previous = this.chatQueues.get(chatId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.chatQueues.set(chatId, next);
    // 看门狗：任务超过阈值仍未 settle 就在日志里点名（不强行释放队列 —— 那个任务还活着，
    // 硬清会让下一条消息和它并发，反而制造 ACP "already in flight"）。
    const stuckTimer = setTimeout(() => {
      console.warn(`[engine][queue] chat=${chatId.slice(-8)} 任务已运行 ${Math.round(stuckWarnMs / 1000)}s 仍未结束`
        + ` —— provider/ACP 极可能无响应，该 chat 后续消息会一直排队（排查看 providers/*.log 与 *-rt.log）`);
    }, stuckWarnMs);
    stuckTimer.unref?.();
    try {
      await next;
    } finally {
      clearTimeout(stuckTimer);
      if (this.chatQueues.get(chatId) === next) {
        this.chatQueues.delete(chatId);
        this.chatBusySince.delete(chatId);
        // busy 结束（该 chat 队列排空）：清插队卡标记 + 自动插队定时器。
        // 让 sendInterruptCard 的防重 guard 只覆盖「当前 busy 周期」：
        // 周期内同 chat 最多一张卡、点按钮后不再补发新卡（修"更新后自动还原"）；
        // 周期结束后，下一个 busy 周期可正常发新卡（防 guard 永久生效导致永不再发卡）。
        this.interruptCardMessages.delete(chatId);
        const autoTimer = this.autoInterruptTimers.get(chatId);
        if (autoTimer) {
          clearTimeout(autoTimer);
          this.autoInterruptTimers.delete(chatId);
        }
      }
    }
  }

  /** 该 chat 是否正在处理消息（队列非空 = 忙） */
  isBusy(chatId: string): boolean {
    return this.chatQueues.has(chatId);
  }

  /** 插队消息卡（chatId → { messageId, seq }；整卡 HTTP PATCH 更新，能移除按钮） */
  private interruptCardMessages = new Map<string, { messageId: string; seq: number }>();
  /** 自动插队定时器（chatId → timer；10 秒未操作自动插队） */
  private autoInterruptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 当前正在执行的任务的 message_id（chatId → mid）；handleText 开始置、finally 清 */
  private activeTaskMid = new Map<string, string>();
  /** 插队发生时"要中断的旧任务"的 message_id（chatId → mid）：只在旧任务仍活跃时才真正 interrupt，
   *  避免倒计时结束时旧任务已跑完、轮到插队消息自己时 interrupt 误伤自己（Claude 会话非正常结束）。 */
  private interruptTargetMid = new Map<string, string>();
  /** 自动插队延迟（ms），默认 10s */
  private autoInterruptMs(): number {
    return parseInt(process.env.CTI_AUTO_INTERRUPT_MS || '10000', 10);
  }

  /**
   * 发送插队确认卡（普通交互卡，非 cardkit）。
   * reply 到用户的插队消息后面。用 replyCardHttp + updateCardHttp（HTTP PATCH 整卡替换，
   * 可靠），避开 cardkit 整卡更新在 streaming/update_multi 卡上失效的坑。
   * busy 时由 index.ts 调用：新消息已入队，弹卡让用户选择。
   */
  async sendInterruptCard(chatId: string, messageId: string): Promise<void> {
    // 防重复：同一 chat 已有一张待处理的插队卡时，不再新发（否则每次新消息进来都 re-send，
    // 新卡覆盖用户已点状态，看起来像"更新后自动还原"）
    if (this.interruptCardMessages.has(chatId)) {
      console.log(`[engine] sendInterruptCard SKIP（该 chat 已有插队卡处理中） chat=${chatId}`);
      return;
    }
    console.log(`[engine] sendInterruptCard chat=${chatId} mid=${messageId.slice(0, 12)}`);
    try {
      const cardMsgId = await this.opts.feishu.replyCardHttp(
        messageId,
        buildInterruptSkeleton({ chatId, messageId, botName: this.opts.botName }),
      );
      console.log(`[engine] sendInterruptCard cardMsgId=${cardMsgId ? cardMsgId.slice(0, 12) : 'NULL'}`);
      if (cardMsgId) {
        this.interruptCardMessages.set(chatId, { messageId: cardMsgId, seq: 0 });
      }
      // 记录"要中断的旧任务"（当前正在跑的任务 mid）。doAutoInterrupt / 点 yes 时，
      // 只有当该旧任务仍处于活跃状态（activeTaskMid 未变）才真正 interrupt，
      // 避免旧任务已结束、轮到插队消息自己时 interrupt 误伤自己。
      this.interruptTargetMid.set(chatId, this.activeTaskMid.get(chatId) ?? '');
      // 自动插队：N 秒未操作自动中断当前任务
      const existing = this.autoInterruptTimers.get(chatId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.autoInterruptTimers.delete(chatId);
        console.log(`[engine] auto-interrupt fired chat=${chatId}`);
        void this.doAutoInterrupt(chatId);
      }, this.autoInterruptMs());
      this.autoInterruptTimers.set(chatId, timer);
    } catch (e) {
      console.warn(`[engine] sendInterruptCard failed:`, e);
    }
  }

  /** 更新插队卡状态：整卡 HTTP PATCH（原生 im/v1/messages/:id 更新，能整卡替换移除按钮）。
   *  用 replyCardHttp 发的普通交互卡（非 cardkit），updateCardHttp（PATCH）是飞书原生可靠更新。 */
  private async updateInterruptCard(
    chatId: string,
    status: 'auto' | 'yes' | 'no' | 'cancel',
  ): Promise<void> {
    const rec = this.interruptCardMessages.get(chatId);
    if (!rec) return;
    rec.seq += 1;
    const me = `[engine] updateInterruptCard chat=${chatId} status=${status} msgId=${rec.messageId.slice(0, 12)}`;
    try {
      const ok = await this.opts.feishu.updateCardHttp(
        rec.messageId,
        buildInterruptFinalCard({ botName: this.opts.botName, status }),
      );
      console.log(me + (ok ? ' -> updateCardHttp OK' : ' -> updateCardHttp 返回 false'));
    } catch (e) {
      console.warn(me + ` -> updateCardHttp 抛异常: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 注意：不在更新后 delete(chatId)——插队卡标记要保留到该 chat 队列排空（busy 结束）才清
    // （由 enqueueChat 队列排空时统一清），否则点按钮后同 chat 后续消息又会触发
    // sendInterruptCard 再发新卡（表现为"更新后自动还原"）。
  }

  /** 自动插队：到点未操作，中断当前任务 + 更新插队卡状态 */
  private async doAutoInterrupt(chatId: string): Promise<void> {
    console.log(`[engine] doAutoInterrupt chat=${chatId}`);
    if (!this.shouldInterrupt(chatId)) {
      console.log(`[engine] doAutoInterrupt SKIP：旧任务已结束，不中断（避免误伤插队消息自己） chat=${chatId}`);
      return;
    }
    try {
      await this.opts.provider.interrupt();
      console.log(`[engine] doAutoInterrupt interrupt() done`);
      await this.updateInterruptCard(chatId, 'auto');
    } catch (e) {
      console.warn(`[engine] auto interrupt failed:`, e);
    }
  }

  /**
   * 判断"当前是否应真正 interrupt"：只有当 sendInterruptCard 记录的旧任务（interruptTargetMid）
   * 此刻仍处于活跃状态（activeTaskMid 还是它）才应中断。若旧任务已结束、activeTaskMid 已
   * 变成别的消息（如插队消息自己正在执行）或已清除，则不再 interrupt —— 防止倒计时结束/点按钮
   * 时旧任务恰好跑完、中断误伤自己插队的新消息（表现为"❌ Claude 会话非正常结束"）。
   */
  private shouldInterrupt(chatId: string): boolean {
    const target = this.interruptTargetMid.get(chatId);
    const active = this.activeTaskMid.get(chatId);
    // 无记录目标（sendInterruptCard 未设）或已清除 → 不该中断；仅当旧任务仍活跃（匹配）才中断
    return !!target && target === active;
  }

  /**
   * 插队卡按钮回调：interrupt:yes|cancel|no:chatId:messageId
   * - yes：中断当前任务，队列随即消费新消息（消息已在队列）
   * - no：取消自动插队定时器，排队等当前完成
   * - cancel：取消自动插队定时器，撤回该消息（标记作废）
   */
  async handleInterruptAction(
    action: string,
    chatId: string,
    _messageId: string,
  ): Promise<{
    toast?: { type: string; content: string };
    status: 'yes' | 'no' | 'cancel' | 'auto';
    card: { type: 'raw'; data: unknown };
  }> {
    console.log(`[engine] handleInterruptAction action=${action} chat=${chatId}`);
    const existing = this.autoInterruptTimers.get(chatId);
    if (existing) { clearTimeout(existing); this.autoInterruptTimers.delete(chatId); }

    // 回调响应体里返回新卡（飞书官方原子更新：card.type='raw'，data=卡片对象），
    // 飞书会用该卡直接替换按钮卡，对所有接受者生效——比异步 HTTP PATCH 可靠：
    // PATCH 会被飞书回滚/丢弃，表现为"点按钮后卡片短暂变终态又还原成原卡"（实测根因）。
    const finalCard = (status: 'yes' | 'no' | 'cancel'): { type: 'raw'; data: unknown } => ({
      type: 'raw',
      data: buildInterruptFinalCard({ botName: this.opts.botName, status }),
    });

    if (action === 'cancel') {
      // 撤回消息：通过 cancelledMessageIds 标记，让排队中的消息不执行
      this.cancelledMessageIds.add(_messageId);
      await this.updateInterruptCard(chatId, 'cancel');
      return { toast: { type: 'success', content: '已取消该消息' }, status: 'cancel', card: finalCard('cancel') };
    }

    if (action === 'no') {
      await this.updateInterruptCard(chatId, 'no');
      return { toast: { type: 'success', content: '已排队，稍后处理' }, status: 'no', card: finalCard('no') };
    }

    // yes：立即中断当前任务，队列随即消费新消息
    try {
      await this.opts.provider.interrupt();
      await this.opts.sessions?.interrupt(chatId); // [2026-09-02] 标记会话中断→下条消息保留历史（不再丢上下文）
    } catch (e) {
      console.warn(`[engine] interrupt failed:`, e);
    }
    await this.updateInterruptCard(chatId, 'yes');
    return { toast: { type: 'success', content: '已插队' }, status: 'yes', card: finalCard('yes') };
  }

  /** 被插队"取消"作废的消息 id（排队中 / 已出队执行前拦截） */
  private cancelledMessageIds = new Set<string>();

  /** 是否该消息已被插队卡取消（handleText 开头检查） */
  isMessageCancelled(messageId: string): boolean {
    return this.cancelledMessageIds.has(messageId);
  }

  /** 清理已消费的取消标记 */
  clearCancelled(messageId: string): void {
    this.cancelledMessageIds.delete(messageId);
  }

  /** 直接发文本（命令回复用） */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.opts.feishu.sendText(chatId, text);
  }

  /** 发送本地图片到聊天：上传飞书(image_key) → sendImage（发图能力） */
  async sendImageFile(chatId: string, imagePath: string): Promise<boolean> {
    try {
      const imageKey = await this.opts.feishu.uploadImage(imagePath);
      await this.opts.feishu.sendImage(chatId, imageKey);
      return true;
    } catch (e) {
      console.warn(`[engine] sendImageFile failed:`, e);
      return false;
    }
  }

  /**
   * 从 generate_image 工具输出解析本地图片路径（写死规则见 extractGeneratedImagePaths）。
   * 生图成功必须自动发到飞书——只落盘不发=用户看不见。
   */
  private parseGeneratedImagePaths(output: string): string[] {
    return extractGeneratedImagePaths(output);
  }

  /** 命令回复：以卡片样式发（对齐主回复风格；老项目命令走富文本，卡片更统一） */
  async sendCommandCard(chatId: string, text: string): Promise<void> {
    try {
      await this.opts.feishu.sendCardHttp(chatId, buildSimpleCard(text));
    } catch (e) {
      console.warn(`[engine] sendCommandCard failed, fallback text:`, e);
      await this.opts.feishu.sendText(chatId, text);
    }
  }

  get botName(): string {
    return this.opts.botName;
  }

  get sessions(): SessionManager {
    return this.opts.sessions;
  }

  get feishu(): FeishuClient {
    return this.opts.feishu;
  }

  get speech(): SpeechConfig | undefined {
    // 2026-08-30：实时读 config-store.json——设置页改引擎/音色保存后立即生效（无需重启）
    try { return readStore().speech ?? this.opts.speech; } catch { return this.opts.speech; }
  }

  /**
   * 中断当前 provider 的正在执行任务（/stop 命令、插队均走这里）。
   * 所有 agent 通用：调各 provider.interrupt()（DSH/Claude 等真实中断底层，其余尽力）。
   */
  async interruptProvider(): Promise<void> {
    try {
      await this.opts.provider.interrupt();
      console.log('[engine] interruptProvider done');
    } catch (e) {
      console.warn(`[engine] interruptProvider failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 处理一条用户文本消息（replyToMessageId 仅保留兼容，不用于引用；opts.replyAudio=用户发语音/要求语音时语音回复） */
  async handleText(chatId: string, text: string, _replyToMessageId?: string, opts?: { replyAudio?: boolean }): Promise<void> {
    void _replyToMessageId; // 不引用用户消息（对齐旧体验）
    // 标记当前 chat 正在执行的任务（插队 interrupt 判断用：只在旧任务仍活跃时中断，不误伤插队消息自己）
    if (_replyToMessageId) this.activeTaskMid.set(chatId, _replyToMessageId);
    const { provider, sessions } = this.opts;
    const session = sessions.getOrCreate(chatId);
    const fresh = sessions.consumeFresh(session);
    // [09-20 裁决] fresh 的来源：user-new=用户主动 /new；restore=桥重启恢复。
    // 供支持赎回的 provider（dsh）区分"复活旧会话"还是"彻底空白"。
    const freshReason = fresh ? sessions.consumeFreshReason(session) : undefined;
    // [2026-09-02 修复] 中断插队后保留历史：status==='interrupted'（卡片"是"/自动插队/或 /stop 触发）时，
    // 下条消息把 session.context 作为 history 传给 provider，避免"新建会话丢上下文"。
    const interrupted = session.status === 'interrupted';
    if (interrupted) session.status = 'running'; // 消费中断标记（仅一次）

    // 状态条：可变，随流式更新取最新真实数据（ACP sessionId + 当日 stats 命中率）
    // Ark 用量 / 余额按 provider 分流【后台异步预取，不阻塞首屏】：卡片先出、用缓存旧值或
    // 暂不显示该段，后台 fetch 填充 runtime 缓存后，后续流式/最终 render 同步读缓存自动带上新值。
    const providerId = this.opts.providerId;
    const LABEL: Record<string, string> = { '5h': '5h', weekly: '周', monthly: '月' };
    // 用量/余额分流：按 provider baseURL 判类型（不硬编码 providerId，用户改 provider 名/id 也能匹配）。
    // 后台预取 Ark 用量 / 余额的 Promise：不 await（不阻塞卡片首屏），供最终 render 后 await 刷新状态行
    const viewLoaded: Promise<void> = this.opts.showAgentDivider
      ? (async () => {
          try {
            switch (this.usageKind()) {
              case 'ark': await readArkUsage(); break;
              case 'gw': await readGwBalance(); break;
              case 'deepseek': await readDeepSeekBalance(); break;
              case 'litellm': {
                // 解析模型组真实上游（GwV4F→GW / ArkV4F→Ark），并预取对应余额/配额进缓存
                const v = await readLitellmUpstreamView(this.opts.modelGroup, this.opts.providerBaseUrl || '');
                this.litellmUpstreamKind = v.kind;
                break;
              }
              default: break;
            }
          } catch (e) { void e; /* 失败不阻塞卡片 */ }
        })()
      : Promise.resolve();
    let acpSessionId: string | undefined;
    const buildDivider = (): DividerInfo | undefined => {
      if (!this.opts.showAgentDivider) return undefined;
      console.log(`[engine][divider] chat=${chatId} sessionId=${session.id.slice(0,8)} acpSessionId=${acpSessionId?.slice(0,8)||'(none)'}`);
      const stats = readCacheStats(this.opts.contextWindow ?? 1_000_000, acpSessionId);
      const shortProvider = PROVIDER_SHORT[providerId || ''] || this.opts.modelProvider;
      // 同步读缓存值：有旧值就用，没有则不显示该段（不阻塞首屏）
      const kind = this.usageKind();
      // litellm 中转 → 用预取阶段解析出的真实上游分流（gw/ark）
      const effKind = kind === 'litellm' ? this.litellmUpstreamKind : kind;
      const up = readArkUsageCached();
      const usage = effKind === 'ark' && up && up.periods.length
        ? up.periods.map((p) => ({ label: LABEL[p.label] || p.label, pct: p.quota > 0 ? Math.round((p.used / p.quota) * 100) : 0 }))
        : null;
      const balance = effKind === 'gw' ? readGwBalanceCached()
        : effKind === 'deepseek' ? readDeepSeekBalanceCached() : null;
      return {
        agent: this.opts.botName,
        dividerMode: (process.env[`CTI_BOT_${(process.env.CTI_BOT || '').toUpperCase()}_DIVIDER_MODE`] as 'full' | 'icon' | 'text' | 'value') || 'full',
        model: this.opts.modelGroup,
        provider: shortProvider,
        // 2026-08-31：状态栏显示逻辑会话 id（displayId，持久化跨重启稳定）；运行时 acp id 重启会换，仅作兜底
        session: session.displayId?.slice(0, 8) || acpSessionId?.slice(0, 8) || session.id.slice(0, 8),
        dir: session.workdir,
        ...(stats
          ? { cacheHitRate: stats.lastRate, cacheAvgRate: stats.avgRate, contextPercent: stats.contextPercent, contextUsed: stats.contextUsed, contextLimit: stats.contextLimit }
          : {}),
        usage,
        balance,
        fields: DIVIDER_FIELDS,
      };
    };
    const dividerInfo = buildDivider(); // 骨架快照

    // ── 一轮一卡：CardKit 实体链路（对齐老项目 preview-service）──
    // ① cardkit.card.create 建实体（骨架带 element_id: 'stream_content' + divider）
    // ② 发送卡片实体引用（{type:'card', data:{card_id}}）拿 message_id
    // ③ 流式更新走 cardElement.content 增量（sequence 递增，飞书限流友好）
    // ④ 最终态更新 stream_content 最终文本 + card.settings summary
    // ⑤ 任一环节失败 → 降级整卡 PATCH（buildSimpleCard），保证卡片可见
    let cardId: string | null = null;
    let messageId: string | null = null;
    try {
      cardId = await this.opts.feishu.createCardkitCard(buildStreamingCardSkeleton(dividerInfo));
    } catch (e) {
      console.warn(`[engine] cardkit create failed, fallback cards:`, e);
    }
    if (cardId) messageId = await this.opts.feishu.sendCardIdHttp(chatId, cardId);
    if (!messageId) {
      // CardKit 不可用时直发整卡骨架，后续整卡 PATCH
      cardId = null;
      messageId = await this.opts.feishu.sendCardHttp(chatId, buildStreamingCardSkeleton(dividerInfo));
    }
    if (!messageId) return;
    this.streamCards.set(chatId, messageId);

    const layers: TurnLayers = { text: '', thinking: '', toolLines: [] };
    let voiceText = ''; // agent 专门写的【语音】口语块；空=本回复无语音
    const pendingVoiceIds: string[] = []; // [2026-09-01] send_voice 工具产物（voiceId=sha256），本轮结束后投递到飞书
    const pendingImageIds: string[] = [];
    // 🔴 老大令 2026-09-19（双发二案）：事件层 send_image 输入路径台账——卡片文本会被渲染截断
    // （"imagePath" 缺闭引号即漏判 Krea2_00014 双发），必须从 ev.input 原始 JSON 在截断前登记。
    const toolSentPaths = new Set<string>();
    const isToolSent = (p: string) => { try { return toolSentPaths.has(path.resolve(p).toLowerCase()); } catch { return false; } }; // [2026-09-17] send_image 工具产物（attachmentId=sha256），本轮结束后投递到飞书
    const pendingGenFiles: string[] = []; // [2026-09-18 老大令] generate_image 本地成品——成功即必须自动发飞书
    const genTurnStartMs = Date.now(); // 本轮开始时间，用于生图文件 mtime 兜底
    let sawGenTool = false; // 本轮是否出现过 generate_image 工具
    let deeptutorSpoken = ''; // [2026-09-03] deeptutor 语音口语稿（voice_reply 事件携带），结束走控制中心 TTS
    const pendingMedia: Array<{ url: string; mime_type: string; filename: string }> = []; // [2026-09-03] deeptutor 图片/视频/文件兜底投递
    let hadError = false;
    let seq = 0;

    // ── 流式模式说明（2026-08-29 二次修复）──
    // 流式由【创建时】骨架 config.streaming_mode:true 开启（cards.ts，官方文档唯一有效方式）。
    // 此前在此处调 updateCardSettings(streaming=true) 是假成功（code=0 但不生效），导致每轮
    // 首次 element 增量更新必 300309 → 降级整卡 PATCH。此处不再开流式，只在终态关闭。

    /** 统一的卡片渲染出口：CardKit element 增量优先，失败降级整卡 PATCH */
    const render = async (markdown: string, isFinal = false): Promise<boolean> => {
      if (cardId) {
        seq += 1;
        let ok = await this.opts.feishu.updateCardElement(cardId, STREAM_ELEMENT_ID, markdown, seq);
        if (!ok) {
          // 2026-08-30 修复流式抽风（老大实测：写一半突然重写/闪全，终卡才正常）：
          // element 失败后不能直接降级整卡 PATCH——骨架 streaming_mode 仍开着，
          // 整卡覆盖会和 CardKit 流式渲染交替打架。处理：先重试一次（瞬态/竞态）；
          // 仍失败则先关流式（settings streaming=false）再整卡 PATCH，消除交替源。
          seq += 1;
          ok = await this.opts.feishu.updateCardElement(cardId, STREAM_ELEMENT_ID, markdown, seq);
        }
        if (ok) {
          if (isFinal) {
            seq += 1;
            const summaryText = markdown.replace(/\s+/g, ' ').trim().slice(0, 120) || '✅ 回答完成';
            // 终态：关闭流式模式 + 写聊天列表摘要（对齐老项目 endPreview 关 streaming_mode）
            await this.opts.feishu.updateCardSettings(cardId, summaryText, seq, false).catch(() => {});
          }
          return true;
        }
        console.warn(`[engine] cardElement update failed ×2, close streaming + whole-card PATCH`);
        seq += 1;
        const summaryText = markdown.replace(/\s+/g, ' ').trim().slice(0, 120) || '✅ 回答完成';
        await this.opts.feishu.updateCardSettings(cardId, summaryText, seq, false).catch(() => {});
        cardId = null; // 后续全走 PATCH（流式已关，不再有交替打架）
      }
      const card = buildSimpleCard(markdown, buildDivider());
      return this.opts.feishu.updateCardHttp(messageId, card);
    };

    // ── 节流 PATCH：800ms 窗口内合并多次事件为一次更新；串行化防乱序 ──
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    // [2026-09-06] 修复正文回跳：并发 updateCardElement 时 seq 可能被 Feishu 乱序应用，
    // 导致旧内容覆盖新内容（200字→20字反复）。改为串行发送链，保证每次只发一个 PATCH、
    // 且严格按 seq 递增顺序发送。请求期间到达的新更新合并到 pending 标志，链空闲后补发。
    let flushChain: Promise<void> = Promise.resolve();
    let pendingFlush = false;
    const doFlush = async (): Promise<void> => {
      pendingFlush = true;
      const run = flushChain.then(async () => {
        pendingFlush = false;
        const snapshot = buildStreamMarkdown(layers);
        await render(snapshot);
        if (pendingFlush) {
          await render(buildStreamMarkdown(layers));
        }
      });
      flushChain = run.catch(() => { /* 网络/临时错误：下轮事件会再刷 */ });
      await run;
    };
    let lastThinkFlushAt = 0;
    let thinkFlushTimer: ReturnType<typeof setTimeout> | null = null;
    // 2026-08-31 修正文闪烁（老大实测 gemini）：text 事件逐 chunk scheduleFlush，FLUSH_INTERVAL=25ms
    // ⇒ 正文每 25ms 全量重写一次（GW 流还是缓冲式 bursts，闪烁更烈）。正文节流 ≥1.2s 一次，
    // 期间累积不丢，节流到期兜底刷出。工具/错误事件仍立即刷（离散行，低频）。
    let lastTextFlushAt = 0;
    let textFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleTextFlush = (): void => {
      const now = Date.now();
      if (now - lastTextFlushAt >= TEXT_FLUSH_INTERVAL_MS) {
        lastTextFlushAt = now;
        scheduleFlush();
      } else if (!textFlushTimer) {
        textFlushTimer = setTimeout(() => { textFlushTimer = null; lastTextFlushAt = Date.now(); scheduleFlush(); }, TEXT_FLUSH_INTERVAL_MS - (now - lastTextFlushAt));
      }
    };
    const scheduleFlush = (): void => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; void doFlush(); }, FLUSH_INTERVAL_MS);
    };
    // 工具事件节流：[2026-09-05] 工具卡片本来每事件立即整卡重绘，AI 连发多条工具状态
    // （call/update/finish）时一帧内多次全量刷新 = 正文闪烁。收敛到 300ms 窗口内合并一次，
    // 工具行本身低频离散，300ms 感观即时、又避免高频整卡重绘。
    let toolFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleToolFlush = (): void => {
      if (toolFlushTimer) return;
      toolFlushTimer = setTimeout(() => { toolFlushTimer = null; scheduleFlush(); }, 300);
    };
    /** 停止定时器并等待在途 PATCH 完成（防止最终卡被过期的流式视图覆盖） */
    const quiesce = async (): Promise<void> => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // 节流兜底定时器也要清：否则 FINAL 渲染后被过期的流式视图覆盖（终卡闪回旧内容）
      if (textFlushTimer) { clearTimeout(textFlushTimer); textFlushTimer = null; }
      if (thinkFlushTimer) { clearTimeout(thinkFlushTimer); thinkFlushTimer = null; }
      if (toolFlushTimer) { clearTimeout(toolFlushTimer); toolFlushTimer = null; }
      // 等待串行发送链排空，确保所有在途 PATCH 完成，避免最终卡被过期视图覆盖
      await flushChain.catch(() => {});
    };

    try {
      // 2026-08-29 修复：
      // - workdir：把 /new [目录] 绑定的工作目录真正传给 provider（此前字段缺失，目录切换从未生效）
      // - history：新建会话时带上会话上下文（含 /compact 产出的摘要），对齐老项目
      //   compact.ts applyCompactResult —— 摘要作为 user 消息进入新会话，下轮自然携带。
      // 2026-08-30 修复：语音回复规范每轮随文携带（此前 systemPrompt 仅会话首条注入，
      // 老会话不知道【语音】块约定 ⇒ TTS 对老会话失效，实测 claude/dsh 语音回复=0）
      const turnStartTs = Date.now(); // litellm 中转 bot 补拉用量用（按时间窗过滤记账库）
      let gotRealUsage = false; // [票mm-1] 判据=usage 事件输入侧有量（能落盘 stats）才算真实；gemini 恒 input=0 → 放行补拉
      for await (const ev of provider.streamChat({
        // [09-20 老大令·去堆积] 语音规则每轮尾巴（VOICE_RULE_TURN ~90字/条，且随引擎历史
        // 永久堆积）废除：该规则全文已在注入 global 段「## 语音」（老大瘦身版自带），每家新引擎
        // 会话首条必带；09-20 全桥已滚过一轮，存量会话 persona 均已含此段，尾巴纯冗余。
        text,
        // [2026-09-03] deeptutor 语音标记：attachments 带 audio 项 = 本轮来自语音
        // 消息，provider 据此给 DeepTutor 拼 [语音消息] 前缀触发其语音契约（自动
        // 回语音 artifact，再由 sources 钩子投递）。其他 provider 忽略。
        ...((provider.name === 'deeptutor' && opts?.replyAudio)
          ? { attachments: [{ type: 'audio' as const, text: '' }] }
          : {}),
        sessionKey: session.id,
        freshSession: fresh,
        freshReason,
        systemPrompt: this.buildSystemPrompt(),
        workdir: session.workdir,
        // [2026-09-17] 恒传 history（现仅供 /new 语义的合法携带）。
        // 🔴 老大令 2026-09-19：影子回灌废除 —— provider 在「非用户 /new 的新建会话」
        // 分支回调 onSessionLost：桥清空 context + 发卡片告知（自动 /new）。
        ...(session.context.length > 0 ? { history: [...session.context] } : {}),
        onSessionLost: (reason) => {
          if (session.context.length === 0) return;
          session.context = [];
          session.pendingFresh = true;
          session.pendingFreshReason = 'user-new'; // 等效自动 /new：下条绝不许赎回旧会话
          this.opts.sessions.persist();
          console.log(`[engine] auto /new on engine session lost (${reason || 'unknown'}) chat=${chatId.slice(0, 12)}`);
          // 🔴 老大令 2026-09-20：🆕 卡太吓人还满天飞——先分原因再说话。idle/interrupt/restart
          // 是正常换代（清 shadow+自动 /new 的 9/19 裁定不变），文案温和；未知原因才保留重警告。
          // 票 claude-2 09-20：claude 家把两档可判定原因传进来了，卡片照实说；兜底句不再写
          // "provider 未报原因"（其余 12 家可能压根没报因能力，那句把能力缺失说成失职，不诚实）。
          const why = reason === 'idle' ? '空闲超时，旧会话按 12h 家法回收'
            : reason === 'interrupt' ? '上一轮被打断，旧会话引擎侧无法复用'
            : reason === 'restart' ? '引擎进程换代'
            : reason === 'engine-history-missing' ? '引擎历史库丢了该会话档案（jsonl 已被搬走/清理，resume 无从找回）'
            : reason === 'resume-failed-library-intact' ? '引擎拒绝续用旧会话（历史库还在，但该会话 id 引擎已不认）'
            : null;
          void this.sendCommandCard(chatId, why
            ? `🔄 ${why}，已自动开新会话（桥侧历史副本清空，长期记忆按引擎自管）。`
            : '🔄 引擎会话已换代（原因无法判定：provider 未传可判定原因），自动开新会话并清空桥侧历史副本——长期记忆归引擎自管。');
        },
      })) {
        switch (ev.type) {
          case 'text':
            layers.text += ev.text;
            scheduleTextFlush();
            break;
          case 'thinking':
            // 2026-09-01 思考层显示开关：false = 不积累（流式/终态卡片都无 💭 块）
            if (this.opts.showThinkingCards === false) break;
            if (ev.text.trim()) {
              layers.thinking = (layers.thinking + ev.text).slice(-THINKING_BUFFER_CAP);
              // 2026-08-31 修思考层闪烁：thinking chunk 高频（hermes 8000+ 条），每次都刷=整块重绘。
              // 节流 ≥1.8s 一次；期间累积不丢，下个非 thinking 事件或节流到期兜底刷出。
              const now = Date.now();
              if (now - lastThinkFlushAt >= 1800) {
                lastThinkFlushAt = now;
                scheduleFlush();
              } else if (!thinkFlushTimer) {
                thinkFlushTimer = setTimeout(() => { thinkFlushTimer = null; scheduleFlush(); }, 1800 - (now - lastThinkFlushAt));
              }
            }
            break;
          case 'tool': {
            // [2026-09-01] send_voice 结果捕获（放最前，不受工具卡显示开关影响）：
            // 工具结果文本形如「语音已发送（voiceId: sha256:<64hex>，时长 N 秒）」
            if (ev.status === 'done' && typeof ev.output === 'string' && ev.output.length > 0) {
              const vm = ev.output.match(/voiceId:\s*(sha256:[0-9a-f]{64})/);
              if (vm) {
                pendingVoiceIds.push(vm[1]);
                console.log(`[engine] send_voice 捕获 voiceId=${vm[1].slice(0, 26)}… 待投递`);
              }
              // [2026-09-17] send_image 结果捕获（同 voiceId 机制）：工具结果文本形如
              // 「图片已发送（attachmentId: sha256:<64hex>，1024×1024）」。此前只认 voiceId，
              // dsh 等 ACP bot 用 send_image 发的图会被静默丢弃（用户端"图没发过来"的根因）。
              // [2026-09-18 容错] 原来死抠「attachmentId: sha256:…」这一种写法，提示串格式一变
              // （括号/空格/换行）就静默丢图。这里加兜底：只要这条工具是 send_image，
              // 输出里出现 sha256 附件号就认（语音在前、图片在后，voiceId 已被上面先吃掉）。
              const im = ev.output.match(/attachmentId:?\s*(sha256:[0-9a-f]{64})/)
                ?? (/send_image/i.test(ev.tool) ? ev.output.match(/(sha256:[0-9a-f]{64})/) : null);
              if (im) {
                pendingImageIds.push(im[1]);
                this.ledgerAdd('image-object', im[1], chatId); // [票1] 捕获即挂账
                console.log(`[engine] send_image 捕获 attachmentId=${im[1].slice(0, 26)}… 待投递`);
              }
              if (/send_image/i.test(ev.tool)) {
                try {
                  const j = JSON.parse(String(ev.input || "{}"));
                  const ip = j.imagePath || j.image_path || j.path; // cti-builtin 工具键是 image_path，此前只认 imagePath——事件层台账一直没活
                  if (typeof ip === "string" && ip.trim()) { toolSentPaths.add(path.resolve(ip).toLowerCase()); console.log(`[engine] 台账登记 send_image 输入 ${path.resolve(ip).slice(0, 60)}`); }
                } catch { /* 非 JSON 输入忽略 */ }
              }
              // [2026-09-18 老大令·写死] generate_image 成功 → 自动把本地图发到飞书。
              // 不能只落盘给自己看：工具返回里凡出现 ComfyUI runs 下的图片路径/文件名，本轮结束强制投递。
              const isGen = /generate_image|__generate_image|comfy__generate/i.test(ev.tool)
                && !/send_image/i.test(ev.tool);
              if (isGen) sawGenTool = true;
              if (isGen && !/生图失败|工具执行失败|error/i.test(ev.output.slice(0, 200))) {
                for (const p of this.parseGeneratedImagePaths(ev.output)) {
                  if (!pendingGenFiles.includes(p)) {
                    pendingGenFiles.push(p);
                    this.ledgerAdd('gen-file', p, chatId); // [票1] 捕获即挂账
                    console.log(`[engine] generate_image 捕获 ${p} → 本轮结束自动发飞书`);
                  }
                }
              }
            }
            if (!this.opts.showToolCallCards) break;
            if (!ev.status || ev.status === 'running') {
              // 工具在跑：入历史（每条一行，对齐旧 1874 行格式）
              layers.toolLines.push(toolStartLine(ev.tool, ev.input));
            } else {
              // 结束：找到第一条未标记的同名工具行打标（✅/❌），找不到则补一行
              const mark = ev.status === 'done' ? '✅' : '❌';
              const idx = layers.toolLines.findIndex(
                (l) => l.startsWith(ev.tool) && !l.startsWith('✅') && !l.startsWith('❌'),
              );
              if (idx >= 0) layers.toolLines[idx] = `${mark} ${layers.toolLines[idx]}`;
              else layers.toolLines.push(`${mark} ${toolStartLine(ev.tool, ev.input)}`);
            }
            scheduleToolFlush();
            break;
          }
          // [2026-09-03] deeptutor 语音口语稿：DeepTutor 产出口语稿，实际发声走
          // 控制中心 TTS（sendVoiceReply）——音色控制中心统一改、全局生效。
          case 'voice_reply':
            deeptutorSpoken = ev.text.trim();
            console.log(`[engine] deeptutor 语音口语稿捕获 len=${deeptutorSpoken.length}`);
            break;
          // [2026-09-03] deeptutor 图片/视频/文件成品：收集待收尾统一投递飞书
          case 'media_send':
            pendingMedia.push({ url: ev.url, mime_type: ev.mime_type, filename: ev.filename });
            console.log(`[engine] deeptutor 成品待投递: ${ev.filename} (${ev.mime_type})`);
            break;
          case 'usage':
            // [票mm-1·USAGE-AUDIT-0919 附注2] "真实"判据=事件能否落盘 stats：recordStats 需要 input 侧
            // 有量（hit=cacheRead / miss=cacheWrite / input 至少其一 >0）才写得出记录。gemini 的
            // _meta.quota 只报 output（input 恒 0，09-19 案 acpSessionId=9f71fae1：事件置了 divider
            // 过滤 id 却写不进任何记录，补拉又被旧判据的 output>0 掐掉 → 卡尾恒空白）。
            // 故只按输入侧计真实；纯 output 事件放行 litellm 补拉兜底。
            if ((ev.usage.inputTokens ?? 0) + (ev.usage.cacheReadTokens ?? 0) + (ev.usage.cacheWriteTokens ?? 0) > 0) gotRealUsage = true;
            if (ev.sessionId) { acpSessionId = ev.sessionId; console.log(`[engine][usage] sessionId=${ev.sessionId.slice(0,8)} hit=${ev.usage.cacheReadTokens} input=${ev.usage.inputTokens}`); }
            this.opts.sessions.recordUsage(session, ev.usage);
            // 统一落盘 stats：所有 provider 只要发 usage 事件就写 ~/.dsh/<bot>-bot/stats/*.jsonl，
            // 状态条缓存命中率/上下文才有数据源（claude.ts / dsh.ts 的 provider 内落盘已移除，避免双写）。
            recordStats(ev.usage, { sessionId: ev.sessionId, model: this.modelGroup });
            break;
          case 'error': {
            hadError = true;
            // 不覆盖已有内容：错误追加到 layers 末尾，走正常渲染保留已显示的正文/工具
            layers.error = ev.message;
            await quiesce();
            const okErr = await render(buildStreamMarkdown(layers));
            // [根治 A② 2026-09-15] 走到这里时卡片流式通道常常已经自己超时关掉了
            // （实测 code=200850 "card streaming timeout" / 300309 "streaming mode is
            // closed"）。render 失败如果不兜底，用户在飞书端看到的就是"永远停在第一帧、
            // 连个错误都没有"—— 今早那次静默挂死之所以查两小时，就是因为它一声不吭。
            if (!okErr) {
              console.warn(`[engine] error render failed → 补发纯文本错误（不依赖卡片通道）`);
              await this.sendError(chatId, `❌ 引擎报错：${ev.message}`);
            }
            break;
          }
          case 'done':
            break;
        }
      }

      if (!hadError) {
        await quiesce();
        // 语音：只取 agent 专门写的【语音】… 口语文本生成语音（不转整段回复），并把该块从卡片/历史移除
        voiceText = extractVoiceBlock(layers.text);
        if (voiceText) layers.text = stripVoiceBlock(layers.text);
        // 🔴 老大准 09-19（mimo跑野不收尾案）：正文承诺了交付文件却没落盘 → 卡尾自动挂警告
        try {
          const claims = [...layers.text.matchAll(/([A-Za-z]:[\\/][^\s"'、。，；)]{0,200}?\.(?:md|txt|json|csv))/gi)];
          const missing = [...new Set(claims.map((cm) => cm[1]).filter((p) => { try { return !fs.existsSync(p); } catch { return false; } }))];
          if (missing.length > 0) { layers.text += `\n\n⚠️ 报告未落盘：${missing.slice(0, 3).join(' ; ')}`; console.log(`[engine] 产物警告 chat=${chatId.slice(0, 12)} missing=${missing.length}`); }
        } catch { /* 警告失败绝不拦正文 */ }
        const finalText = buildFinalMarkdown(layers);
        console.log(`[engine] FINAL text.len=${layers.text.length} thinking.len=${layers.thinking.length} tools=${layers.toolLines.length} finalText.len=${finalText.length}`);
        const ok = await render(finalText, true);
        if (!ok) {
          console.warn(`[engine] final PATCH failed, fallback to text`);
          const fallback = dividerInfo ? `${finalText}\n\n${buildDividerText(dividerInfo)}` : finalText;
          await this.sendError(chatId, fallback);
        } else if (this.opts.showAgentDivider) {
          // litellm 中转 bot（如 gemini）：CLI 不吐 usage → 从 LiteLLM 记账库按时间窗补拉本轮
          // 累计用量并落盘 stats（recordStats 全 miss 兜底记账），状态条 🟰/📚 才有真实数据
          if (this.usageKind() === 'litellm' && !gotRealUsage) {
            try {
              const u = await readLitellmTurnUsage(this.opts.modelGroup, turnStartTs);
              if (u && (u.inputTokens > 0 || u.outputTokens > 0)) {
                console.log(`[engine][litellm-usage] model=${this.opts.modelGroup} input=${u.inputTokens} output=${u.outputTokens} requests=${u.requests}`);
                // sessionId 必须带上：readCacheStats 按当前 ACP 会话过滤，不带=记录被滤掉=状态条空白
                recordStats({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: 0, requests: u.requests }, { sessionId: acpSessionId, model: this.opts.modelGroup });
              }
            } catch (e) { void e; /* best-effort */ }
          }
          // Arc 用量/余额后台查询完成后再刷一次最终卡状态行（同步读新缓存；无则保持现状）
          await viewLoaded;
          await render(buildFinalMarkdown(layers), true);
          // 状态行含 model/context/session/balance 等可变字段（acpSessionId 在 usage 事件后才真实）。
          // 流式 updateCardElement 只刷正文元素，此处用整卡 body 刷新状态行：session=claude 真实 id、
          // 上下文按最新 stats、余额按最新缓存。失败不影响主回复（best-effort）。
          if (cardId) {
            const fresh = buildDivider();
            await this.opts.feishu.updateCardBody(cardId, buildSimpleCard(buildFinalMarkdown(layers), fresh), ++seq).catch((e) => console.warn(`[engine] divider refresh failed:`, e));
          }
        }
        // 2026-08-31 重启保记忆：记录本轮对话（appendContext 内部 cap 20）+ 落盘
        try {
          sessions.appendContext(session, text, layers.text);
          this.opts.sessions.persist();
        } catch (e) {
          console.warn('[engine] 会话持久化失败:', e);
        }
        // 2026-08-31 自动回执：回复发出后通知桥接（若本会话有待回执的派活 bot，自动转发）
        try {
          await this.opts.onReplySent?.(chatId, layers.text);
        } catch (e) {
          console.warn('[engine] 自动回执转发失败:', e);
        }
      }
      // 语音回复：仅当 agent 回复含专门写的【语音】口语块时 TTS→OPUS→上传→发音频。
      // 无【语音】块则不发语音（不读整段回复正文），失败只记日志不阻塞主回复。
      // 语音回复：用户发的是语音（或要求语音）⇒ 必须回语音。
      // 2026-08-30 兜底（老大实测抓到）：模型没写【语音】块、或块太短（<4 字，reasonix 实测只写 2 字）
      // 时，用正文纯文本（去代码块/markdown，截 200 字）兜底 TTS——保证"发语音 → 回语音"。
      // [2026-09-03] deeptutor 整段跳过：其语音走 DeepTutor 侧 TTS 契约（sources
      // artifact → voiceId 钩子投递），不走桥接【语音】块，避免双语音。
      if (opts?.replyAudio && provider.name !== 'deeptutor') {
        // 2026-08-30 诊断：语音分支入口必打日志（reasonix 曾静默跳过整个分支，无日志无法定位）
        console.log(`[engine] 语音分支: replyAudio=${!!opts?.replyAudio} voiceText.len=${voiceText.trim().length} speech.enabled=${this.opts.speech?.enabled !== false}`);
        let spoken = voiceText.trim();
        const looksLikeRule = /禁止|markdown|代码块|口语写|语音回复规范|朗读/.test(spoken);
        // 2026-08-30 二次修复（老大拍板）：语音回复必须是模型专门写的口语化文本，
        // 禁止朗读正文（正文含代码/路径，不适合念）。块缺失/过短/规则回显时，
        // 向同一会话追问一次让模型专门补写【语音】口语块；仍失败则用固定短语音告知。
        if (spoken.length < 4 || looksLikeRule) {
          console.log(`[engine] 语音块缺失/过短/规则回显，发起补写追问`);
          let nudgeText = '';
          try {
            for await (const ev of provider.streamChat({
              text: '（系统）用户刚发来的是语音消息。请只输出一个【语音】块：针对你上一条回复，用 50 字以内的口语化中文给出结论或答复，像面对面说话；不要念代码、路径、命令、链接。格式：第一行【语音】，第二行口语文本，除此之外不要输出任何内容。',
              sessionKey: session.id,
              systemPrompt: this.buildSystemPrompt(),
              workdir: session.workdir,
            })) {
              if (ev.type === 'text') nudgeText += ev.text;
            }
          } catch (e) { console.warn(`[engine] 语音补写追问失败: ${e instanceof Error ? e.message : String(e)}`); }
          spoken = extractVoiceBlock(nudgeText).trim();
          if (/禁止|markdown|口语写/.test(spoken)) spoken = '';
          console.log(`[engine] 语音补写结果 len=${spoken.length}`);
          if (!spoken) spoken = '这条消息的语音回复没有生成好，麻烦看上面的文字回复。';
        }
        // [2026-09-11 双发修复] 模型若已用 send_voice 工具自己发了语音（pendingVoiceIds 非空），
        // 桥接的 replyAudio 分支不再重复发送——同一轮两条语音 = 老大暴怒点。
        if (spoken && pendingVoiceIds.length > 0) {
          console.log(`[engine] 语音分支跳过：send_voice 已投递 ${pendingVoiceIds.length} 条，避免双发`);
        } else if (spoken) await this.sendVoiceReply(chatId, spoken);
      }
      // [2026-09-01] send_voice 工具产物投递：模型已合成的语音（如 audio8 克隆）直接上传飞书，
      // 不再用桥接 TTS 重合成。失败只记日志不阻塞（工具卡里模型已报成功，这里补真实投递）。
      for (const vid of pendingVoiceIds) {
        try {
          await this.sendVoiceObjectById(chatId, vid);
        } catch (e) {
          console.warn(`[engine] send_voice 投递失败 voiceId=${vid.slice(0, 26)}…: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // [2026-09-17] send_image 工具产物投递：attachmentId(sha256:<64hex>) → 内容寻址对象
      // （DSH_HOME/attachments/v1/objects/<前2位>/<hash>）→ 按魔数定扩展名 → 上传 → 飞书图片消息。
      for (const iid of pendingImageIds) {
        this.ledgerRemove('image-object', iid); // [票1] 发前销账（最多一次）
        try {
          const okImg = await this.sendImageObjectById(chatId, iid);
          if (!okImg) this.ledgerAdd('image-object', iid, chatId); // 失败回账，开机补投递兜底
        } catch (e) {
          this.ledgerAdd('image-object', iid, chatId);
          console.warn(`[engine] send_image 投递失败 attachmentId=${iid.slice(0, 26)}…: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // [2026-09-18 老大令·写死] generate_image 成品自动发飞书（不能只落盘）。
      // 兜底链：①工具 output 路径 ②本轮正文/工具卡/思考 ③本轮 mtime 新鲜 runs 成品
      // zcode 形态：tool 名 mcp__comfy__generate_image / 正文含 Krea2 路径（含空格）
      const turnBlob = `${layers.text}\n${layers.toolLines.join('\n')}\n${layers.thinking}`;
      // 🔴 老大令 2026-09-19：本轮 send_image 已发文件台账 —— 模型发过的桥不得兜底再发（家装图双发根因）
      for (const sm of turnBlob.matchAll(/"(?:imagePath|image_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        try { toolSentPaths.add(path.resolve(JSON.parse('"' + sm[1] + '"')).toLowerCase()); } catch { /* 非 JSON 片段忽略 */ }
      }
      if (/generate_image|__generate_image|comfy__generate|Krea2|文生图|ComfyUI_temp/i.test(turnBlob)) {
        sawGenTool = true;
      }
      if (pendingGenFiles.length === 0) {
        for (const p of this.parseGeneratedImagePaths(turnBlob)) {
          if (/comfyui[\\/]runs|comfyui_temp|Krea2|文生图/i.test(p) && !p.includes("*") && !pendingGenFiles.includes(p) && !isToolSent(p)) {
            pendingGenFiles.push(p);
            this.ledgerAdd('gen-file', p, chatId); // [票1] 兜底捕获同样挂账
            console.log(`[engine] generate_image 兜底捕获(正文) ${p}`);
          }
        }
      }
      if (sawGenTool && pendingGenFiles.length === 0) {
        try {
          const dir = COMFY_RUNS_IMG;
          if (fs.existsSync(dir)) {
            const fresh = fs.readdirSync(dir)
              .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
              .map((f) => path.join(dir, f))
              .filter((p) => {
                try { return fs.statSync(p).mtimeMs >= genTurnStartMs - 3000; } catch { return false; }
              })
              .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
              .slice(0, 3);
            for (const p of fresh) {
              if (!pendingGenFiles.includes(p) && !isToolSent(p)) { // 🔴 09-19 双发防线
                pendingGenFiles.push(p);
                this.ledgerAdd('gen-file', p, chatId); // [票1] 兜底捕获同样挂账
                console.log(`[engine] generate_image 兜底捕获(mtime) ${p}`);
              }
            }
          }
        } catch (e) {
          console.warn(`[engine] generate_image mtime 兜底失败:`, e);
        }
      }
      for (const gp of pendingGenFiles) {
        try {
          if (!fs.existsSync(gp)) {
            console.warn(`[engine] generate_image 自动发图跳过: 文件不存在 ${gp}`);
            this.ledgerRemove('gen-file', gp); // [票1] 永久性失败，销账不留陈账
            continue;
          }
          if (isToolSent(gp)) {
            console.log(`[engine] generate_image 自动发图跳过：send_image 本轮已发 ${gp}`);
            this.ledgerRemove('gen-file', gp); // [票1] send_image 附件号另有台账，销账防开机重发
            continue;
          }
          const gkey = path.resolve(gp).toLowerCase();
          if (this.genAutoDelivered.get(chatId)?.has(gkey)) {
            console.log(`[engine] generate_image 自动发图跳过：桥上一轮已自动发过（跨轮双发防线） ${gp}`);
            this.ledgerRemove('gen-file', gp); // [票1] 已发过=已履约，销账
            continue;
          }
          this.ledgerRemove('gen-file', gp); // [票1] 发前销账（最多一次）
          const ok = await this.sendImageFile(chatId, gp);
          console.log(`[engine] generate_image 自动发图 chat=${chatId} file=${gp} ok=${ok}`);
          if (ok) {
            let s = this.genAutoDelivered.get(chatId);
            if (!s) { s = new Set(); this.genAutoDelivered.set(chatId, s); }
            s.add(gkey);
            if (s.size > 200) s.clear(); // 防膨胀：清空重攒（宁可极旧图可能重现，不可新图永发不出）
          } else {
            this.ledgerAdd('gen-file', gp, chatId); // [票1] 失败回账，开机补投递兜底
          }
        } catch (e) {
          this.ledgerAdd('gen-file', gp, chatId); // [票1] 失败回账
          console.warn(`[engine] generate_image 自动发图失败 ${gp}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // [2026-09-03] deeptutor 语音投递：口语稿 → 控制中心 TTS（sendVoiceReply）→ opus → 飞书。
      // 音色随控制中心语音配置全局变；失败只记日志不阻塞（文字回复已发出）。
      if (deeptutorSpoken) {
        try {
          await this.sendVoiceReply(chatId, deeptutorSpoken);
        } catch (e) {
          console.warn(`[engine] deeptutor 语音投递失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // [2026-09-03] deeptutor 图片/视频/文件成品投递：下载 → 按类型上传 → 发消息
      // （image → 图片消息；video/其他 → 文件消息，飞书端可预览/下载）。
      for (const m of pendingMedia) {
        const tmpDir = path.join(os.tmpdir(), 'agents-to-feishu-media');
        const ext = path.extname(m.filename) || (m.mime_type.includes('png') ? '.png' : m.mime_type.includes('jpeg') ? '.jpg' : '.bin');
        const tmpFile = path.join(tmpDir, `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
        try {
          fs.mkdirSync(tmpDir, { recursive: true });
          const r = await fetch(m.url);
          if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
          const data = Buffer.from(await r.arrayBuffer());
          if (data.length < 256) throw new Error(`文件过小 ${data.length}B`);
          fs.writeFileSync(tmpFile, data);
          if (m.mime_type.startsWith('image/')) {
            const imageKey = await this.opts.feishu.uploadImage(tmpFile);
            await this.opts.feishu.sendImage(chatId, imageKey);
            console.log(`[engine] deeptutor 图片已投递 chat=${chatId} file=${m.filename} (${data.length}B)`);
          } else {
            const fileKey = await this.opts.feishu.uploadFile(tmpFile, 'stream');
            await this.opts.feishu.sendFile(chatId, fileKey);
            console.log(`[engine] deeptutor 文件已投递 chat=${chatId} file=${m.filename} (${data.length}B, ${m.mime_type})`);
          }
        } catch (e) {
          console.warn(`[engine] deeptutor 成品投递失败 ${m.filename}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch { /* 忽略 */ }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await render(buildErrorMarkdown(msg));
      } catch {
        await this.sendError(chatId, `引擎异常：${msg}`);
      }
      // [2026-09-19 票1] 断头轮补投递：异常让正常收尾的投递链整体被跳过（此前=图烂在台账里，
      // 15:55 家装案）。本轮已捕获产物有则补发+一句说明，无则静默。
      await this.rescueInterruptedRound(chatId, pendingImageIds, pendingGenFiles, layers, isToolSent);
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      this.streamCards.delete(chatId);
      // 本任务结束：若 activeTaskMid 仍指向自己则清除（让插队 interrupt 检测到"旧任务已结束"）
      if (this.activeTaskMid.get(chatId) === (_replyToMessageId ?? undefined)) this.activeTaskMid.delete(chatId);
    }
  }

  /** 错误兜底：纯文本（不引用），保证用户看得到 */
  private async sendError(chatId: string, text: string): Promise<void> {
    try {
      await this.opts.feishu.sendText(chatId, text);
    } catch (e) {
      console.error(`[engine] sendError failed:`, e);
    }
  }

  /** 语音回复：TTS 合成（文本=agent 写的【语音】口语块）→ OPUS 转码 → 上传 → 发音频。失败只记日志，不阻塞主回复。 */
  /** 发送语音回复（TTS→opus→飞书语音消息）。2026-08-29 起公开：内置工具 send_voice 的桥接通道 */
  async sendVoiceReply(chatId: string, text: string): Promise<void> {
    // 2026-08-30：改用实时 getter（hermes 曾因 opts.speech 静默 return 无日志）；入口必打日志
    const speech = this.speech;
    if (!speech || speech.enabled === false) {
      console.log(`[engine] 语音发送跳过: speech=${!!speech} enabled=${speech?.enabled}`);
      return;
    }
    const spoken = text.trim();
    if (!spoken) return;
    console.log(`[engine] 语音发送开始: engine=${speech.tts?.defaultEngine} spoken.len=${spoken.length}`);
    try {
      const r = await synthesize(spoken, speech.tts as TtsConfig);
      if (!r.ok || !r.data) {
        console.warn(`[engine] TTS 失败，跳过语音回复: ${r.error}`);
        return;
      }
      const opus = await toOpus(r.data);
      if (!opus) {
        console.warn(`[engine] TTS→OPUS 转码失败，跳过语音回复`);
        return;
      }
      // 时长审计（opus 24kbps 恒定码率估算）：抓"内容念两遍/变速"类问题
      console.log(`[engine] opus 转码完成: bytes=${opus.length} 估算时长=${(opus.length * 8 / 24000).toFixed(1)}s（文本 ${spoken.length} 字）`);
      const tmpDir = path.join(os.tmpdir(), 'agents-to-feishu-tts');
      fs.mkdirSync(tmpDir, { recursive: true });
      const file = path.join(tmpDir, `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.opus`);
      fs.writeFileSync(file, opus);
      try {
        const fileKey = await this.opts.feishu.uploadFile(file, 'opus');
        await this.opts.feishu.sendAudio(chatId, fileKey);
        console.log(`[engine] 语音回复已发送 chat=${chatId} spoken.len=${spoken.length} 口语内容="${spoken.slice(0, 60)}"`);
      } finally {
        try { fs.unlinkSync(file); } catch { /* 忽略 */ }
      }
    } catch (e) {
      console.warn(`[engine] 语音回复失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * [2026-09-01] send_voice 工具产物投递：voiceId(sha256:<64hex>) → 内容寻址对象
   * （DSH_HOME/attachments/v1/objects/<前2位>/<hash>）→ opus 转码 → 上传 → 飞书语音消息。
   * 与 sendVoiceReply 的区别：不重新 TTS，直接投递 agent 侧已合成的音频（audio8 克隆等本地引擎）。
   */
  async sendVoiceObjectById(chatId: string, voiceId: string): Promise<void> {
    const hash = voiceId.replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      console.warn(`[engine] send_voice 投递跳过: voiceId 格式不对 "${voiceId.slice(0, 26)}…"`);
      return;
    }
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const objFile = path.join(home, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash);
    let data: Buffer;
    try {
      data = fs.readFileSync(objFile);
    } catch {
      console.warn(`[engine] send_voice 投递跳过: 语音对象不存在 ${objFile}`);
      return;
    }
    const opus = await toOpus(data);
    if (!opus) {
      console.warn('[engine] send_voice 语音对象→OPUS 转码失败，跳过投递');
      return;
    }
    const tmpDir = path.join(os.tmpdir(), 'agents-to-feishu-tts');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `sendvoice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.opus`);
    fs.writeFileSync(tmpFile, opus);
    try {
      const fileKey = await this.opts.feishu.uploadFile(tmpFile, 'opus');
      await this.opts.feishu.sendAudio(chatId, fileKey);
      console.log(`[engine] send_voice 语音已投递 chat=${chatId} voiceId=${hash.slice(0, 16)}… opus=${opus.length}B`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* 忽略 */ }
    }
  }

  /**
   * [2026-09-17] send_image 工具产物投递：attachmentId(sha256:<64hex>) → 内容寻址对象
   * （DSH_HOME/attachments/v1/objects/<前2位>/<hash>）→ 上传 → 飞书图片消息。
   * 与 sendVoiceObjectById 对称；对象落盘时是原图字节，按魔数补扩展名即可直接上传。
   * [2026-09-19 票1] 返回是否真实投递成功（断头轮台账回账判据）。
   */
  async sendImageObjectById(chatId: string, attachmentId: string): Promise<boolean> {
    const hash = attachmentId.replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      console.warn(`[engine] send_image 投递跳过: attachmentId 格式不对 "${attachmentId.slice(0, 26)}…"`);
      return false;
    }
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const objFile = path.join(home, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash);
    let data: Buffer;
    try {
      data = fs.readFileSync(objFile);
    } catch {
      console.warn(`[engine] send_image 投递跳过: 图片对象不存在 ${objFile}`);
      return false;
    }
    const ext = sniffImageExt(data);
    if (!ext) {
      console.warn(`[engine] send_image 投递跳过: 无法识别的图片格式 hash=${hash.slice(0, 16)}…`);
      return false;
    }
    const tmpDir = path.join(os.tmpdir(), 'agents-to-feishu-img');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `sendimg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(tmpFile, data);
    try {
      const ok = await this.sendImageFile(chatId, tmpFile);
      console.log(`[engine] send_image 图片已投递 chat=${chatId} hash=${hash.slice(0, 16)}… bytes=${data.length} ok=${ok}`);
      return ok;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* 忽略 */ }
    }
  }

  // ── [2026-09-19 票1] 断头轮补投递 ──

  /** 投递单条台账：发前先销账（每条最多投递一次，防 crash 窗口双发）；明确失败回账等下次开机重试，
   *  gen-file 源文件已消失的永久失败不回账（重试无意义）。 */
  private async deliverOnePending(e: PendingDeliveryEntry): Promise<boolean> {
    this.ledgerRemove(e.kind, e.ref);
    try {
      if (e.kind === 'gen-file') {
        if (!fs.existsSync(e.ref)) {
          console.warn(`[engine][断头轮补投递] 跳过: 文件不存在 ${e.ref}`);
          return false;
        }
        const ok = await this.sendImageFile(e.chatId, e.ref);
        console.log(`[engine][断头轮补投递] gen-file ok=${ok} ${e.ref}`);
        if (ok) {
          // 同步登记票C 跨轮防线：补发过的图，正文再提及也不得重发
          const gkey = path.resolve(e.ref).toLowerCase();
          let s = this.genAutoDelivered.get(e.chatId);
          if (!s) { s = new Set(); this.genAutoDelivered.set(e.chatId, s); }
          s.add(gkey);
        } else {
          this.ledgerAdd(e.kind, e.ref, e.chatId, e.ts);
        }
        return ok;
      }
      const ok = await this.sendImageObjectById(e.chatId, e.ref);
      console.log(`[engine][断头轮补投递] image-object ok=${ok} ${e.ref.slice(0, 26)}…`);
      if (!ok) this.ledgerAdd(e.kind, e.ref, e.chatId, e.ts);
      return ok;
    } catch (err) {
      console.warn(`[engine][断头轮补投递] 失败回账 ${e.kind} ${e.ref.slice(0, 40)}: ${err instanceof Error ? err.message : String(err)}`);
      this.ledgerAdd(e.kind, e.ref, e.chatId, e.ts);
      return false;
    }
  }

  /** 开机扫账：上一进程死掉时已在台账里的产物逐条补发；有成功且带 chatId 的才补一句说明。无陈账静默。 */
  private async rescuePendingDeliveriesOnBoot(): Promise<void> {
    const entries = this.ledgerLoad();
    if (entries.length === 0) return;
    console.log(`[engine][断头轮补投递] 开机扫账: ${entries.length} 条待补发`);
    const STALE_MS = 7 * 24 * 3600 * 1000;
    const deliveredByChat = new Map<string, number>();
    for (const e of entries) {
      if (Date.now() - e.ts > STALE_MS) {
        this.ledgerRemove(e.kind, e.ref);
        console.warn(`[engine][断头轮补投递] 超过 7 天的陈账作废: ${e.kind} ${e.ref.slice(0, 40)}`);
        continue;
      }
      if (await this.deliverOnePending(e)) {
        deliveredByChat.set(e.chatId, (deliveredByChat.get(e.chatId) ?? 0) + 1);
      }
    }
    for (const [chatId, n] of deliveredByChat) {
      console.log(`[engine][断头轮补投递] chat=${chatId.slice(0, 12)}… 补发 ${n} 张完成`);
      try { await this.sendText(chatId, '上一轮被打断，图已补发'); } catch { /* 说明句失败不影响补发结果 */ }
    }
  }

  /**
   * 轮次异常收尾补投递（provider 流 throw → handleText 外层 catch）：正常收尾的投递链被异常
   * 整体跳过，这里把本轮已捕获产物补发出去。正文兜底捕获对齐正常收尾（轮子死在 tool done
   * 事件之前时，成品路径只留在正文/工具层里）。无产物静默，不打扰。
   */
  private async rescueInterruptedRound(
    chatId: string,
    pendingImageIds: string[],
    pendingGenFiles: string[],
    layers: TurnLayers,
    isToolSent: (p: string) => boolean,
  ): Promise<void> {
    try {
      if (pendingGenFiles.length === 0) {
        const turnBlob = `${layers.text}\n${layers.toolLines.join('\n')}\n${layers.thinking}`;
        for (const p of this.parseGeneratedImagePaths(turnBlob)) {
          if (/comfyui[\\/]runs|comfyui_temp|Krea2|文生图/i.test(p) && !p.includes("*") && !pendingGenFiles.includes(p) && !isToolSent(p)) {
            pendingGenFiles.push(p);
            this.ledgerAdd('gen-file', p, chatId);
            console.log(`[engine][断头轮补投递] 正文兜底捕获 ${p}`);
          }
        }
      }
      if (pendingImageIds.length === 0 && pendingGenFiles.length === 0) return; // 无产物 → 静默
      console.log(`[engine][断头轮补投递] 轮次被打断 chat=${chatId.slice(0, 12)}… imageIds=${pendingImageIds.length} genFiles=${pendingGenFiles.length}，开始补发`);
      let delivered = 0;
      for (const iid of pendingImageIds) {
        if (await this.deliverOnePending({ kind: 'image-object', ref: iid, chatId, ts: Date.now() })) delivered += 1;
      }
      for (const gp of pendingGenFiles) {
        if (isToolSent(gp)) { this.ledgerRemove('gen-file', gp); continue; } // send_image 本轮已投递，勿重发（双发台账）
        if (await this.deliverOnePending({ kind: 'gen-file', ref: gp, chatId, ts: Date.now() })) delivered += 1;
      }
      if (delivered > 0) {
        await this.sendText(chatId, '上一轮被打断，图已补发');
        console.log(`[engine][断头轮补投递] chat=${chatId.slice(0, 12)}… 补发完成 ${delivered} 张`);
      }
    } catch (e) {
      // 补投递自身出错不得外抛（已在 catch 块里，吞掉只留日志）
      console.warn(`[engine][断头轮补投递] 补投递自身失败:`, e);
    }
  }

  /** 系统提示词：内置身份描述 + 统一注入(读 config/prompts/*.md) + 独立注入(每 agent) */
  private buildSystemPrompt(): string {
    const base = `你是 ${this.opts.botName}，通过飞书桥接的 AI 助手。请用中文简洁回答。`;
    // 2026-08-31 服务级通讯协议（统一注入所有 bot，替代旧人设教程；工具由服务提供，零提示词依赖）
    const protocol = [
      '【bot 间通讯协议（服务注入，必须遵守）】',
      '1. 收到其他 bot 的传话后，直接正常文字回复即可——桥接会自动把回复转达给对方；切勿调 lark_send_as_user 回执（对方会收到两条重复）。',
      '2. 群里 @ 人或 @ bot：先 lark_chat_members 查 id，再用 lark_send_as_user 群发消息（bot 身份发消息无法正确 @ 其他 bot）。',
      '3. 严禁用翻聊天记录/猜内容的方式代替真实通讯——没收到对方消息就说没收到，不能自己编。',
    ].join('\n');
    // 2026-08-31 内置资源说明（对齐语音/识图的"天生可用"定调）：GitHub token 已注入进程环境，
    // 网络搜索优先用 anysearch（已为支持的 runtime 挂 MCP），避免 agent 用残缺凭据瞎试后自以为"没权限"
    const builtin = [
      '【内置资源（服务注入，天生可用）】',
      '- GitHub：环境变量 GITHUB_TOKEN / GH_TOKEN 已注入（gh CLI 自动识别 GH_TOKEN；REST API 用 header `Authorization: token $GITHUB_TOKEN`；git push 用 `https://$GITHUB_TOKEN@github.com/...` 形式）。不要说"token 无效/未认证"。',
      '- 网络搜索：优先用 anysearch MCP 工具（若工具列表有）；没有该工具时再考虑其他途径。内置 google_web_search 在中转模型下不可用，勿反复重试。',
    ].join('\n');
    // 2026-09-18 防截断输出规范（源自 openmem 2699b8ab 终稿）：模型抽风期多行长正文
    // 经 send_as_user 链路偶发只剩首行标题（共享链路三层已实测清白，系模型层间歇行为）。
    // 服务级统一注入，让全 bot 天生按规范输出，不依赖各家人设教程。
    const larkOutput = [
      '【lark 工具输出规范（服务注入，防截断）】',
      '- 重要回报先写 openmem（mh_write），飞书消息只当通知锚：标题行 + openmem 条目 id。多行长正文偶发只剩首行，锚定了就不丢。',
      '- lark_send_text / lark_send_as_user 的 text 尽量单行紧凑；多段结构化内容改用 lark_send_post（富文本段落数组天然分行）。',
      '- 若对方反馈只收到标题行：属模型层间歇行为，按上面两条规范重发即可，不要反复复测链路。',
      '- 若工具列表没有 lark_* 但有 call_mcp_tool：用 call_mcp_tool(server="cti-builtin", tool_name="lark_xxx", arguments={...}) 间接调用（openakita 等原生 MCP 引擎的姿势）。',
    ].join('\n');
    const inject = this.opts.systemPrompt?.trim();
    return `${base}\n\n${protocol}\n\n${builtin}\n\n${larkOutput}` + (inject ? `\n\n${inject}` : '');
  }
}
