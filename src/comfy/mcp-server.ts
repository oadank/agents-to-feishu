/**
 * ComfyUI 生图 MCP 服务 —— 把本机 ComfyUI 生图能力暴露成标准 MCP（Streamable HTTP）。
 *
 * 为什么做成 MCP 而不是直接用内建 API：
 *  - 配置中心的 dsh-mcp-client（DSH 侧）只会连接「标准 MCP 服务」（Streamable HTTP 或 stdio），
 *    因此要把 ComfyUI 暴露给飞书 agent 调用，必须有一个符合 MCP 协议的服务端。
 *  - 这里复用官方 @modelcontextprotocol/sdk，保证与 dsh-mcp-client 的 StreamableHTTPClientTransport 完全兼容。
 *
 * 部署形态：
 *  - 不单独开端口，而是挂在配置中心（13600）同一个 http server 的 `/mcp/comfy` 路径，
 *    这样 Tailscale 访问 http://<本机IP>:13600/mcp/comfy 即可，无需额外进程/端口。
 *  - 工具调用内部转发到 8090（COMFY_BASE_URL 可配），与 server.ts 的内建 /api/comfy/* 逻辑一致。
 *
 * 会话策略：
 *  - 采用 MCP「无状态」模式（sessionIdGenerator = undefined）：每次请求新建一个独立 transport，
 *    处理完即 close。因为本服务只做「请求-响应」式的生图调用，没有服务端推送通知，无状态足够，
 *    且避免了跨会话串话与 session 生命周期管理。dsh-mcp-client 完全兼容无状态模式。
 *
 * 暴露工具：
 *  - list_templates：列出生图/生视频模板
 *  - generate_image：生图/生视频（参数与 8090 /generate 一致，支持文生图/图生图/视频）
 *  - reverse_prompt：图片反推提示词
 */

import http from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** 归置 ComfyUI 的基址；默认本机 8090，可用环境变量覆盖（如指向配置中心 API） */
export const COMFY_BASE_URL = process.env.COMFY_BASE_URL || 'http://127.0.0.1:8090';

/** 生图可能跑 XDN 远程，给足超时；反推给 120s */
const GENERATE_TIMEOUT = 600_000;
const REVERSE_TIMEOUT = 120_000;

async function jsonFetch(path: string, init?: RequestInit, timeout = 10_000): Promise<unknown> {
  const r = await fetch(`${COMFY_BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) {
    let err = '';
    try { err = (await r.text()).slice(0, 300); } catch { /* 忽略 */ }
    throw new Error(`ComfyUI 返回 ${r.status}: ${err}`);
  }
  return r.json();
}

/**
 * 创建一个 ComfyUI McpServer（注册三个工具）。
 */
export function createComfyMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'comfyui-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'list_templates',
    {
      description: '列出可用的生图/生视频工作流模板（含内置 lora 信息）。调用生图前先查模板名。',
    },
    async () => {
      try {
        const data = await jsonFetch('/templates');
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `获取模板失败: ${(e as Error)?.message ?? String(e)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'generate_image',
    {
      description:
        '生成图片（文生图/图生图）或生视频。template 为模板名（可用 list_templates 查，默认 Z-IMAGE文生图.json），' +
        'prompt 为提示词，image 为可选 base64 图（图生图），image_name 为可选历史图名，width/height/seed/steps/cfg/denoise 可调。',
      inputSchema: {
        template: z.string().optional().describe('模板名，如 "Z-IMAGE文生图.json"'),
        prompt: z.string().describe('正向提示词'),
        width: z.number().optional().describe('宽度'),
        height: z.number().optional().describe('高度'),
        seed: z.number().optional().describe('随机种子，-1 随机'),
        steps: z.number().optional().describe('采样步数'),
        cfg: z.number().optional().describe('提示词引导强度'),
        denoise: z.number().optional().describe('重绘幅度（图生图用）'),
        image: z.string().optional().describe('图生图：base64 图片数据'),
        image_name: z.string().optional().describe('图生图：历史图片名（与 image 二选一）'),
      },
    },
    async (args) => {
      const body: Record<string, unknown> = { prompt: args.prompt ?? '' };
      if (args.template !== undefined) body.template = args.template;
      for (const k of ['width', 'height', 'seed', 'steps', 'cfg', 'denoise'] as const) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      if (args.image !== undefined) body.image = args.image;
      if (args.image_name !== undefined) body.image_name = args.image_name;
      try {
        const data = await jsonFetch('/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }, GENERATE_TIMEOUT);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `生图失败: ${(e as Error)?.message ?? String(e)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'reverse_prompt',
    {
      description: '对一张图片做像素级反推，生成可用于再绘制的提示词。传 base64 图片数据（image 或 image_name）。',
      inputSchema: {
        image: z.string().optional().describe('base64 图片数据（不带 data: 前缀）'),
        image_name: z.string().optional().describe('历史图片名（与 image 二选一）'),
      },
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.image !== undefined) body.image = args.image;
      if (args.image_name !== undefined) body.image_name = args.image_name;
      try {
        const data = await jsonFetch('/reverse_prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }, REVERSE_TIMEOUT);
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `反推失败: ${(e as Error)?.message ?? String(e)}` }], isError: true };
      }
    },
  );

  return server;
}

/**
 * 创建可挂到任一 http.Server 的 MCP handler（用于 /mcp/comfy 路径）。
 * 每次请求新建独立 transport（无状态），处理完关闭，避免跨会话串话。
 */
export function createComfyMcpHttpHandler() {
  return async function comfyMcpHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const server = createComfyMcpServer();
    // 无状态：sessionIdGenerator = undefined。SDK 会基于 URL 推导 schema。
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let connected = false;
    try {
      await server.connect(transport);
      connected = true;
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(e) }, id: null }));
      }
    } finally {
      try {
        if (!res.writableEnded) res.end();
        await transport.close();
        if (connected) await server.close();
      } catch { /* 忽略关闭异常 */ }
    }
  };
}
