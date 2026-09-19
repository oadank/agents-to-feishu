/**
 * per-session MCP 穿透共享模块（2026-09-18 收编，取代 5 个 provider 各自复制的 readCtiMcpServers）
 *
 * 来源：配置中心 render.ts 给每个 bot 下发 `CTI_BOT_<ID>_MCP_SERVERS`（JSON 数组，
 * 条目 = {id, displayName, transport, url, command, args, env}，stdio 的 args 已由
 * resolveMcpArgPaths 解析占位符）。本模块把它映射成 ACP session/new 的 mcpServers。
 *
 * ── 引擎行为标志位（新引擎接入 = 在下面矩阵加一行 + 调用处传 flag，不再复制函数）──
 *
 * | flag           | 语义                                        | 引擎（实测证据） |
 * |----------------|---------------------------------------------|------------------|
 * | 'stdioOnly'    | session/new 只接受 stdio 形态，http 条目被拒 | reasonix（-32602 `MCP server "visionqa" command is required`，09-18 一轮）、
 *                  |                                             | hermes（同款报错，二轮只传 stdio 后真调 lark_list_chats ✅）、
 *                  |                                             | mimo（同款，二轮 stdio 后 ✅）、
 *                  |                                             | opencode（session/new 通；模型层终验 09-18 卡 QW3.8F/LiteLLM 待补） |
 * | 'nativeFileOnly' | session/new 的 mcpServers 引擎不消费（stdio 静默失败），真挂载走引擎原生配置文件 | openakita（workspace data/mcp/servers/<id>/，由配置中心 syncMcpToCli 维护；此处仍回传全量条目保持现网线上行为不变） |
 * | 'rejectAllMcp' | 引擎明确拒绝一切非空 mcpServers（ACP bridge 模式）→ 只能传 [] | openclaw（-32603 "ACP bridge mode does not support per-session MCP servers"，09-12 实测；MCP 真挂载走 ~/.openclaw/openclaw.json mcp.servers，由配置中心 syncMcpToCli 维护） |
 * | 'typedHttpAll' | 全量穿透，但 http/sse 条目必须带 type 字面量 + headers 数组（zod union schema） | gemini（CLI 0.58+ 只给 {name,url} 命中 invalid_union ⇒ session/new -32603 收消息卡死；2026-09-11 补 type+headers 后 4 个 MCP 全通） |
 * | (非 ACP 通道)  | 不走 session/new——provider 直连 DeepTutor admin API `PUT /api/settings/mcp/servers/<id>` upsert（AUTH off 时 admin 直通），stdio 条目 tool_timeout 抬到 300s（生图 XDN 分钟级，内核默认 30s 掐死）。工具以 wrapped 名 `mcp_<server>_<tool>` 进 deferred 池，模型 load_tools 后可调 | deeptutor（2026-09-19 票：config→mcp.json 无消费方→provider syncMcpRegistry 接线；实弹痕=本地 WS 轮真调 mcp_cti-builtin_skill_index 返回 13 技能） |
 *
 * ⚠ 实测矩阵更新时同步改这张表；引擎行为有变先改 flag 再动代码。
 */

export type SessionMcpMode = 'stdioOnly' | 'nativeFileOnly' | 'rejectAllMcp' | 'typedHttpAll';

export interface CtiMcpDef {
  id: string;
  transport: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** ACP session/new mcpServers 条目（stdio 形态：env 是 [{name,value}] 数组） */
export type SessionMcpServer = Record<string, unknown>;

/**
 * 读取配置中心下发的勾选 MCP 池原始 defs（解析失败/未勾选返回 []，不抛错）。
 * 给非 ACP 数组形态的消费方用（如 claude SDK 的 record 形态）——解析单一真相源，
 * 形态映射各自本地做，不强行套 ACP 形态。
 */
export function readCtiMcpDefs(botId: string): CtiMcpDef[] {
  try {
    const raw = process.env[`CTI_BOT_${botId.toUpperCase()}_MCP_SERVERS`] || '';
    if (!raw) return [];
    return JSON.parse(raw) as CtiMcpDef[];
  } catch {
    return [];
  }
}

/** 读取配置中心下发的勾选 MCP 池并按引擎模式映射（解析失败/未勾选一律返回 []，不抛错） */
export function readSessionMcpServers(botId: string, mode: SessionMcpMode): SessionMcpServer[] {
  if (mode === 'rejectAllMcp') return [];
  const defs = readCtiMcpDefs(botId);
  const stdio = defs
    .filter((m) => m.transport === 'stdio' && m.command)
    .map((m): SessionMcpServer => ({
      name: m.id,
      command: m.command,
      args: m.args || [],
      env: Object.entries(m.env || {}).map(([k, v]) => ({ name: k, value: v })),
    }));
  if (mode === 'stdioOnly') return stdio;
  const httpPlain = defs
    .filter((m) => m.transport !== 'stdio' && m.url)
    .map((m): SessionMcpServer => ({ name: m.id, url: m.url }));
  if (mode === 'nativeFileOnly') return [...stdio, ...httpPlain];
  // typedHttpAll（gemini CLI 0.58+）：http/sse 条目带 type 字面量 + headers 数组，
  // 否则 zod union invalid_union ⇒ session/new -32603。
  const httpTyped = defs
    .filter((m) => m.transport !== 'stdio' && m.url)
    .map((m): SessionMcpServer => ({
      name: m.id,
      type: m.transport === 'sse' ? 'sse' : 'http',
      url: m.url,
      headers: [],
    }));
  return [...stdio, ...httpTyped];
}
