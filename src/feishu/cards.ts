/**
 * 卡片构建器 —— 单卡分层渲染，严格移植本地 agents-to-im 的拼装逻辑。
 *
 * 参考原实现（C:\D\opt\agents-to-im\src\bridge\bridge-manager.ts）：
 * - 流式过程：flushPreview/buildCombined（578-593 行）
 * - 最终态：replace_preview（2297-2318 行）
 *
 * 风格要点（用户验收标准，勿改）：
 * - 💭 思考层 = blockquote（每行前缀 ">"）：左侧竖线、自动换行、小字
 * - 🔧 工具层 = 代码块包裹：一行一个工具，不换行
 * - 全程一张卡原地 PATCH；无 header 横幅、不引用用户消息
 * - 最终态底部加状态分割线（Agent | Model | Provider | Session | Cache）
 */

// ── 基础卡片 ──

/** CardKit 流式元素 id（对齐老项目 constants.ts STREAM_ELEMENT_ID） */
export const STREAM_ELEMENT_ID = 'stream_content';

/**
 * 流式骨架：CardKit 卡片实体（element_id 必须有，cardElement.content 增量更新靠它定位）。
 * 2026-08-29 定案（官方文档 + 隔离实验双证实）：开启流式的唯一有效方式是【创建时】在
 * config 里设 streaming_mode: true（SDK 文档原文"在卡片 JSON 中将 streaming_mode 设为 true"）。
 * 此前注释以为"放 config 反而 300309"是误判——真实原因是当时【从未开启】流式。
 * settings API 里的 streaming_mode 字段是假成功（code=0 但不生效），只可用于终态关闭 + summary。
 */
export function buildStreamingCardSkeleton(dividerInfo?: DividerInfo): unknown {
  // status 初值空串 = 卡片顶部不多出一行（心跳已迁底部状态栏）；实测空 content 建卡可接受
  return buildStreamCard(
    { status: '', tools: '', thinking: '', text: '', divider: '' },
    dividerInfo,
  );
}

// ── 流式多元素视图（T-0032 2026-10-02 老大令·治本）─────────────────────────
// 实测结论（本机脚本 + 群里真实卡片，opencode 凭据）：
//  · 2.0 骨架 cardkit.create 正常（旧注释里"建卡失败"是测试脚本用了 1.0 卡片：
//    飞书报的 `body is nil` 指的是【卡片 JSON 缺 body 字段】，不是 HTTP body、不是权限）。
//  · cardElement.content 多元素并行流式全部 code=0（状态/工具/思考/正文 各一个 element_id）。
//  · 官方打字机语义 = 新内容以已推送内容为前缀才"末尾追加"，否则整块重画
//    ⇒ 旧单元素 buildStreamMarkdown 每帧重排（💭 尾部 400 窗口 / 🔧 标题 执行中↔已完成 /
//      移动的 --- 分隔线 / 工具行就地打 ✅）帧帧都不是前缀延续 ⇒ 老大看到的
//      "打印一半又重新打印、反反复复"。分元素后每层各自只增，天然单调。
//  · 单卡通货流式硬上限实测 ≈605s ⇒ code=200850 card streaming timeout；
//    静默 480s 不会死（不是空闲超时），长任务一定会撞总时长上限。
//  · settings(streaming=false) 或整卡 im PATCH 之后，cardElement.content 一律
//    code=300309 streaming mode is closed，且 settings(true) **救不回来**；
//    唯一有效的续命法 = cardkit card.update 传 config.streaming_mode:true 的整卡（实测之后推送恢复 code=0）。
//  · 静默期"看不到在动"：短行元素允许原地重写（代价极小）⇒ 心跳计时有处可放。

export const EL_STATUS = 'el_status';
export const EL_TOOLS = 'el_tools';
export const EL_THINK = 'el_think';
// [T-0035 2026-10-03 老大令] 心跳从顶部状态元素挪到【底部状态栏】：顶部那行离正文太远，
// 观察要来回滚。挪动的唯一前提是状态栏自己得有 element_id —— 旧写法是条静态 markdown（无 id），
// 天生刷不动，所以现在给它开一条流式通道（同原地重写语义，只影响这一行，不碰正文前缀）。
export const EL_DIVIDER = 'el_divider';

