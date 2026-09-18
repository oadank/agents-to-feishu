/**
 * agents-to-feishu 内建看图能力（look_image 三工具：describe / reverse / text）。
 *
 * 【可分发原则（用户 2026-08-25；2026-09-19 后端链升级）】
 *  - 看图是项目自带能力，不需要 cordis.yml 配 MCP。
 *  - 后端链（2026-09-19 老大拍板：默认远程、本地只兜底）：
 *      1. 主站：config-store.json vision.baseUrl（.cn 国内站 + VISION_API_KEY）
 *      2. 回退：.com 国际站 apihub.agnes-ai.com + 备用 key（VISION_API_KEY_COM_2/COM_1）
 *      3. 兜底：本地 vision-qa :8091（POST /analyze，服务本体零改动）
 *  - 远程站走 OpenAI 兼容 /chat/completions 接口（image_url + text 多模态）。
 *
 * 三工具（对齐 dsh web 端 look_image 语义）：
 *  - describe : 简述图片内容（普通看图）
 *  - reverse  : 像素级反推 → 可用作生图提示词（画面风格/主体/细节/光线/技术修饰）
 *  - text     : 逐字提取图中文字
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VisionConfig } from '../config-center/store.js';
import { readStore, DEFAULT_VISION } from '../config-center/store.js';

export interface LookOptions {
  /** 视觉配置；缺省从 config-store.json 读 */
  vision?: VisionConfig;
  /** 视觉 key 显式覆盖（优先）；否则用 vision.apiKey 或凭证文件 */
  apiKeyOverride?: string;
}

export interface LookResult {
  ok: boolean;
  text?: string;
  task?: string;
  model?: string;
  /** 命中的后端：main（主站）/ com（.com 国际站）/ local:8091（vision-qa 兜底） */
  backend?: string;
  durationMs?: number;
  error?: string;
}

const LOOK_TASK_PROMPTS: Record<string, string> = {
  describe: '请用中文简要描述这张图片的内容（一到两句话，简洁明了），如有人物说明主要形象与姿态。',
  // 2026-09-19 调优：agnes-3.0-flash 对结尾年份数字摇摆（2025/2026），尾数强调句实测 8/8 完整
  text: 'Transcribe the text in the image exactly, character by character. Pay special attention to trailing digits: transcribe EVERY digit of the year, it is 4 digits long. Output only the transcription.',
};

/** 读取视觉配置：显式传入 > config-store.json 的 vision 段 > 默认 */
export function loadVisionConfig(opts?: LookOptions): VisionConfig {
  if (opts?.vision) return opts.vision;
  try {
    const store = readStore();
    return store.vision ?? DEFAULT_VISION;
  } catch {
    return DEFAULT_VISION;
  }
}

/** 从凭证文件（.agents-to-feishu/.credentials 或 env）读视觉 key */
export function resolveVisionApiKey(vision: VisionConfig, opts?: LookOptions): string {
  if (opts?.apiKeyOverride) return opts.apiKeyOverride;
  if (vision.apiKey) return vision.apiKey;
  // 环境变量兜底
  const envKey = process.env.VISION_API_KEY || process.env.AGNES_API_KEY;
  if (envKey) return envKey;
  // 凭证文件兜底（可分发：用户可在自己目录配 .credentials.yaml/.env，或直接填 apiKey）
  try {
    const home = process.env.CTI_USER_HOME || os.homedir();
    for (const fname of ['.credentials.yaml', '.env']) {
      const p = path.join(home, '.agents-to-feishu', fname);
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, 'utf-8');
      // 兼容 KEY=value（.env）与 KEY: value（yaml）
      const m =
        txt.match(/^\s*(?:VISION_API_KEY|AGNES_API_KEY)\s*[:=]\s*(.+)/m);
      if (m) return m[1].trim();
    }
  } catch { /* 忽略 */ }
  return '';
}

