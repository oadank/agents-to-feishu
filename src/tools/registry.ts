/**
 * 内置工具注册表（2026-08-29 方向定调：老大的初心）
 *
 * agents-to-feishu 自带的能力（看图/生图/反推/转写/语音回复）全部以**进程内函数**形式
 * 收进这里——无 HTTP、无端口、无 MCP、无外部依赖，agent 接入即天生可用。
 * 各 provider 按自己的协议通道把这份注册表注入给模型：
 *   - claude   → Agent SDK 进程内工具（createSdkMcpServer，内存直调）【本文件实现】
 *   - dsh 等ACP → vendor/cti-builtin-tools 第一方插件（harness 进程内直调）
 *                 【⚠ 插件 lib/index.js 里有同源 JS 实现——改这里的实现逻辑必须同步插件侧】
 *   - 其余     → 桥接 pre/post 代劳（后续 Phase）
 * MCP 端点（/mcp/vision、/mcp/comfy）保留，仅作为**对外**暴露接口给外界 agents 用。
 */

import fs from 'node:fs';
import { z } from 'zod';
import { lookImage } from '../vision/look.js';
import { transcribe } from '../voice/asr.js';
import { COMFY_BASE_URL } from '../comfy/mcp-server.js';
import { DEFAULT_SPEECH } from '../config-center/store.js';
import type { SpeechConfig } from '../config-center/store.js';

/** 桥接注入给工具的运行时上下文（由 provider 在每轮对话时提供） */
export interface BuiltinToolContext {
  /** 当前会话 chatId（= StreamChatParams.sessionKey） */
  chatId?: string | null;
  /** 桥接依赖（sendVoice / getSpeech），由 provider attach 时传入 */
  deps: BridgeToolDeps;
}

/** 由 index.ts 接线进来的桥接依赖 */
export interface BridgeToolDeps {
  /** 发送语音消息（engine.sendVoiceReply：TTS→opus→飞书语音消息） */
  sendVoice?: (chatId: string, text: string) => Promise<void>;
  /** 全局语音配置（engine.speech getter） */
  getSpeech?: () => SpeechConfig | undefined;
}

export interface BuiltinTool {
  name: string;
  description: string;
  /** zod raw shape（claude SDK tool() 直接吃这个格式） */
  schema: Record<string, z.ZodTypeAny>;
  /** 执行工具，返回给模型的纯文本结果 */
  execute(args: Record<string, unknown>, ctx: BuiltinToolContext): Promise<string>;
}

async function comfyPost(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const r = await fetch(`${COMFY_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    let err = '';
    try { err = (await r.text()).slice(0, 300); } catch { /* 忽略 */ }
    throw new Error(`ComfyUI 返回 ${r.status}${err ? `: ${err}` : ''}`);
  }
  const data: unknown = await r.json();
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

/** 读取本地图片为 base64（reverse_prompt 用），带基本校验 */
function readImageBase64(imagePath: string): string {
  const p = (imagePath ?? '').trim();
  if (!p) throw new Error('image_path 不能为空');
  const buf = fs.readFileSync(p);
  if (buf.length === 0) throw new Error(`图片为空: ${p}`);
  return buf.toString('base64');
}

export function buildBuiltinTools(deps: BridgeToolDeps): BuiltinTool[] {
  return [
    {
      name: 'look_image',
      description:
        '看一张本地图片文件。task=describe 简述内容 / text 逐字提取图中文字 / reverse 反推绘画提示词。'
        + '用户发来图片的落盘路径会出现在消息里，直接把路径传给本工具即可。',
      schema: {
        image_path: z.string().describe('图片的本地绝对路径'),
        task: z.enum(['describe', 'text', 'reverse']).optional().describe('看图模式，默认 describe'),
        extra: z.string().optional().describe('附加要求（describe/reverse 模式下的补充指令）'),
      },
      execute: async (args) => {
        const r = await lookImage({
          imagePath: String(args.image_path ?? ''),
          task: args.task as string | undefined,
          extra: args.extra as string | undefined,
        });
        return r.ok ? (r.text ?? '（看图完成，但无描述输出）') : `看图失败: ${r.error ?? '未知错误'}`;
      },
    },
    {
      name: 'generate_image',
      description:
        '文生图/图生图：把提示词交给本机 ComfyUI 生成图片，返回 JSON（含输出文件名 output_name）。'
        + '用户要画图/生图/画一张时使用。',
      schema: {
        prompt: z.string().describe('生图提示词'),
        template: z.string().optional().describe('工作流模板名（省略用默认）'),
        width: z.number().optional(),
        height: z.number().optional(),
        seed: z.number().optional(),
        steps: z.number().optional(),
        cfg: z.number().optional().describe('提示词引导强度'),
        denoise: z.number().optional().describe('重绘幅度（图生图）'),
        image: z.string().optional().describe('图生图：base64 图片数据'),
        image_name: z.string().optional().describe('图生图：历史图片名（与 image 二选一）'),
      },
      execute: async (args) => {
        const body: Record<string, unknown> = { prompt: String(args.prompt ?? '') };
        for (const k of ['template', 'width', 'height', 'seed', 'steps', 'cfg', 'denoise', 'image', 'image_name'] as const) {
          if (args[k] !== undefined && args[k] !== null) body[k] = args[k];
        }
        return comfyPost('/generate', body, 300_000);
      },
    },
    {
      name: 'reverse_prompt',
      description: '对一张图片做像素级反推，产出可用于再绘制的提示词。',
      schema: {
        image_path: z.string().optional().describe('本地图片路径（推荐，自动转 base64）'),
        image: z.string().optional().describe('base64 图片数据（与 image_path 二选一）'),
        image_name: z.string().optional().describe('历史图片名'),
      },
      execute: async (args) => {
        const body: Record<string, unknown> = {};
        if (args.image_path) body.image = readImageBase64(String(args.image_path));
        if (args.image) body.image = String(args.image);
        if (args.image_name) body.image_name = String(args.image_name);
        if (!body.image && !body.image_name) throw new Error('image_path / image / image_name 至少给一个');
        return comfyPost('/reverse_prompt', body, 180_000);
      },
    },
    {
      name: 'transcribe',
      description: '把本地音频文件转成文字（本地 ASR，支持 wav/mp3 等）。',
      schema: {
        audio_path: z.string().describe('音频文件本地绝对路径'),
      },
      execute: async (args, ctx) => {
        const p = String(args.audio_path ?? '').trim();
        if (!p) throw new Error('audio_path 不能为空');
        const bytes = await fs.promises.readFile(p);
        const r = await transcribe(bytes, ctx.deps.getSpeech?.()?.asr ?? DEFAULT_SPEECH.asr);
        return r.ok && r.text ? r.text : `转写失败: ${r.error ?? '未识别到内容'}`;
      },
    },
    {
      name: 'send_voice',
      description:
        '把一段文字转成语音消息直接发给用户（飞书语音条）。用户明确要求"语音回复/说给我听"时使用。'
        + '注意： send_voice 之后不需要再复述文本内容。',
      schema: {
        text: z.string().describe('要转成语音的正文'),
      },
      execute: async (args, ctx) => {
        const text = String(args.text ?? '').trim();
        if (!text) throw new Error('text 不能为空');
        if (!ctx.chatId) throw new Error('当前会话上下文缺失（chatId 为空），无法发送语音');
        const send = ctx.deps.sendVoice;
        if (!send) throw new Error('语音发送通道未接通（桥接未注入 sendVoice）');
        await send(ctx.chatId, text);
        return `✅ 语音消息已发送给用户（${text.length} 字）`;
      },
    },
  ];
}
