/**
 * CTI 内置工具 stdio MCP server（2026-08-30 能力配齐第二阶段）
 *
 * 背景：claude（SDK 进程内）/ dsh（harness 插件）自带 look_image 等内置工具；
 * 其余 CLI（codex/gemini/opencode/reasonix/openclaw…）各自支持 MCP 配置，
 * 把同一份注册表用 stdio MCP 暴露给它们 —— 与 claude/dsh 同源同实现。
 *
 * 注册方式（各家 CLI 配置里挂）：
 *   command = node.exe
 *   args    = [tsx/dist/cli.mjs, 本文件路径]
 *
 * 工具集：look_image / generate_image / reverse_prompt / transcribe
 * （send_voice 需要 chatId 桥接上下文，走桥接 wantsVoiceReply 自动通道，不在此暴露）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildBuiltinTools } from './registry.js';
import { buildLarkTools } from './lark-tools.js';

const EXPOSE = new Set(['look_image', 'generate_image', 'reverse_prompt', 'transcribe']);

const server = new McpServer({ name: 'cti-builtin', version: '1.0.0' });

// 工具来源①：视觉/生图/转写（registry 同源）
const tools = buildBuiltinTools({});
// 工具来源②：飞书原生能力（2026-08-30 内置化：通讯录/群/发消息/聊天记录）
const botId = process.env.CTI_BOT || '';
const larkCaps = (process.env[`CTI_BOT_${(process.env.CTI_BOT || '').toUpperCase()}_LARK_TOOLS`] || '').split(',').map((s) => s.trim()).filter(Boolean);
const larkAll = botId ? buildLarkTools({ botId }) : [];
const larkTools = larkCaps.length ? larkAll.filter((t) => larkCaps.includes(t.name.replace('lark_', ''))) : larkAll;
const register = (name: string, description: string, schema: unknown, handler: (args: Record<string, unknown>) => Promise<string>) => {
  // 运行时 SDK 1.30 的 tool() 重载类型标注与 zod raw shape 不完全匹配——运行正常（tools/list 已验证），断言绕过
  (server.tool as (n: string, d: string, s: unknown, h: (a: Record<string, unknown>) => Promise<unknown>) => void)(
    name, description, schema,
    async (args) => {
      try {
        const out = await handler(args);
        return { content: [{ type: 'text', text: out }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `工具执行失败: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );
};
for (const t of tools) {
  if (!EXPOSE.has(t.name)) continue;
  register(t.name, t.description, t.schema, async (args) => {
    const out = await t.execute(args, { deps: {} });
    return typeof out === 'string' ? out : JSON.stringify(out);
  });
}
for (const t of larkTools) {
  register(t.name, t.description, t.schema, t.execute);
}

await server.connect(new StdioServerTransport());
// stderr 仅调试用（stdio 协议下 stdout 是协议通道，禁止 console.log）
console.error(`[cti-builtin-mcp] ready, tools=${[...tools.filter((t) => EXPOSE.has(t.name)).map((t) => t.name), ...larkTools.map((t) => t.name)].join(',')}`);