/** 流式视图（各元素各自的内容；顺序固定 = 状态→工具→思考→正文→状态栏） */
export interface StreamViews {
  status: string;
  tools: string;
  thinking: string;
  text: string;
  /** 状态栏那一行（含流式期间的心跳尾巴）；无状态栏的 bot 为空串 = 该元素不存在 */
  divider: string;
}

/** 单元素字符顶：超顶即冻结（宁可少显示，也不回收已推出去的前缀） */
const STREAM_EL_CAP = 20000;
const STREAM_THINK_CAP = 6000;
const STREAM_TOOL_LINES = 60;

/**
 * 状态栏那一行的 markdown：`---` + 小字状态条；流式期间把心跳 tail 并进【同一行末尾】
 * （老大 2026-10-03 令：秒数写在卡片顶部离正文太远，要看着费劲 —— 挪进状态栏才顺手）。
 */
export function dividerMarkdown(info: DividerInfo, tail: string): string {
  // info.tail = 终卡要留的耗时（老大 2026-10-03 令：结果卡状态栏也别把秒数弄丢）
  return `---\n${appendDividerTail(buildDividerText(info), tail || info.tail || '')}`;
}

/** 流式期间状态栏的【极简形态】：整行只剩一个秒数，路径/模型/余额一概不出现
 *  （老大 2026-10-03 令：过程中那行太长，"应该只显示用多少秒"）。
 *  终卡由 buildSimpleCard / dividerMarkdown 恢复完整字段 + 末尾总耗时。 */
export function dividerSecondsOnlyMarkdown(tail: string): string {
  return `---\n<font size="s">${tail}</font>`;
}

/** 状态行整体被 <font size="s">…</font> 包住 → 心跳塞进同一行；包不住就退化成下一行小字 */
function appendDividerTail(base: string, tail: string): string {
  if (!tail) return base;
  if (base.endsWith('</font>')) return `${base.slice(0, -'</font>'.length)}｜${tail}</font>`;
  return `${base}\n<font size="s">${tail}</font>`;
}

export function buildStreamElements(v: StreamViews, dividerInfo?: DividerInfo): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', element_id: EL_STATUS, content: v.status },
    { tag: 'markdown', element_id: EL_TOOLS, content: v.tools },
    { tag: 'markdown', element_id: EL_THINK, content: v.thinking },
    { tag: 'markdown', element_id: STREAM_ELEMENT_ID, content: v.text },
  ];
  // 状态栏【必须带 element_id】才存在流式通道（心跳/余额才能中途刷进来）；
  // 关了 showAgentDivider 的 bot 没有这行 → 不建元素，engine 侧也不会推它。
  const divMd = v.divider || (dividerInfo ? dividerMarkdown(dividerInfo, '') : '');
  if (divMd) {
    elements.push({ tag: 'markdown', element_id: EL_DIVIDER, content: divMd });
  }
  return elements;
}

/** 流式整卡：创建 & 通道续命共用（streaming_mode 必须 true） */
export function buildStreamCard(v: StreamViews, dividerInfo?: DividerInfo): unknown {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true, streaming_mode: true },
    body: { elements: buildStreamElements(v, dividerInfo) },
  };
}

/** 降级（无 CardKit 通道）时把四视图压成一段文本，走整卡 PATCH */
export function flattenStream(v: StreamViews): string {
  return [v.status, v.tools, v.thinking, v.text].filter((s) => s && s.trim()).join('\n\n---\n\n') || '⏳ 正在处理…';
}

/**
 * 流式视图累积器：对外的唯一契约是"每层只增"。
 * engine 在事件里直接喂增量（不再从 layers 反推），因此不受 layers 侧尾部窗口/打标改写影响。
 */
export class StreamView {
  private v: StreamViews = { status: '', tools: '', thinking: '', text: '', divider: '' };
  private toolsFrozen = false;
  private thinkFrozen = false;
  private dividerInfo?: DividerInfo;
  private dividerTail = '';
  /** true = 流式极简形态（状态栏只有秒数），此时基线/尾字写入一律靠后站 */
  private dividerOnly = false;

  constructor(dividerInfo?: DividerInfo) {
    this.setDividerInfo(dividerInfo);
  }

  views(): StreamViews {
    return { ...this.v };
  }

  /** 状态栏基线：余额/上下文/命中率是后台预取的，取到就更新（只影响状态栏这一行） */
  setDividerInfo(info?: DividerInfo): void {
    this.dividerInfo = info;
    this.refreshDivider();
  }

