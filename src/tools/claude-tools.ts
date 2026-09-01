/**
 * claude 内置工具注入（2026-08-29 Phase 1，老大拍板方向）
 *
 * 用 Agent SDK 的 createSdkMcpServer 把 ToolRegistry 的工具**进程内**注册给 claude：
 * 内存直调、无 HTTP、无端口、无任何配置——claude 起来就"天生看得到"这些工具。
 * SDK 内部虽叫 in-process MCP，但没有任何网络层，本质是函数调用。
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { buildBuiltinTools } from './registry.js';
import type { BuiltinToolContext, BridgeToolDeps } from './registry.js';
import { buildLarkTools } from './lark-tools.js';

/** 当前轮次的会话 chatId（streamChat 进入时设置，结束清空）——send_voice 等会话敏感工具用 */
let currentChatId: string | null = null;

export function setCurrentChatId(chatId: string | null): void {
  currentChatId = chatId;
}

export interface ClaudeBuiltinServer {
  /** 塞进 query options.mcpServers（Record 形式，键 = server 名） */
  spec: Record<string, McpSdkServerConfigWithInstance>;
}

/**
 * 构建进程内工具 server。deps 变化（attachBridgeTools 重新接线）时由调用方重建。
 */
export function buildClaudeBuiltinServer(deps: BridgeToolDeps): ClaudeBuiltinServer {
  const ctx: BuiltinToolContext = { chatId: null, deps };
  const tools = buildBuiltinTools(deps).map((t) =>
    tool(
      t.name,
      t.description,
      t.schema,
      async (args) => {
        try {
          ctx.chatId = currentChatId;
          console.log(`[claude-tools] ${t.name} 调用`);
          const out = await t.execute(args as Record<string, unknown>, ctx);
          return { content: [{ type: 'text' as const, text: out }] };
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: `工具 ${t.name} 执行失败: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          };
        }
      },
    ),
  );
  const server = createSdkMcpServer({ name: 'cti-builtin', version: '1.0.0', tools: [...tools, ...larkSdkTools()] });
  return { spec: { 'cti-builtin': server } };
}

/** 2026-08-30 飞书内置能力（通讯录/聊天记录/发消息/发图片）：与 mcp-stdio 同源，按 CTI_BOT_X_LARK_TOOLS 白名单过滤 */
function larkSdkTools() {
  const botId = process.env.CTI_BOT || '';
  if (!botId) return [];
  const caps = (process.env[`CTI_BOT_${botId.toUpperCase()}_LARK_TOOLS`] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return buildLarkTools({ botId })
    .filter((t) => !caps.length || caps.includes(t.name.replace('lark_', '')))
    .map((t) =>
      tool(
        t.name,
        t.description,
        t.schema as Parameters<typeof tool>[2],
        async (args: Record<string, unknown>) => {
          try {
            const out = await t.execute(args);
            return { content: [{ type: 'text' as const, text: out }] };
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `工具 ${t.name} 执行失败: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            };
          }
        },
      ),
    );
}
