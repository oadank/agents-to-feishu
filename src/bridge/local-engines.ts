/**
 * [2026-09-25 老大定调] 飞书侧**自带**的 /p 与 /de 引擎。
 *
 * 独立性是硬要求：不 import dsh、不 request dsh-web(3080)、不依赖 dsh-input-tools 插件。
 * 别人把 agents-to-feishu 单独部署，只要在自己机器的设置页填 base/key/model，两个命令就能用。
 * 唯一的可选外部依赖是 openmem（:3466，独立服务，非 dsh）——拿不到就降级，绝不拦主干。
 */
import type { DeConfig, LlmConfig, PromptOptimizeConfig } from '../config-center/store.js';

// ───────────────────────── OpenAI 兼容底座 ─────────────────────────

/** 补 /v1（各家 OpenAI 兼容口都要版本段；已带就不重复加） */
export function normBase(u: string): string {
  const b = (u || '').trim().replace(/\/+$/, '');
  if (b === '') return '';
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

/** 凭证校验：缺 base / key / model 直接报错给设置页看，不静默兜底成 dsh */
export function needLlm(llm: LlmConfig | undefined, who: string): LlmConfig {
  if (!llm || !llm.baseUrl.trim() || !llm.apiKey.trim() || !llm.model.trim()) {
    throw new Error(`${who} 的模型没配全（baseUrl / apiKey / model 三项必填）——本引擎不借用 dsh 的配置，请在设置页填写`);
  }
  return llm;
}

export interface ChatOpts {
  system: string;
  user: string;
  llm: LlmConfig;
  /** 要求模型只回 JSON 时传 true：DeepSeek 官方支持 response_format，别的后端忽略即可 */
  json?: boolean;
}

/**
 * 一次对话补全。返回正文字符串（可能为空串——调用方自己判）。
 * thinking=disabled 实测把起草从 3.0s 压到 0.8s；非 deepseek 后端不认这参数会 400，
 * 所以只在域名像 deepseek 时才带，避免把别人的网关打挂。
 */
export async function chatOnce(o: ChatOpts): Promise<string> {
  const llm = o.llm;
  const url = `${normBase(llm.baseUrl)}/chat/completions`;
  const payload: Record<string, unknown> = {
    model: llm.model,
    temperature: llm.temperature ?? 0.7,
    max_tokens: llm.maxTokens ?? 900,
    messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
  };
  if (/deepseek/i.test(llm.baseUrl) || /deepseek/i.test(llm.model)) {
    if (llm.thinking === 'disabled') payload.thinking = { type: 'disabled' };
  }
  if (o.json) payload.response_format = { type: 'json_object' };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(llm.timeoutMs ?? 45_000),
  });
  if (!r.ok) throw new Error(`${llm.model} HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
  const c = j?.choices?.[0]?.message?.content ?? '';
  // 有些推理模型把正文塞 reasoning_content（额度被思考吃光时 content 为空）——兜一手，别白等
  return typeof c === 'string' && c.trim() !== '' ? c : (j?.choices?.[0]?.message?.reasoning_content ?? '');
}

/** 稳健 JSON 抽取：容忍 ```json 围栏、前后废话、对象包数组 */
export function pickJson(raw: string): unknown {
  const t = String(raw ?? '').replace(/```(json)?/gi, ' ').trim();
  const starts = [t.indexOf('['), t.indexOf('{')].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const s = Math.min(...starts);
  const open = t[s];
  const close = open === '[' ? ']' : '}';
  const e = t.lastIndexOf(close);
  if (e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

// ───────────────────────── /p 本地精炼 ─────────────────────────

const P_SYSTEM = [
  '你是输入框旁的「⚡ 提示词精炼」引擎。用户这句是要发给一个 AI 编程助手执行的，不是给人看的聊天。',
  '任务：把这句话改写清楚——补足缺失的对象、路径、参数、验收方式；删掉情绪词与冗余礼貌语。',
  '铁律：①绝不新增用户没提到的事实、文件名、数字（宁可留空让助手自己查）；②保持中文与原意；',
  '③不解释、不前言后语，只输出改写后的那一段文本；④若原文已经清楚，就几乎照抄，别为了改而改。',
].join('\n');

/** /p 主入口：返回精炼稿；配置不全时抛错（调用方决定回原文还是报错给用户） */
export async function localOptimize(text: string, cfg: PromptOptimizeConfig): Promise<string> {
  const llm = needLlm(cfg.llm, '/p');
  const tierNote = cfg.tierA === false ? '\n本次只做最小纠错与补全，不重排结构。' : '';
  const out = await chatOnce({ llm, system: P_SYSTEM + tierNote, user: text });
  const cleaned = String(out ?? '').trim();
  if (cleaned === '') throw new Error('/p 本地引擎返回空正文');
  return cleaned;
}

// ───────────────────────── /de 副驾 ─────────────────────────

/** 判断维度（AI 向：对面是编程助手，不是微信好友） */
const DE_JUDGE_SYSTEM = [
  '你是"回复预选"的判断器。用户（甲方）与一个 AI 编程助手正在对话，接下来用户要回一句给助手。',
  '只输出 JSON：{"intent":"assign|verify|decide|narrow|stop|question|accept|other",',
  '"mood":"ok|impatient|doubtful|annoyed|exploring","urgency":"now|today|soon|never",',
  '"risk":"none|low|mid|high"(high=不可逆，如涉及删除/重启在线服务/花钱/对外发送),',
  '"scope":"light|medium|large"(large=多文件或需重启或难回滚),"needsFact":0~1,"replyNow":0~1}',
  '判不准就往安全侧判：不可逆一律 high，改动面拿不准一律 large。',
].join('\n');

const DE_DRAFT_SYSTEM_HUMAN = '用户在跟另一个 AI 助手对话，替他写 3 条可直接发出的回复。';
const DE_DRAFT_BASE = [
  '规则：',
  '- 每条必须是用户现在就能按回车发给助手的**原话**：主语是"你"（指助手）；',
  '- 禁评估腔（建议/可以考虑/是否/要不要），禁"让我/我这边"的助手口吻，禁角色前缀，禁解释为什么这么定；',
  '- 大白话短句，命令式，允许只有几个字；不要客气话；',
  '- 高风险动作必须在句子里写明"先备份/先确认再动"；',
  '- 严禁替助手回答问题或代它写代码；严禁承诺花钱、签约、对外发东西；',
  '- 只输出 JSON 字符串数组，恰好 3 条，不要代码围栏，不要别的字。',
].join('\n');

const DE_RANK_SYSTEM = '给定会话与 3 条候选，判断用户最该发哪一条。只输出 JSON：{"probabilities":{"c1":0.x,"c2":0.x,"c3":0.x}}，和为 1。';

export interface DeHistoryTurn { role: 'user' | 'assistant'; text: string }
export interface DeResult {
  judge: Record<string, unknown>;
  candidates: Array<{ text: string; p: number; role: string }>;
  context: { rows: number; chars: number; openmem: boolean; note: string };
  degraded: { judge: boolean; draft: boolean; rank: boolean };
}

const AI_ROLES = ['推进', '收窄', '叫停'];
const AI_ROLES_LARGE = ['方案A', '方案B', '叫停'];

/** 会话拼文本（最近的必须在最后：模型对尾部最敏感，历史上保头砍尾出过大事故） */
export function foldHistory(turns: DeHistoryTurn[], cap = 6000): string {
  const rows = turns.filter((t) => t.text.trim() !== '')
    .map((t) => `${t.role === 'user' ? '我' : '助手'}: ${t.text.replace(/\s+/g, ' ').trim()}`);
  const joined = rows.join('\n');
  return joined.length > cap ? joined.slice(-cap) : joined;
}

export function judgeToText(j: Record<string, unknown>): string {
  const zh = (v: unknown, map: Record<string, string>) => map[String(v)] ?? String(v ?? '');
  const L: string[] = [];
  L.push('他此刻在' + zh(j.intent, { assign: '派活', verify: '要证据', decide: '要拍板', narrow: '收窄范围', stop: '叫停', question: '问情况', accept: '收尾认可', other: '闲聊' }));
  L.push('情绪' + zh(j.mood, { ok: '正常', impatient: '不耐烦', doubtful: '存疑', annoyed: '恼火', exploring: '在摸索' }));
  L.push('风险' + zh(j.risk, { none: '无', low: '低', mid: '中', high: '高（不可逆，必须写明先确认/备份）' }));
  L.push('改动量级' + zh(j.scope, { light: '轻', medium: '中', large: '大——第1、2条必须是两个不同方案，各自点明动什么/风险/怎么回滚' }));
  return L.join('；');
}

/**
 * /de 主入口。judge 与 draft 用各自模型（judge 没配就复用 draft）。
 * 任何一环失败都降级继续，绝不把用户卡住。
 */
export async function localDe(turns: DeHistoryTurn[], cfg: DeConfig, extra?: string): Promise<DeResult> {
  const draftLlm = needLlm(cfg.draft, '/de 起草');
  const judgeLlm = cfg.judge && cfg.judge.baseUrl.trim() && cfg.judge.model.trim() && cfg.judge.apiKey.trim() ? cfg.judge : draftLlm;
  const convo = foldHistory(turns);
  const ctxChars = convo.length;
  const note: string[] = [];

  let judge: Record<string, unknown> = {};
  let judgeDegraded = true;
  try {
    const ans = pickJson(await chatOnce({ llm: judgeLlm, json: true, system: DE_JUDGE_SYSTEM, user: convo + (extra ? `\n\n【补充背景】${extra}` : '') }));
    if (ans && typeof ans === 'object') { judge = ans as Record<string, unknown>; judgeDegraded = false; }
  } catch (e) { note.push(`判断失败:${(e as Error).message.slice(0, 60)}`); }

  const large = judge.scope === 'large';
  const riskHigh = judge.risk === 'high';
  const roles = large ? AI_ROLES_LARGE : AI_ROLES;
  const sys = `${DE_DRAFT_BASE}\n${DE_DRAFT_SYSTEM_HUMAN}\n${judgeToText(judge)}\n三条角色依次是：${roles.join(' / ')}。${riskHigh ? '其中必须有一条明确劝停或要求先备份确认。' : ''}`;

  let candidates: string[] = [];
  let draftErr = '';
  for (let att = 0; att < 3 && candidates.length < 3; att++) {
    try {
      const raw = await chatOnce({
        llm: draftLlm, system: sys,
        user: att === 0 ? convo : `${convo}\n\n（上一次没给出可用候选。${att >= 2 ? '不要 JSON、不要围栏，直接输出 3 行，每行一条。' : '只输出 JSON 字符串数组，恰好 3 条。'}）`,
      });
      let arr = pickJson(raw);
      if (!Array.isArray(arr)) arr = String(raw).split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 1);
      for (const x of (arr as unknown[])) {
        const s = typeof x === 'string' ? x : String((x as Record<string, unknown>)?.text ?? '');
        const t = s.replace(/^["'「『\s]+|["'」』\s]+$/g, '').replace(/^[-*·]\s*/, '').replace(/^\d+\s*[.、)）:：]\s*/, '').trim();
        if (t.length >= 1 && !candidates.includes(t)) candidates.push(t);
      }
    } catch (e) { draftErr = (e as Error).message.slice(0, 160); break; }
  }
  candidates = candidates.slice(0, 3);

  const out: DeResult['candidates'] = candidates.map((text, i) => ({ text, p: 0, role: roles[i] ?? '' }));
  let rankDegraded = true;
  if (candidates.length >= 2) {
    try {
      const j = pickJson(await chatOnce({
        llm: judgeLlm, json: true, system: DE_RANK_SYSTEM,
        user: `${convo}\n\n候选：\n${candidates.map((t, i) => `c${i + 1}. ${t}`).join('\n')}`,
      })) as { probabilities?: Record<string, number> } | null;
      const probs = j?.probabilities;
      if (probs && typeof probs === 'object') {
        out.forEach((c, i) => { c.p = Number(probs[`c${i + 1}`]) || 0; });
        out.sort((a, b) => b.p - a.p);
        rankDegraded = false;
      }
    } catch (e) { note.push(`排序失败:${(e as Error).message.slice(0, 60)}`); }
  }
  note.push(`历史${turns.length}条/${ctxChars}字`);
  return {
    judge, candidates: out,
    context: { rows: turns.length, chars: ctxChars, openmem: !!extra, note: note.join(' ｜ ') },
    degraded: { judge: judgeDegraded, draft: candidates.length === 0, rank: rankDegraded },
  };
}