/** 读取 .com 国际站备用 key（key2/key1）：env > 凭证文件（VISION_API_KEY_COM_2 优先于 COM_1） */
export function resolveVisionComApiKeys(): string[] {
  const seen = new Map<string, string>();
  try {
    const home = process.env.CTI_USER_HOME || os.homedir();
    for (const fname of ['.credentials.yaml', '.env']) {
      const p = path.join(home, '.agents-to-feishu', fname);
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, 'utf-8');
      for (const m of txt.matchAll(/^\s*(VISION_API_KEY_COM_2|VISION_API_KEY_COM_1|VISION_API_KEY_COM|AGNES_API_KEY_COM)\s*[:=]\s*(.+)/gm)) {
        const v = m[2].trim();
        if (v && !seen.has(m[1])) seen.set(m[1], v);
      }
      if (seen.size) break;
    }
  } catch { /* 忽略 */ }
  const ordered = [
    process.env.VISION_API_KEY_COM_2 ?? seen.get('VISION_API_KEY_COM_2'),
    process.env.VISION_API_KEY_COM_1 ?? seen.get('VISION_API_KEY_COM_1'),
    process.env.VISION_API_KEY_COM ?? seen.get('VISION_API_KEY_COM'),
    process.env.AGNES_API_KEY_COM ?? seen.get('AGNES_API_KEY_COM'),
  ];
  const keys: string[] = [];
  for (const k of ordered) {
    const t = (k || '').trim();
    if (t && !keys.includes(t)) keys.push(t);
  }
  return keys;
}

/** 通过文件头 magic bytes 判断图片真实 MIME（不依赖扩展名） */
function sniffImageMime(b: Buffer): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  return 'image/png';
}

/** 单站 OpenAI 兼容调用（/chat/completions，image_url + text 多模态） */
async function callOpenAIChat(
  backend: { label: string; baseUrl: string; apiKey: string },
  imgB64: string,
  imgMime: string,
  userContent: string,
  model: string,
  timeoutMs: number,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch((backend.baseUrl.endsWith('/') ? backend.baseUrl.slice(0, -1) : backend.baseUrl) + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(backend.apiKey ? { authorization: 'Bearer ' + backend.apiKey } : {}),
      },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [{ role: 'user', content: [
          { type: 'text', text: userContent },
          { type: 'image_url', image_url: { url: `data:${imgMime};base64,${imgB64}` } },
        ] }],
      }),
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = (error as Error)?.name === 'AbortError';
    return { ok: false, error: aborted ? `超时（${Math.round(timeoutMs / 1000)}s）` : `无法连接：${((error as Error)?.message) ?? String(error)}` };
  }
  clearTimeout(timer);
  if (!resp.ok) {
    let body = ''; try { body = (await resp.text()).slice(0, 200); } catch { /* 忽略 */ }
    return { ok: false, error: `HTTP ${resp.status}：${body}` };
  }
  try {
    const data = await resp.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const rawContent = data?.choices?.[0]?.message?.content;
    const text = (typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.map((c) => typeof c === 'object' && c && 'text' in c ? (c as { text: string }).text : '').join('') : '').trim();
    if (!text) return { ok: false, error: '后端未返回内容' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: `响应解析失败：${String((e as Error)?.message ?? e)}` };
  }
}

/** 本地兜底：vision-qa :8091（POST /analyze 私有格式；task 映射 describe/reverse→general、text→text） */
async function callLocalVisionqa(
  imgB64: string,
  task: 'describe' | 'text' | 'reverse',
  timeoutMs: number,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const vqTask = task === 'text' ? 'text' : 'general';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch('http://127.0.0.1:8091/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({ image: imgB64, task: vqTask }),
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = (error as Error)?.name === 'AbortError';
    return { ok: false, error: aborted ? `超时（${Math.round(timeoutMs / 1000)}s）` : `无法连接：${((error as Error)?.message) ?? String(error)}` };
  }
  clearTimeout(timer);
  if (!resp.ok) {
    let body = ''; try { body = (await resp.text()).slice(0, 200); } catch { /* 忽略 */ }
    return { ok: false, error: `HTTP ${resp.status}：${body}` };
  }
  try {
    const data = await resp.json() as { text?: string; error?: string };
    const text = (data.text || '').trim();
    if (!text) return { ok: false, error: data.error || 'vision-qa 未返回内容' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: `响应解析失败：${String((e as Error)?.message ?? e)}` };
  }
}

