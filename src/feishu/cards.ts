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
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: '⏳ 正在处理…', element_id: STREAM_ELEMENT_ID },
  ];
  if (dividerInfo) {
    elements.push({ tag: 'markdown', content: `---\n${buildDividerText(dividerInfo)}` });
  }
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: true,
    },
    body: { elements },
  };
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
  /** Ark 套餐配额（volc-ark） */
  usage?: Array<{ label: string; pct: number }> | null;
  /** 显示项开关（缺省=全部）：agent/model/provider/dir/session/cache/avg/context/balance/usage */
  fields?: string[];
}

// 状态行图标（reasonix 风格，与 13600 概览页一致）
const DIV_IC: Record<string, string> = {
  agent: '🤖', model: '⚙️', provider: '☁️', dir: '📁', session: '💬',
  cache: '🎯', avg: '🟰', context: '📚', balance: '💰', usage: '⏱️',
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
    elements.push({ tag: 'markdown', content: `---\n${buildDividerText(dividerInfo)}` });
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

/**
 * 最终态：工具块("🔧 工具执行") --- 思考(1500 截尾) --- 正文，段间全部 --- 分隔。
 * 对齐旧 replace_preview（2297-2318 行）。
 */
export function buildFinalMarkdown(layers: TurnLayers): string {
  const parts: string[] = [];
  if (layers.toolLines.length > 0) parts.push(toolsBlock(layers.toolLines, false));
  if (layers.thinking.trim()) parts.push(thinkingBlock(layers.thinking, 1500));
  parts.push(layers.text.trim() || '（空回复）');
  if (layers.error) parts.push(errorBlock(layers.error));
  let combined = parts[0];
  for (let i = 1; i < parts.length; i++) {
    combined += '\n\n---\n\n' + parts[i];
  }
  // 飞书卡片长度兜底：超长保留末尾（正文在最后）
  const MAX_CARD_CHARS = 28000;
  if (combined.length > MAX_CARD_CHARS) combined = combined.slice(combined.length - MAX_CARD_CHARS);
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
