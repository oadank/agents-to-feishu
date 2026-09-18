# CAPABILITY-MATRIX —— 12 bot MCP 勾选基线台账

> 生成方式：从 `config-store.json` 各 agent 的 `mcps` 勾选自动汇总（2026-09-18 快照）。
> **实测状态已回填（2026-09-18 21:01–22:44 · mimo 一家一读 · 飞书原文 message_id）**。
> 缺口A 终局矩阵见 openmem `0c0bc52a`；本轮以聊天原文为准（脚本竞态误判已修，见 git `c392f5d`/`d813d20`）。

| bot | runtime | 勾选的 MCP | cti-builtin | lark 工具挂载方式 | 实测状态（2026-09-18） |
|---|---|---|---|---|---|
| dsh | dsh | openmem, cti-builtin, win-desktop-helper, vision, comfy, visionqa | ✅ | 桥接穿透（stdioOnly 同源逻辑） | ✅ mh `om_x100b65e0998a08a4c2533473e1d82c9`@22:40 · lark `om_x100b65e095ec38a0c4263dabaed9592`@22:41 native |
| claude | claude | win-desktop-helper, visionqa, openmem | ❌ | 自解析（B组自带，待收编评估） | ✅ mh `om_x100b65e0fd3c54b0c151dd1b887a0c5`@22:31 · lark `om_x100b65e0f6e0e8a4c073f230e20db35`@22:32 native |
| zcode | zcode | cti-builtin, win-desktop-helper, visionqa, comfy, vision, openmem | ✅ | 勾选即生效（原生支持） | ✅ mh `om_x100b65e08c85c8a4c27e91596985f05`@22:35 · lark `om_x100b65e088e12ca0c4b5b3dc692115b`@22:36 native |
| gemini | gemini | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（typedHttpAll） | ✅ mh `om_x100b65e0f2e2fca0dd836284ab07a98`@22:33 · lark `om_x100b65e0f32b98a0c3428208751156f`@22:34 native |
| codex | codex | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | config.toml 原生同步（引擎不消费 per-session） | ✅ modelId 已改 `codex-model` · mh `om_x100b65e0e0571ca0ddc2e9ba2ab3638`@22:30 · lark `om_x100b65e0feb0cca0c3ed09eb6d8d6f9`@22:30 native（此前 QW3.8F+responses 400 已修） |
| mimo | mimo | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（stdioOnly） | ✅ mh `om_x100b65e7222bc0a0c2510edeb93044f`@21:04 · lark `om_x100b65e7208990a0c15a10fc7526520`@21:04 native |
| hermes | hermes | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（stdioOnly） | ✅ mh `om_x100b65e72f6d88a0ddcfad6040d9afd`@21:01 · lark `om_x100b65e72d6450acdd8a402ea50e8af`@21:01 native |
| reasonix | reasonix | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（stdioOnly） | ✅ mh `om_x100b65e09cd428a0c4259dc92e73c5e`@22:39 · lark `om_x100b65e09dc1cca0c218ec85643aae5`@22:39（use_capability → mcp-tool） |
| openclaw | openclaw | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | openclaw.json 原生同步（rejectAllMcp） | ✅ mh `om_x100b65e0834458a0c382c79293cbc86`@22:38 · lark `om_x100b65e0817e98a4c07620690e19b6f`@22:39 native |
| openakita | openakita | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | workspace data/mcp/servers 原生同步（nativeFileOnly，call_mcp_tool 间接调） | ✅ mh `om_x100b65e0ae9328a4c37154debc07bed`@22:43 · lark `om_x100b65e0aa4fa4a4c3351311e736a87`@22:44（call_mcp_tool 间接，非裸名） |
| opencode | opencode | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（stdioOnly） | ✅ mh `om_x100b65e7285ea0a8dda1cb97bc963ec`@21:02 · lark probe `om_x100b65e729b504b4c39148026ce595d`@21:02 · 模型层终验「调 lark_list_chats」`om_x100b65e727d714a8c298a9d15382f7a`@21:03 |
| deeptutor | deeptutor | cti-builtin, visionqa, comfy, vision, win-desktop-helper, openmem | ✅（拍板放弃挂载，勾选未撤） | 无（三层配齐仍卡 turn 装配层） | N/A 老大拍板放弃（openmem `0c0bc52a`） |

## 终表结论（交指挥部落 repo docs）

- **11 家有团队 bot p2p：mh_*/lark_* 全部 ✅ native（本轮 2026-09-18 实测）**；deeptutor = N/A。
- reasonix 走 `use_capability`、openakita 走 `call_mcp_tool` 间接，仍计 native（模型层实调成功、非 curl/绕过）。
- 体检器：`scripts/mcp-capability-check.mjs` commits `0585a8c`（去硬编码+gate warm-up）/ `cf74b5c`（拒 API 报错误报）/ `c392f5d`（只认探针后回复）/ `d813d20`（idempotency-key ≤50）。
- litellm 本体未碰；codex 仅配置中心 `modelId=QW3.8F→codex-model`（老大口径「改为codex-model」）。

## 维护口径

- **勾选列**：以 config-store 为唯一真相源；改勾选后 apply，本表手改同步。
- **挂载方式列**：对应 `src/providers/shared/per-session-mcp.ts` 的引擎 flag 矩阵 + `render.ts syncMcpToCli` 原生同步路径（详见 docs/MCP-TOOLS.md）。
- **实测状态**：回填格式 `YYYY-MM-DD ✅/❌ 一句话证据`（含 message_id）。
- 防冒名保证：无论池条目 env 写了什么，下发产物里每条 MCP 的 `CTI_BOT` 一律为该 bot 本名（render.ts 无条件覆写，99026de 实测）。