  /** 心跳与阶段提示 → 写进【底部状态栏】，不再挂卡片顶部（老大 2026-10-03 令） */
  setDividerTail(t: string): void {
    if (this.dividerOnly) return; // 极简形态下不吃基线，只认 setDividerSeconds
    this.dividerTail = t.slice(0, 160);
    this.refreshDivider();
  }

  /** 流式期间状态栏【整行只留一个秒数】：路径/模型/余额一概不出现
   *  （老大 2026-10-03 令：过程中那行太长，只要"盯着一串数字在不在跳"） */
  setDividerSeconds(t: string): void {
    if (!this.dividerInfo) return; // 关了 showAgentDivider 的 bot 没有这个元素，别去推
    this.dividerOnly = true;
    this.v.divider = dividerSecondsOnlyMarkdown(t.slice(0, 40));
  }

  /** 退出极简形态 → 恢复完整状态栏（终卡前调用） */
  restoreDivider(): void {
    this.dividerOnly = false;
    this.dividerTail = '';
    this.refreshDivider();
  }

  private refreshDivider(): void {
    if (!this.dividerInfo) { this.v.divider = ''; return; }
    if (this.dividerOnly) return; // 极简形态由 setDividerSeconds 自己维护
    this.v.divider = dividerMarkdown(this.dividerInfo, this.dividerTail);
  }

  /** 顶部状态元素：心跳迁走后基本闲置（骨架初值为空串 ⇒ 顶部不再多出一行） */
  setStatus(s: string): void {
    this.v.status = s.slice(0, 200);
  }

  pushToolLine(line: string, capLines = STREAM_TOOL_LINES): void {
    if (this.toolsFrozen) return;
    if (!this.v.tools) this.v.tools = '🔧 工具执行';
    if (this.v.tools.length >= STREAM_EL_CAP) { this.toolsFrozen = true; return; }
    this.v.tools += `\n${line.slice(0, 160)}`;
    if ((this.v.tools.match(/\n/g)?.length ?? 0) >= capLines) {
      this.v.tools += '\n…（工具行过多，此处冻结，完整清单见终卡）';
      this.toolsFrozen = true;
    }
  }

  pushThinking(delta: string): void {
    if (this.thinkFrozen || !delta) return;
    if (!this.v.thinking) this.v.thinking = '> 💭 **思考中…**\n> ';
    // delta 内每个换行都补 "> "，使整块保持 blockquote；已推字符绝不回收
    const out = delta.replace(/\n/g, '\n> ');
    const room = STREAM_THINK_CAP - this.v.thinking.length;
    if (out.length > room) {
      if (room > 0) this.v.thinking += out.slice(0, room);
      this.v.thinking += '\n…（思考过长，此处折叠，完整见终卡）';
      this.thinkFrozen = true;
      return;
    }
    this.v.thinking += out;
    if (this.v.thinking.length >= STREAM_EL_CAP) this.thinkFrozen = true;
  }

  /** 正文：layers.text 天然只增，这里只接受"以旧为前缀"的增量；被整体改写时按新增段落续写 */
  pushText(full: string): void {
    if (this.v.text.endsWith('…（正文过长已冻结）')) return;
    if (full.startsWith(this.v.text)) {
      const delta = full.slice(this.v.text.length);
      if (!delta) return;
      if (this.v.text.length + delta.length > STREAM_EL_CAP) {
        const room = Math.max(0, STREAM_EL_CAP - this.v.text.length);
        this.v.text += delta.slice(0, room) + '…（正文过长已冻结，完整见终卡/文件）';
        return;
      }
      this.v.text += delta;
      return;
    }
    // 罕见：provider 整体改写正文（失败轮补人话等）⇒ 不回收历史，另起一段续写
    this.v.text += `\n\n${full}`;
  }

  /** 错误块：作为正文的追加段落贴上去（只增），绝不重排已推内容 */
  pushError(message: string): void {
    if (!message) return;
    this.v.text += `\n\n${errorBlock(message)}`;
  }
}

