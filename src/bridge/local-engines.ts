/**
 * [2026-09-25 老大定调] 飞书侧**自带**的 /p 与 /de 引擎。
 *
 * 独立性是硬要求：不 import dsh、不 request dsh-web(3080)、不依赖 dsh-input-tools 插件。
 * 别人把 agents-to-feishu 单独部署，只要在自己机器的设置页填 base/key/model，两个命令就能用。
 * 唯一的可选外部依赖是 openmem（:3466，独立服务，非 dsh）——拿不到就降级，绝不拦主干。
 */
import { readStore, type DeConfig, type DecisionConfig, type LlmConfig, type PromptOptimizeConfig } from '../config-center/store.js';
import { readCredentialKey } from '../config-center/render.js';

// ───────────────────────── OpenAI 兼容底座 ─────────────────────────

/** 补 /v1（各家 OpenAI 兼容口都要版本段；已带就不重复加） */
export function normBase(u: string): string {
  const b = (u || '').trim().replace(/\/+$/, '');
  if (b === '') return '';
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

export interface Resolved { llm: LlmConfig; source: string }

/**
 * [2026-09-25 老大明说] 「模型是直接选的，别再让用户填写」——
 * 选了 providerId+modelId 就从**本仓模型配置**（config-store 的 providers）解析出地址，
 * 密钥走凭证层（readCredentialKey，前端从不回显明文）。手填三件套只当高级兜底。
 * 缺配置就如实抛错给设置页看，绝不静默去借 dsh 的东西。
 */
export function resolveLlm(llm: LlmConfig | undefined, who: string): Resolved {
  if (!llm) throw new Error(`${who} 还没有模型配置`);
  const pid = (llm.providerId ?? '').trim();
  const mid = (llm.modelId ?? '').trim();
  if (pid !== '' && mid !== '') {
    const store = readStore();
    const p = store.providers.find((x) => x.id === pid);
    if (!p) throw new Error(`${who} 选的服务商「${pid}」在模型配置里已不存在，去设置页重新选一个`);
    const m = p.models.find((x) => x.id === mid);
    if (!m) throw new Error(`${who} 选的模型「${mid}」不在「${p.displayName}」的清单里，去设置页重新选一个`);
    const base = (llm.baseUrl.trim() !== '' ? llm.baseUrl.trim() : (p.baseURL ?? '').trim());
    const key = (llm.apiKey.trim() !== '' ? llm.apiKey.trim() : (readCredentialKey(p.apiKeyEnv) || process.env[p.apiKeyEnv] || '').trim());
    if (base === '') throw new Error(`「${p.displayName}」没有 baseURL，给 ${who} 用不了——先在模型配置里补地址，或换一个服务商`);
    if (key === '') throw new Error(`没取到「${p.apiKeyEnv}」的密钥，${who} 需要它——在配置中心「总配置」里填一次 key 即可（这里不用填）`);
    return { llm: { ...llm, baseUrl: base, apiKey: key, model: m.id }, source: `${p.displayName} · ${m.label || m.displayName || m.id} · 密钥来自 ${p.apiKeyEnv}` };
  }
  if (!llm.baseUrl.trim() || !llm.apiKey.trim() || !llm.model.trim()) {
    throw new Error(`${who} 还没选模型（在设置页下拉里选一个就行，本引擎不借用 dsh 的配置）`);
  }
  return { llm, source: `手填：${llm.model}` };
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
  // 🔴 只在**官方域名**才带 thinking：网关（litellm 等）不认这个私有参数会直接 400，
  // 之前只按模型名判断，选了网关服务商就会把 /p 打挂。
  if (/api\.deepseek\.com/i.test(llm.baseUrl) && llm.thinking === 'disabled') payload.thinking = { type: 'disabled' };
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
  const { llm } = resolveLlm(cfg.llm, '/p');
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

// ─────────────── 决策模型（快判断：只回概率/选项，不生成文本，几十毫秒） ───────────────

/** 同族协议都是 POST {base}/systemone，所以"选模型"=选这一族里的哪家服务，用户不用填地址密钥 */
export const DECISION_PRESETS: Record<string, { label: string; url: string; model: string }> = {
  aliyun: { label: '阿里云百炼 · decision-model-preview（本机网关透传，实测几十毫秒）', url: '', model: 'decision-model-preview' },
  bocha: { label: '博查 · bocha-jev-v1（限时免费，需自备 key）', url: 'https://jev.bocha.cn/v1/systemone', model: 'bocha-jev-v1' },
  vercel: { label: 'Vercel AI Gateway · typesafe-ai/jev', url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev' },
  opencode: { label: 'OpenCode Zen · jev-1.13（付费，需 key）', url: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13' },
};

/** /de 判断局面的题面。取值一律对齐 dsh 侧 COPILOT_QUESTIONS_AI（两边判定才不会打架），
 *  🔴 形状必须是 {type:'choice', instructions, criteria:{key:说明}} —— 送 choices 数组上游直接 400 InvalidParameter。 */
const DE_QUESTIONS: Record<string, { type: 'choice' | 'noul'; instructions: string; criteria?: Record<string, string> }> = {
  intent: { type: 'choice', instructions: 'What does the user last need to do about this AI turn?', criteria: {
    assign: 'tell the AI what to do next', verify: 'demand proof, a check or a re-read',
    decide: 'pick between options the AI offered', narrow: 'cut the scope down, stop extra work',
    stop: 'halt or reject the current direction', question: 'ask for explanation or reason',
    accept: 'it is done, close the loop', other: 'none of the above' } },
  mood: { type: 'choice', instructions: 'The user attitude toward the AI work in this context', criteria: {
    ok: 'satisfied enough', impatient: 'impatient, wants it moving', doubtful: 'doubts the result or the claim',
    annoyed: 'annoyed, something was done wrong or explained away', exploring: 'curious, wants options' } },
  urgency: { type: 'choice', instructions: 'How soon does the user need to answer the AI?', criteria: {
    now: 'the AI is blocked waiting', today: 'can answer shortly', soon: 'can wait', never: 'no answer needed' } },
  risk: { type: 'choice', instructions: 'Risk of the user giving a careless instruction here (data loss, service restart, money, secrets, outward-facing sends)', criteria: {
    none: 'no consequence', low: 'small, easy to undo', mid: 'could waste time or confuse state',
    high: 'irreversible: deletion, restart of something live, money, secrets, sending outward' } },
  needsFact: { type: 'noul', instructions: 'The next instruction requires a fact, number, file or log to be verified first (not wording alone)' },
  replyNow: { type: 'noul', instructions: 'The AI is waiting on the user to proceed' },
  scope: { type: 'choice', instructions: 'How big is the change the next instruction would trigger', criteria: {
    light: 'wording, a note, a read-only check', medium: 'one file or one setting, easy to undo',
    large: 'multiple files, a service restart, a migration/merge, or anything hard to undo' } },
  bestAction: { type: 'choice', instructions: 'Best next move for the user', criteria: {
    advance: 'push forward: name the next step and how to verify it', narrow: 'cut scope: do less, prove more',
    stop: 'halt or roll back the current direction', probe: 'ask why, demand reasoning or evidence',
    accept: 'accept and close', handoff: 'hand this to another agent/session' } },
};
const DE_DECISION_INSTRUCTIONS = 'You are the read-only judgement layer of a copilot for an AI-assistant chat. ' +
  'The user is about to reply to an AI agent they supervise (not to a human). Judge only what is shown in the conversation state. ' +
  'Do not invent context. Return typed answers only.';

/** 决策模型的地址/模型名/密钥：aliyun 用 providerId 那家的 baseURL 去掉版本段再接 /systemone */
export function resolveDecision(dc?: DecisionConfig): { url: string; model: string; key: string; label: string; preset: string } {
  const want = (dc && dc.preset) || 'aliyun';
  const preset = DECISION_PRESETS[want] ? want : 'aliyun';
  const p = DECISION_PRESETS[preset];
  const store = readStore();
  const pid = (dc && dc.providerId) || 'litellm';
  const prov = store.providers.find((x) => x.id === pid);
  let url = ((dc && dc.url) || '').trim() || p.url;
  if (url === '') {
    if (!prov || !prov.baseURL) throw new Error(`决策模型 ${preset} 需要网关地址，但「${pid}」没有 baseURL`);
    url = `${prov.baseURL.replace(/\/+$/, '').replace(/\/(v1|compatible-mode\/v1)$/, '')}/systemone`;
  }
  const model = ((dc && dc.model) || '').trim() || p.model;
  const key = ((dc && dc.apiKey) || '').trim() || (prov ? (readCredentialKey(prov.apiKeyEnv) || process.env[prov.apiKeyEnv] || '').trim() : '');
  if (key === '') throw new Error(`没取到「${prov ? prov.apiKeyEnv : pid}」的密钥，决策模型用不了`);
  return { url, model, key, label: p.label, preset };
}

/** 问一轮判断题，返回原始 answers（失败就抛，由调用方降级，绝不卡住 /de） */
export async function askSystemOne(state: string, dc: DecisionConfig | undefined, timeoutMs = 6000): Promise<Record<string, { type?: string; choice?: string; noul?: number; score?: number }>> {
  const { url, model, key } = resolveDecision(dc);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, instructions: DE_DECISION_INSTRUCTIONS, state, questions: DE_QUESTIONS }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`决策模型 HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 80)}`);
  const j = (await r.json()) as { answers?: Record<string, { type?: string; choice?: string; noul?: number; score?: number }> };
  return (j && j.answers) || {};
}

/** 正常回的是 criteria 的键；万一回 'L1' 这种编号，按 criteria 键序还原（两种都兜住） */
function normChoice(qid: string, raw?: string): string {
  const keys = Object.keys((DE_QUESTIONS[qid] && DE_QUESTIONS[qid].criteria) || {});
  const v = (raw || '').trim();
  if (v === '') return '';
  const m = /^L(\d+)$/i.exec(v);
  if (m) return keys[Number(m[1]) - 1] || v;
  return keys.indexOf(v) >= 0 ? v : (keys.filter((o) => o.toLowerCase() === v.toLowerCase())[0] || v);
}

/**
 * /de 主入口。judge 与 draft 用各自模型（judge 没配就复用 draft）。
 * 任何一环失败都降级继续，绝不把用户卡住。
 */
export async function localDe(turns: DeHistoryTurn[], cfg: DeConfig, extra?: string): Promise<DeResult> {
  // 🔴 note 必须在最前面声明：上一版我把模型解析写在它之前，note.push 直接踩 TDZ（ReferenceError）
  const note: string[] = [];
  const { llm: draftLlm, source: draftSrc } = resolveLlm(cfg.draft, '/de 起草');
  // 判断/排序那套没配或配错就复用起草模型：它只是辅助环节，绝不能把整个 /de 挂掉
  let judgeLlm = draftLlm;
  let judgeSrc = draftSrc;
  const j = cfg.judge;
  if (j && (((j.providerId ?? '').trim() !== '' && (j.modelId ?? '').trim() !== '') || (j.baseUrl.trim() !== '' && j.apiKey.trim() !== '' && j.model.trim() !== ''))) {
    try { const r = resolveLlm(j, '/de 判断'); judgeLlm = r.llm; judgeSrc = r.source; } catch (e) { note.push(`判断模型没用好(${(e as Error).message.slice(0, 50)})，已复用起草模型`); }
  } else {
    judgeSrc = `${draftSrc}（复用）`;
  }
  note.push(`起草=${draftSrc}`, `判断=${judgeSrc}`);
  const convo = foldHistory(turns);
  const ctxChars = convo.length;

  let judge: Record<string, unknown> = {};
  let judgeDegraded = true;
  // [2026-09-25 老大：13600 缺 /de 的决策模型] 判断局面优先走决策模型（只回概率/选项，几十毫秒）；
  // 不通就退回聊天模型判断 —— 这一环永远不许把 /de 卡死。
  if ((cfg.judgeEngine || 'decision') === 'decision') {
    const t0 = Date.now();
    try {
      const ans = await askSystemOne(convo + (extra ? `\n补充背景：${extra}` : ''), cfg.decision);
      const j: Record<string, unknown> = {};
      for (const qid of Object.keys(DE_QUESTIONS)) {
        const a = ans[qid];
        if (!a) continue;
        if (a.choice !== undefined) j[qid] = normChoice(qid, a.choice);
        else if (typeof a.noul === 'number') j[qid] = a.noul;
        else if (typeof a.score === 'number') j[qid] = a.score;
      }
      if (Object.keys(j).length >= 4) {
        judge = j; judgeDegraded = false;
        note.push(`判断=决策模型 ${resolveDecision(cfg.decision).label} · ${Date.now() - t0}ms`);
      } else {
        note.push(`决策模型答案不全(${JSON.stringify(ans).slice(0, 70)})，退回聊天模型判断`);
      }
    } catch (e) { note.push(`决策模型没通(${(e as Error).message.slice(0, 70)})，退回聊天模型判断`); }
  }
  if (judgeDegraded) try {
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
