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

/** 从 ~/.dsh/<bot>/stats/YYYY-MM-DD.jsonl 读缓存命中率与上下文用量。
 *  传入 sessionId 时只统计该对话的累计（按当前对话算），否则全量统计（按天）。 */
function readCacheStats(contextLimitTokens: number, sessionId?: string): { lastRate: number; avgRate: number; contextPercent: number; contextUsed: number; contextLimit: number } | null {
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
    const CONTEXT_LIMIT_TOKENS = contextLimitTokens > 0 ? contextLimitTokens : 1_000_000;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: { source?: string; cache_hit?: number; cache_miss?: number; prompt?: number; session?: string };
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.source !== 'cli') continue;
      // 按当前对话统计：指定了 sessionId 就只算该对话的记录
      if (sessionId && rec.session !== sessionId) continue;
      const hit = Number(rec.cache_hit ?? 0);
      const miss = Number(rec.cache_miss ?? 0);
      if (hit + miss <= 0) continue;
      lastRate = (hit / (hit + miss)) * 100;
      sumHit += hit;
      sumMiss += miss;
      if (rec.prompt != null && Number(rec.prompt) > 0) lastPromptTokens = Number(rec.prompt);
    }
    if (lastRate == null || sumHit + sumMiss <= 0) return null;
    const avgRate = (sumHit / (sumHit + sumMiss)) * 100;
    const contextPercent = lastPromptTokens != null
      ? Math.min(100, (lastPromptTokens / CONTEXT_LIMIT_TOKENS) * 100)
      : 0;
    return { lastRate, avgRate, contextPercent, contextUsed: lastPromptTokens ?? 0, contextLimit: CONTEXT_LIMIT_TOKENS };
  } catch {
    return null;
  }
}

export class MessageEngine {
  private opts: EngineOptions;
  /** chatId → 当前轮流式卡 message_id（一轮一卡） */
  private streamCards = new Map<string, string>();
  /** chatId → 串行任务链（同一聊天室的消息排队执行，防止 ACP 并发撞车） */
  private chatQueues = new Map<string, Promise<void>>();

  readonly modelGroup: string;
  readonly modelProvider: string;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.modelGroup = opts.modelGroup;
    this.modelProvider = opts.modelProvider;
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
    const previous = this.chatQueues.get(chatId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.chatQueues.set(chatId, next);
    try {
      await next;
    } finally {
      if (this.chatQueues.get(chatId) === next) {
        this.chatQueues.delete(chatId);
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
    let flushing = false;
    const doFlush = async (): Promise<void> => {
      if (flushing) return;
      flushing = true;
      try {
        await render(buildStreamMarkdown(layers));
      } catch { /* 网络/临时错误：下轮事件会再刷 */ } finally {
        flushing = false;
      }
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
    /** 停止定时器并等待在途 PATCH 完成（防止最终卡被过期的流式视图覆盖） */
    const quiesce = async (): Promise<void> => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // 节流兜底定时器也要清：否则 FINAL 渲染后被过期的流式视图覆盖（终卡闪回旧内容）
      if (textFlushTimer) { clearTimeout(textFlushTimer); textFlushTimer = null; }
      if (thinkFlushTimer) { clearTimeout(thinkFlushTimer); thinkFlushTimer = null; }
      while (flushing) await new Promise((r) => setTimeout(r, 25));
    };

    try {
      // 2026-08-29 修复：
      // - workdir：把 /new [目录] 绑定的工作目录真正传给 provider（此前字段缺失，目录切换从未生效）
      // - history：新建会话时带上会话上下文（含 /compact 产出的摘要），对齐老项目
      //   compact.ts applyCompactResult —— 摘要作为 user 消息进入新会话，下轮自然携带。
      // 2026-08-30 修复：语音回复规范每轮随文携带（此前 systemPrompt 仅会话首条注入，
      // 老会话不知道【语音】块约定 ⇒ TTS 对老会话失效，实测 claude/dsh 语音回复=0）
      const VOICE_RULE_TURN = '\n\n[回复格式提醒] 若用户发来的是语音、或明确要求语音回复（如"用语音回答"）：在回复末尾追加一个【语音】块——单独一行"【语音】"，下一行写口语文本（禁 markdown/代码/表格）；未被要求时不写该块。';
      const turnStartTs = Date.now(); // litellm 中转 bot 补拉用量用（按时间窗过滤记账库）
      let gotRealUsage = false; // 只有"非全 0"的 usage 事件才算真实（gemini CLI 恒发 0 值事件）
      for await (const ev of provider.streamChat({
        text: `${text}${VOICE_RULE_TURN}`,
        sessionKey: session.id,
        freshSession: fresh,
        systemPrompt: this.buildSystemPrompt(),
        workdir: session.workdir,
        ...((fresh || interrupted) && session.context.length > 0 ? { history: [...session.context] } : {}),
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
            scheduleFlush();
            break;
          }
          case 'usage':
            if (ev.usage.inputTokens + ev.usage.outputTokens + (ev.usage.cacheReadTokens ?? 0) > 0) gotRealUsage = true;
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
            await render(buildStreamMarkdown(layers));
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
      if (opts?.replyAudio) {
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
        if (spoken) await this.sendVoiceReply(chatId, spoken);
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await render(buildErrorMarkdown(msg));
      } catch {
        await this.sendError(chatId, `引擎异常：${msg}`);
      }
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
    const inject = this.opts.systemPrompt?.trim();
    return `${base}\n\n${protocol}\n\n${builtin}` + (inject ? `\n\n${inject}` : '');
  }
}