export interface DividerInfo {
  agent?: string;
  model?: string;
  provider?: string;
  session?: string;
  dir?: string;
  /** 状态栏样式（2026-08-30 二选一）：icon=每段只图标 | text=每段只文字 */
  dividerMode?: 'full' | 'icon' | 'text' | 'value';
  /** [票mm-1·09-19 审计] null=引擎未上报缓存拆分（卡尾该段显示 N/A，不是 0%）；undefined=无源照旧 */
  cacheHitRate?: number | null;
  cacheAvgRate?: number | null;
  /** 上下文占用（百分比 + 已用/上限 tokens） */
  contextPercent?: number;
  contextUsed?: number;
  contextLimit?: number;
  /** 余额视图（深求/gw 直连） */
  balance?: { currency: string; total: string } | null;
  /** 消耗系数（wb-shim 模型目录的 credits_rate，如 "x0.08 credits"）——2026-10-14 老大令 */
  creditsRate?: string | null;
  /** Ark 套餐配额（volc-ark） */
  usage?: Array<{ label: string; pct: number }> | null;
  /** 显示项开关（缺省=全部）：agent/model/provider/dir/session/cache/avg/context/balance/usage */
  fields?: string[];
  /** 常驻尾字：终卡用它保留本轮总耗时（如 `⏳ 用时 41s`）。老大 2026-10-03 令：结果卡也别把秒数弄丢 */
  tail?: string;
}

// 状态行图标（reasonix 风格，与 13600 概览页一致）
const DIV_IC: Record<string, string> = {
  agent: '🤖', model: '⚙️', provider: '☁️', dir: '📁', session: '💬',
  cache: '🎯', avg: '🟰', context: '📚', balance: '💰', usage: '⏱️', rate: '🔢',
};

export function buildDividerText(info: DividerInfo): string {
  const show = (f: string) => !info.fields || !info.fields.length || info.fields.includes(f);
  // 2026-09-01 三模式（数值在任何模式下都必须显示，只是标注方式不同）：
  // full（默认/含旧 icon）= 🤖 DSH｜⚙️ glm5.3｜☁️ Ark｜📁 …（图标+数值，全角｜）
  // text  = Agent: openakita | Model: … | Provider: … | Session: … | Cache: … | 平均: … | Balance: …（带英文标签，半角 | ）
  // value = openakita | ark-deepseek-v4 | Ar | feb1c821 | 36.42% | 36.42% | ⏱️ 5h0% … | ¥95.55（只有值，无图标无标签）
  const textMode = info.dividerMode === 'text';
  const valueMode = info.dividerMode === 'value';
  const parts: string[] = [];

  const balanceStr = (): string | null => {
    if (!info.balance) return null;
    const cur = info.balance.currency === 'CNY' ? '¥' : (info.balance.currency || '');
    const amt = Number(info.balance.total);
    const val = Number.isFinite(amt) ? amt.toFixed(2) : String(info.balance.total);
    // CodeBuddy 官方积分（2026-10-23）：非货币单位走后缀更顺口（5348.28 积分），别拼成 ¥ 误导成钱
    if (info.balance.currency === '积分') return `${val} 积分`;
    return `${cur}${val}`;
  };
  const usageStr = (): string | null =>
    info.usage && info.usage.length ? info.usage.map((u) => `${u.label}${u.pct}%`).join(' ') : null;
  // [票mm-1] 命中率统一出口：number→x.xx% ｜ null（引擎无缓存拆分）→N/A ｜ undefined（无源）→隐藏该段
  const rateOrNA = (v: number | null | undefined): string | null =>
    v === undefined ? null : v === null ? 'N/A' : `${v.toFixed(2)}%`;

  if (textMode) {
    // 文字版：每段带状态说明前缀
    if (show('agent') && info.agent) parts.push(`Agent: ${info.agent}`);
    if (show('model') && info.model) parts.push(`Model: ${info.model}`);
    if (show('provider') && info.provider) parts.push(`Provider: ${info.provider}`);
    if (show('session') && info.session) parts.push(`Session: ${info.session}`);
    if (show('cache')) { const s = rateOrNA(info.cacheHitRate); if (s) parts.push(`Cache: ${s}`); }
    if (show('avg')) { const s = rateOrNA(info.cacheAvgRate); if (s) parts.push(`平均: ${s}`); }
    const u = usageStr(); if (show('usage') && u) parts.push(`Usage: ${u}`);
    const b = balanceStr(); if (show('balance') && b) parts.push(`Balance: ${b}`);
    if (show('rate') && info.creditsRate) parts.push(`Rate: ${info.creditsRate}`);
  } else if (valueMode) {
    // 仅数值版：所有段的值都在（无图标无标签；dir/context 不放）
    if (show('agent') && info.agent) parts.push(info.agent);
    if (show('model') && info.model) parts.push(info.model);
    if (show('provider') && info.provider) parts.push(info.provider);
    if (show('session') && info.session) parts.push(info.session);
    if (show('cache')) { const s = rateOrNA(info.cacheHitRate); if (s) parts.push(s); }
    if (show('avg')) { const s = rateOrNA(info.cacheAvgRate); if (s) parts.push(s); }
    const u = usageStr(); if (show('usage') && u) parts.push(`⏱️ ${u}`);
    const b = balanceStr(); if (show('balance') && b) parts.push(b);
    if (show('rate') && info.creditsRate) parts.push(info.creditsRate);
  } else {
    // 图标版（默认/full，含旧 icon 值）：图标+数值
    const push = (f: string, icon: string, txt: string | null | undefined): void => {
      if (!show(f)) return;
      parts.push(txt ? `${icon} ${txt}` : icon);
    };
    push('agent', DIV_IC.agent, info.agent);
    push('model', DIV_IC.model, info.model);
    push('provider', DIV_IC.provider, info.provider);
    push('dir', DIV_IC.dir, info.dir);
    push('session', DIV_IC.session, info.session);
    // [票mm-1] null=无缓存拆分→"N/A"；undefined=无源→只剩图标（旧行为）
    push('cache', DIV_IC.cache, rateOrNA(info.cacheHitRate));
    push('avg', DIV_IC.avg, rateOrNA(info.cacheAvgRate));
    if (show('context') && info.contextPercent != null) {
      const used = info.contextUsed ?? 0;
      const limit = info.contextLimit ?? 0;
      push('context', DIV_IC.context, `${info.contextPercent.toFixed(0)}%(${(used / 1000).toFixed(0)}K/${(limit / 1000).toFixed(0)}K)`);
    }
    push('usage', DIV_IC.usage, usageStr());
    push('balance', DIV_IC.balance, balanceStr());
    push('rate', DIV_IC.rate, info.creditsRate);
  }
  const text = parts.join(textMode || valueMode ? ' | ' : '｜');
  if (text.length === 0) return 'Agent: N/A';
  // 状态行整体用小字（飞书卡片 markdown 支持 <font size>），视觉更轻
  return `<font size="s">${text}</font>`;
}