/**
 * 识图入口。task: describe | reverse | text（默认 describe）。
 * extra 为附加要求（如「重点看左下角」「主角换成女生」）。
 */
export async function lookImage(options: {
  imagePath: string;
  task?: string;
  extra?: string;
  vision?: VisionConfig;
  apiKeyOverride?: string;
}): Promise<LookResult> {
  try {
    const imagePath = (options.imagePath ?? '').trim();
    if (!imagePath) return { ok: false, error: 'image_path 不能为空' };
    const rawTask = (options.task ?? 'describe').trim() || 'describe';
    const task: 'describe' | 'text' | 'reverse' =
      rawTask === 'text' || rawTask === 'reverse' ? rawTask : 'describe';
    const vision = loadVisionConfig(options);
    if (!vision.enabled) return { ok: false, error: '图片识别未启用：config-store.json vision.enabled=false' };

    const baseUrl = (vision.baseUrl || '').trim() || 'http://127.0.0.1:11434/v1';
    const model = (vision.model || '').trim() || 'agnes-2.5-flash';
    const apiKey = resolveVisionApiKey(vision, options);
    const timeoutMs = vision.timeoutMs > 0 ? vision.timeoutMs : 240000;

    // 提示词：用户配置 > reverse 读文件 > 内置模板
    let promptText = '';
    const userPrompt = vision.prompts?.[task];
    if (typeof userPrompt === 'string' && userPrompt.trim() !== '') {
      promptText = userPrompt.trim();
    } else if (task === 'reverse') {
      try {
        const homeDir = process.env.CTI_USER_HOME || os.homedir();
        const f = path.join(homeDir, '.agents-to-feishu', 'vision-reverse-prompt.txt');
        if (fs.existsSync(f)) promptText = fs.readFileSync(f, 'utf8').trim();
      } catch { /* 忽略 */ }
      if (!promptText) {
        promptText = '请对这张图片做像素级反推，输出一份可直接用于 AI 生图（即梦/可灵/Stable Diffusion/Midjourney）的完整中文提示词，覆盖：画面风格、核心主体、背景与装饰、细节特征、美学与光线、技术修饰。';
      }
    } else {
      promptText = LOOK_TASK_PROMPTS[task] ?? LOOK_TASK_PROMPTS.describe;
    }

    const extraText = (options.extra ?? '').trim();
    const userContent = (extraText ? `${promptText}\n\n【附加要求】${extraText}` : promptText);

    const imgRaw = fs.readFileSync(imagePath);
    const imgB64 = imgRaw.toString('base64');
    const imgMime = sniffImageMime(imgRaw);

    const t0 = Date.now();

    // 后端链：主站（config-store baseUrl）→ .com 国际站（key2/key1）→ 本地 vision-qa :8091 兜底
    const isLocalBase = /127\.0\.0\.1|localhost/i.test(baseUrl);
    const backends: Array<{ label: string; baseUrl: string; apiKey: string }> = [
      { label: isLocalBase ? 'local-custom' : 'main', baseUrl, apiKey },
    ];
    if (!isLocalBase) {
      for (const k of resolveVisionComApiKeys()) {
        backends.push({ label: 'com', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: k });
      }
    }

    const errs: string[] = [];
    const remoteTimeout = Math.min(timeoutMs, 45000);
    for (const b of backends) {
      const r = await callOpenAIChat(b, imgB64, imgMime, userContent, model, remoteTimeout);
      if (r.ok && r.text) {
        return { ok: true, text: r.text, task, model, backend: b.label, durationMs: Date.now() - t0 };
      }
      errs.push(`[${b.label}] ${r.error}`);
    }

    // 本地兜底：vision-qa :8091（POST /analyze 私有格式，服务本体零改动）
    const lr = await callLocalVisionqa(imgB64, task, Math.min(timeoutMs, 120000));
    if (lr.ok && lr.text) {
      return { ok: true, text: lr.text, task, model: 'local-qwen3-vl', backend: 'local:8091', durationMs: Date.now() - t0 };
    }
    errs.push(`[local:8091] ${lr.error}`);
    return { ok: false, error: `视觉后端全链失败（${errs.length} 站）：${errs.join('；')}` };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
