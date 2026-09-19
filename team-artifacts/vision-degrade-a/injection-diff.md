# 视觉能力智能降级 · A 段注入产物 diff（2026-09-19）

## 测试对
| agent | model | visionCapable | 注入降级令 |
|---|---|---|---|
| mimo | QW3.8F (litellm) | true（现役默认） | ✅ 有 |
| claude | claude-model (litellm) | false（手切） | ❌ 无 |

## 降级令文案
你看图优先用自身视觉直接看；look_image/看图 MCP 仅在需要逐字提取、长图放大、像素级反推或你自看不准时作为兜底工具。

## 产物路径
- mimo: C:\Users\oadan\.agents-to-feishu\config.mimo.env
- claude: C:\Users\oadan\.agents-to-feishu\config.claude.env

## SYSTEM_PROMPT_GLOBAL 对比
### config.mimo.env
- LEN=10510
- HAS_DEGRADE=True
- tail: ``
用（openakita 等原生 MCP 引擎的姿势）。


你看图优先用自身视觉直接看；look_image/看图 MCP 仅在需要逐字提取、长图放大、像素级反推或你自看不准时作为兜底工具。
``

### config.claude.env
- LEN=10443
- HAS_DEGRADE=False
- tail: ``
_mcp_tool：用 `call_mcp_tool(server="cti-builtin", tool_name="lark_xxx", arguments={...})` 间接调用（openakita 等原生 MCP 引擎的姿势）。

``

## 关键差异
- mimo 注入 = claude 注入 + 降级令后缀
- 后缀 = `你看图优先用自身视觉直接看；look_image/看图 MCP 仅在需要逐字提取、长图放大、像素级反推或你自看不准时作为兜底工具。`