/** 正文 + 可选底部分割线状态条（PATCH 更新用） */
export function buildSimpleCard(text: string, dividerInfo?: DividerInfo): unknown {
  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: text }];
  if (dividerInfo) {
    elements.push({ tag: 'markdown', content: dividerMarkdown(dividerInfo, '') });
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    body: { elements },
  };
}

/**
 * 插队卡骨架（CardKit 实体版）：带 element_id 的 markdown 元素 + 按钮。
 * 发送后用 cardElement.content 更新文字实现状态变化（CardKit element 更新无 PATCH 次数限制，
 * 普通 interactive 整卡 PATCH 会被飞书限流/报编辑次数超限——老项目 230072 报错即此）。
 */
export function buildInterruptSkeleton(opts: {
  chatId: string;
  messageId: string;
  botName: string;
}): unknown {
  const { chatId, messageId, botName } = opts;
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      // 插队卡是交互按钮卡（非流式正文卡）：必须关 streaming_mode，整卡 body 替换（updateCardBody）
      // 才生效，否则按钮点完无法整卡移除。
      streaming_mode: false,
      summary: { content: '⚡ 是否插队？' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: STREAM_ELEMENT_ID,
          content: `${botName} 正在处理上一条消息，你的新消息已排在队列最前：\n\n• ⚡ **插队**：中断当前任务（10 秒未操作将自动选择）\n• 🗑 **取消**：撤回这条消息\n• ⏳ **排队**：等当前任务完成后再处理`,
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          horizontal_align: 'center',
          columns: [
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '⚡ 插队' }, type: 'primary', value: { callback: `interrupt:yes:${chatId}:${messageId}` } }] },
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '🗑 取消' }, type: 'danger', value: { callback: `interrupt:cancel:${chatId}:${messageId}` } }] },
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '⏳ 排队' }, type: 'default', value: { callback: `interrupt:no:${chatId}:${messageId}` } }] },
          ],
        },
      ],
    },
  };
}

