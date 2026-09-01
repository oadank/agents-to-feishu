/**
 * 内建看图 MCP 服务 —— 把配置中心内建 look_image（describe / reverse / text 三任务）
 * 暴露成标准 MCP（Streamable HTTP），供所有飞书 agent 通过 dsh-mcp-client 调用。
 *
 * 为什么做成 MCP：dsh-mcp-client 只连标准 MCP 服务（Streamable HTTP / stdio），
 * 要把「配置的图片识别能力」注入给飞书 agent，必须有一个 MCP 服务端。
 * 复用官方 @modelcontextprotocol/sdk，与 dsh-mcp-client 的 StreamableHTTPClientTransport 完全兼容。
 *
 * 与 visionqa(8092) 的区别：这是配置中心内建 look_image 三件套（describe 描述 / reverse 反推生图提示词 /
 * text 逐字提取文字 OCR），读 config-store.json 的 vision 配置，专供飞书 agent 看图用。
 *
 * 部署形态：挂在配置中心(13600) 同一个 http server 的 /mcp/vision 路径（同 /mcp/comfy）。
 * 会话策略：无状态（sessionIdGenerator=undefined），请求-响应式。
 */

import http from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { lookImage } from './look.js';

/** 看图超时：读 config-store vision.timeoutMs，上限 5 分钟 */
const VISION_TIMEOUT = 300_000;

/**
 * 创建看图 McpServer（暴露 look_image 一个工具，task 参数三选一）。
 */
export function createVisionMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'look-image-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'look_image',
    {
      description:
        '查看本地图片。task 三种模式：describe=详细看图描述（默认）；reverse=像素级反推，' +
        '把图片反推成可直接用于 AI 生图（即梦/可灵/Stable Diffusion/Midjourney）的完整中文提示词' +
        '（画面风格/主体/背景/装饰/细节特征/美学与光线/技术修饰）；text=逐字提取图片文字。' +
        '何时调用：用户发了图片 / 问图片里有什么 / 描述图片 / 提取图片文字时。',
      inputSchema: {
        image_path: z.string().describe('本地图片文件的完整路径（如 C:\\tmp\\img.png）'),
        task: z.enum(['describe', 'reverse', 'text']).optional().describe('看图任务：describe=描述（默认）/ reverse=反推生图提示词 / text=逐字提取文字'),
        extra: z.string().optional().describe('可选附加要求（如「重点看左下角」「主角换成女生」），为空按 task 默认'),
      },
    },
    async (args) => {
      try {
        const r = await lookImage({
          imagePath: args.image_path,
          task: args.task ?? 'describe',
          extra: args.extra ?? '',
        });
        if (!r.ok || !r.text) {
          return { content: [{ type: 'text' as const, text: `看图失败：${r.error ?? '未识别到内容'}` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: r.text }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `看图失败：${(e as Error)?.message ?? String(e)}` }], isError: true };
      }
    },
  );

  return server;
}

/**
 * 创建可挂到任一 http.Server 的 MCP handler（用于 /mcp/vision 路径）。
 * 每次请求新建独立 transport（无状态），处理完关闭。
 */
export function createVisionMcpHttpHandler() {
  return async function visionMcpHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const server = createVisionMcpServer();
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
