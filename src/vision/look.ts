/**
 * agents-to-feishu 内建看图能力（look_image 三工具：describe / reverse / text）。
 *
 * 【可分发原则（用户 2026-08-25）】
 *  - 看图是项目自带能力，不依赖任何外部常驻服务（不依赖 vision-qa/8092、zai-vision、
 *    本机 ollama），也不需要 cordis.yml 配 MCP。
 *  - 只用在 config-store.json 的 vision 段配一个视觉模型（默认免费 agnes-ai）即可用。
 *  - 视觉后端用 OpenAI 兼容 /chat/completions 接口（image_url + text 多模态）。
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
  durationMs?: number;
  error?: string;
}

const LOOK_TASK_PROMPTS: Record<string, string> = {
  describe: '请用中文简要描述这张图片的内容（一到两句话，简洁明了），如有人物说明主要形象与姿态。',
  text: '请逐字提取这张图片中的所有文字，按在画面中的位置分行输出，每行前缀标出行位置（如「顶部」「中部」「底部」）。仅输出提取到的文字内容，不要解释、不要翻译。',
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
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetch((baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
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
      return { ok: false, error: aborted ? `视觉后端超时（${Math.round(timeoutMs / 1000)}s）：${baseUrl}` : `无法连接视觉后端（${baseUrl}）：${((error as Error)?.message) ?? String(error)}` };
    }
    clearTimeout(timer);
    if (!resp.ok) {
      let body = ''; try { body = (await resp.text()).slice(0, 300); } catch { /* 忽略 */ }
      return { ok: false, error: `视觉后端返回 ${resp.status}：${body}` };
    }
    const data = await resp.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const rawContent = data?.choices?.[0]?.message?.content;
    const text = (typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.map((c) => typeof c === 'object' && c && 'text' in c ? (c as { text: string }).text : '').join('') : '').trim();
    if (!text) return { ok: false, error: '视觉后端未返回内容' };
    return { ok: true, text, task, model, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