/** 插队卡状态文字（更新 stream_content 元素用；按钮保留，状态文字表达当前状态） */
export function buildInterruptStatusText(opts: {
  botName: string;
  status: 'pending' | 'auto' | 'yes' | 'no' | 'cancel';
}): string {
  const { botName, status } = opts;
  const m: Record<string, string> = {
    pending: `${botName} 正在处理上一条消息，你的新消息已排在队列最前：\n\n• ⚡ **插队**：中断当前任务（10 秒未操作将自动选择）\n• 🗑 **取消**：撤回这条消息\n• ⏳ **排队**：等当前任务完成后再处理`,
    auto: `${botName} 正在处理上一条消息\n⏱️ **已自动插队**：当前任务已中断，你的新消息优先处理中…`,
    yes: `${botName} 正在处理上一条消息\n⚡ **已立即插队**：当前任务已中断，你的新消息优先处理中…`,
    no: `${botName} 正在处理上一条消息\n⏳ **已排队**：你的新消息将在当前任务完成后自动处理。`,
    cancel: `${botName} 正在处理上一条消息\n🗑 **已取消这条消息**：当前任务继续处理，该消息不会再执行。`,
  };
  return m[status] || m.pending;
}

/** 插队卡终态（无按钮，整卡更新用）：状态文字 + summary 更新 */
export function buildInterruptFinalCard(opts: {
  botName: string;
  status: 'auto' | 'yes' | 'no' | 'cancel';
}): unknown {
  const { status } = opts;
  const text = buildInterruptStatusText({ botName: opts.botName, status });
  const summaryMap: Record<string, string> = {
    auto: '⏱️ 已自动插队',
    yes: '⚡ 已立即插队',
    no: '⏳ 已排队',
    cancel: '🗑 已取消',
  };
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: false,
      summary: { content: summaryMap[opts.status] },
    },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  };
}

// ── 单卡分层拼装（移植 bridge-manager buildCombined / replace_preview）──

export interface TurnLayers {
  /** 思考全文（渲染时按窗口截尾） */
  thinking: string;
  /** 工具历史（每条一行；✅/❌ 前缀 = 已结束） */
  toolLines: string[];
  text: string;
  /** 错误信息（不覆盖已有内容，追加到卡片末尾） */
  error?: string;
}

const singleLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 工具起始行："tool — 输入预览"（≤120 字符，对齐旧实现 1874 行） */
export function toolStartLine(tool: string, input?: string): string {
  // 🔴 老大准 09-19（mimo乱码卡案）：反引号全消毒——命令生肉含 ``` 会提前打穿工具块围栏，思考/正文漏进代码块成乱码
  const preview = input ? singleLine(input).replace(/\x60+/g, '´').slice(0, 120) : '';
  return preview ? `${tool} — ${preview}` : tool;
}

/** 🔴 老大准 09-19：同名工具 >5 次折叠计数（mimo 审计任务 415 行糊卡案）——保留首条+末2条+计数行 */
function foldToolLines(lines: string[]): string[] {
  if (lines.length <= 12) return lines;
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const l of lines) {
    const name = l.replace(/^(?:[✅❌⏳]s*)*/, '').split(' — ')[0].trim().slice(0, 40) || l.slice(0, 24);
    if (!groups.has(name)) { groups.set(name, []); order.push(name); }
    groups.get(name)!.push(l);
  }
  const out: string[] = [];
  for (const name of order) {
    const g = groups.get(name)!;
    if (g.length <= 5) { out.push(...g); continue; }
    out.push(g[0], `↳ ${name} ×${g.length}（折叠，含末2条）`, ...g.slice(-2));
  }
  return out;
}

/** 工具代码块：流式期标题带执行状态，最终态固定"🔧 工具执行" */
function toolsBlock(toolLines: string[], streaming: boolean): string {
  const folded = foldToolLines(toolLines);
  if (streaming) {
    const hasRunning = toolLines.some((l) => !l.startsWith('✅') && !l.startsWith('❌'));
    const title = hasRunning ? '🔧 执行中' : '🔧 已完成';
    return '```\n' + title + '\n' + folded.join('\n') + '\n```';
  }
  return '```\n🔧 工具执行\n' + folded.join('\n') + '\n```';
}

/** 思考 blockquote：💭 标题 + 每行 ">" 前缀（左侧竖线、自动换行），按窗口截尾。
 * 流式/终态都截尾（tail）：闪烁由 provider 侧"转发前 N 字后冻结"根治（见 zcode.ts），
 * 引擎只负责把累积的思考尾部窗口渲染出来即可，无需在此额外处理。 */
