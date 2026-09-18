# CAPABILITY-MATRIX —— 12 bot MCP 勾选基线台账

> 生成方式：从 `config-store.json` 各 agent 的 `mcps` 勾选自动汇总（2026-09-18 快照）。
> **lark/mh 已回填（2026-09-18 21:01–22:44）；桌面/视觉/生图三列待 24 次真调回填。**
> 缺口A 终局矩阵见 openmem `0c0bc52a`；以聊天原文 message_id 为准。
> 生图仅勾选 dsh/zcode（及 deeptutor N/A）；桌面/视觉 11 家。

| bot | runtime | 勾选的 MCP | cti-builtin | lark 工具挂载方式 | lark_* | mh_* | 桌面 | 视觉 | 生图 |
|---|---|---|---|---|---|---|---|---|---|
| dsh | dsh | openmem, cti-builtin, win-desktop-helper, vision, comfy, visionqa | ✅ | 桥接穿透 | ✅ `om_x100b65e095ec38a0c4263dabaed9592`@22:41 | ✅ `om_x100b65e0998a08a4c2533473e1d82c9`@22:40 | TBD | TBD | TBD |
| claude | claude | win-desktop-helper, visionqa, openmem | ❌ | 自解析（B组） | ✅ `om_x100b65e0f6e0e8a4c073f230e20db35`@22:32 | ✅ `om_x100b65e0fd3c54b0c151dd1b887a0c5`@22:31 | TBD | TBD | N/A |
| zcode | zcode | cti-builtin, win-desktop-helper, visionqa, comfy, vision, openmem | ✅ | 勾选即生效 | ✅ `om_x100b65e088e12ca0c4b5b3dc692115b`@22:36 | ✅ `om_x100b65e08c85c8a4c27e91596985f05`@22:35 | TBD | TBD | TBD |
| gemini | gemini | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new typedHttpAll | ✅ `om_x100b65e0f32b98a0c3428208751156f`@22:34 | ✅ `om_x100b65e0f2e2fca0dd836284ab07a98`@22:33 | TBD | TBD | N/A |
| codex | codex | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | config.toml 原生同步 | ✅ `om_x100b65e0feb0cca0c3ed09eb6d8d6f9`@22:30 | ✅ `om_x100b65e0e0571ca0ddc2e9ba2ab3638`@22:30 | TBD | TBD | N/A |
| mimo | mimo | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e7208990a0c15a10fc7526520`@21:04 | ✅ `om_x100b65e7222bc0a0c2510edeb93044f`@21:04 | TBD | TBD | N/A |
| hermes | hermes | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e72d6450acdd8a402ea50e8af`@21:01 | ✅ `om_x100b65e72f6d88a0ddcfad6040d9afd`@21:01 | TBD | TBD | N/A |
| reasonix | reasonix | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e09dc1cca0c218ec85643aae5`@22:39 | ✅ `om_x100b65e09cd428a0c4259dc92e73c5e`@22:39 | TBD | TBD | N/A |
| openclaw | openclaw | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | openclaw.json rejectAllMcp | ✅ `om_x100b65e0817e98a4c07620690e19b6f`@22:39 | ✅ `om_x100b65e0834458a0c382c79293cbc86`@22:38 | TBD | TBD | N/A |
| openakita | openakita | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | workspace nativeFileOnly | ✅ `om_x100b65e0aa4fa4a4c3351311e736a87`@22:44 | ✅ `om_x100b65e0ae9328a4c37154debc07bed`@22:43 | TBD | TBD | N/A |
| opencode | opencode | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e727d714a8c298a9d15382f7a`@21:03 终验 | ✅ `om_x100b65e7285ea0a8dda1cb97bc963ec`@21:02 | TBD | TBD | N/A |
| deeptutor | deeptutor | cti-builtin, visionqa, comfy, vision, win-desktop-helper, openmem | ✅（放弃） | 无 | N/A | N/A | N/A | N/A | N/A |

## 终表口径

- lark/mh：11/11 ✅ native（2026-09-18 实测，见上）；deeptutor=N/A。
- 桌面/视觉/生图：按池勾选真调回填（题图 `team-artifacts/probe-ocr.png` 文字须为 `CTI-PROBE-2026`）。
- 体检器 commits：`0585a8c`/`cf74b5c`/`c392f5d`/`d813d20`/三域扩容见后续 hash。
- litellm 未碰；codex 仅 modelId=codex-model（老大口径）。

## 维护口径

- **勾选列**：config-store 唯一真相源；改勾选后 apply，本表手改同步。
- **挂载方式列**：`per-session-mcp.ts` flag 矩阵 + `syncMcpToCli`（docs/MCP-TOOLS.md）。
- **实测状态**：`✅/❌/N-A + message_id@hh:mm`；与脚本冲突以聊天原文为准。
- 防冒名：下发产物 CTI_BOT 一律 bot 本名（99026de）。