function thinkingBlock(thinking: string, maxChars: number): string {
  const windowed = thinking.length > maxChars ? thinking.slice(-maxChars) : thinking;
  return '> 💭 **思考中…**\n' + windowed.split('\n').map((l) => '> ' + l).join('\n');
}

/**
 * 流式中：工具块 + （--- 分隔的 思考/正文），全空 → 占位。
 * 对齐旧 buildCombined：分隔线只加在最后一个块前面。
 */
export function buildStreamMarkdown(layers: TurnLayers): string {
  const parts: string[] = [];
  if (layers.toolLines.length > 0) parts.push(toolsBlock(layers.toolLines, true));
  const bodyParts: string[] = [];
  if (layers.thinking.trim()) {
    // P2-4 修复：字数统计每帧都变（且 20000 截断后失真）、与 thinkingBlock 内部标题重复两行 💭——全删。
    // 流式只显示尾部 400 字窗口（闪烁由 provider 侧冻结根治，这里仅渲染窗口）。
    bodyParts.push(thinkingBlock(layers.thinking, 400));
  }
  if (layers.text.trim()) bodyParts.push(layers.text);
  if (bodyParts.length > 0) parts.push(bodyParts.join('\n\n'));
  if (layers.error) parts.push(errorBlock(layers.error));
  if (parts.length === 0) return '⏳ 正在处理…';
  if (parts.length > 1) {
    const lastIdx = parts.length - 1;
    parts[lastIdx] = '\n---\n\n' + parts[lastIdx];
  }
  return parts.join('\n\n');
}

/** 卡片正文字符硬顶（飞书侧限制留足余量）；超过即有损截尾，长答案须另发完整文件。 */
export const FINAL_CARD_CHAR_CAP = 28000;

/**
 * 最终态：工具块("🔧 工具执行") --- 思考(1500 截尾) --- 正文，段间全部 --- 分隔。
 * 对齐旧 replace_preview（2297-2318 行）。
 */
export function buildFinalMarkdown(layers: TurnLayers): string {
  const parts: string[] = [];
  if (layers.toolLines.length > 0) parts.push(toolsBlock(layers.toolLines, false));
  if (layers.thinking.trim()) parts.push(thinkingBlock(layers.thinking, 1500));
  parts.push(layers.text.trim() || (layers.toolLines.length > 0
    ? `（模型执行了 ${layers.toolLines.length} 次工具调用但未写出正文总结 —— 可回一句「总结一下」或「继续」催收）`
    : '（空回复）'));
  if (layers.error) {
    // [2026-10-17 降噪] codex CLI 在流式内容已完整收到、仅收尾信号（response.completed）丢失时
    // 也会报 "stream disconnected before completion..."（MidStream 物理断连，litellm 无法兜底）。
    // 此时正文完整、引擎没卡死，报错纯属噪声 → 有正文/工具产出就吞掉不上卡片；
    // 无正文（真断流/卡死）仍照常显示 —— 卡死排障线索不丢（老大 2026-10-17 拍板口径）。
    const isMidStreamNoise = /stream disconnected before completion|stream closed before response\.completed/.test(layers.error);
    const hasBody = Boolean(layers.text.trim()) || layers.toolLines.length > 0;
    if (!(isMidStreamNoise && hasBody)) parts.push(errorBlock(layers.error));
  }
  let combined = parts[0];
  for (let i = 1; i < parts.length; i++) {
    combined += '\n\n---\n\n' + parts[i];
  }
  // 飞书卡片长度兜底：超长保留末尾（正文在最后）。
  // 🔴 这是「只留尾部」的有损截断：长任务的结论常在前半段，所以 engine 侧对超过本上限的
  //    最终答案会另发一份完整文件（见 deliverFullAnswerAsFile），卡片只当可读预览。
  if (combined.length > FINAL_CARD_CHAR_CAP) combined = combined.slice(combined.length - FINAL_CARD_CHAR_CAP);
  return combined;
}

/** 错误块：❌ 标题 + 代码块错误信息（追加到已有内容末尾，不覆盖） */
export function errorBlock(message: string): string {
  return `❌ **API 报错**\n\n\`\`\`\n${message.slice(0, 2000)}\n\`\`\``;
}

/** 错误态独立卡（兼容旧调用，整卡=纯错误） */
export function buildErrorMarkdown(message: string): string {
  return errorBlock(message);
}
