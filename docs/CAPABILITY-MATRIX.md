# CAPABILITY-MATRIX —— 12 bot MCP 勾选基线台账

> 生成方式：从 `config-store.json` 各 agent 的 `mcps` 勾选自动汇总（2026-09-18 快照）。
> **实测状态列当前全部 TBD**：mimo 正在做「一家一读」实测（读 config.env 产物 + 真调工具），
> 数据回填后逐行更新本表。缺口A 的终局矩阵（9 有/2 无/1 待）见 openmem `0c0bc52a`，
> 本表以实测回填为准，不沿用旧结论。

| bot | runtime | 勾选的 MCP | cti-builtin | lark 工具挂载方式 | 实测状态 |
|---|---|---|---|---|---|
| dsh | dsh | openmem, cti-builtin, win-desktop-helper, vision, comfy, visionqa | ✅ | 桥接穿透（stdioOnly 同源逻辑） | TBD |
| claude | claude | win-desktop-helper, visionqa, openmem | ❌ | 自解析（B组自带，待收编评估） | TBD |
| zcode | zcode | cti-builtin, win-desktop-helper, visionqa, comfy, vision, openmem | ✅ | 勾选即生效（原生支持） | TBD |
| gemini | gemini | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（typedHttpAll） | TBD |
| codex | codex | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | config.toml 原生同步（引擎不消费 per-session） | TBD |
| mimo | mimo | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（stdioOnly） | TBD |
| hermes | hermes | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（stdioOnly） | TBD |
| reasonix | reasonix | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（stdioOnly） | TBD |
| openclaw | openclaw | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | openclaw.json 原生同步（rejectAllMcp） | TBD |
| openakita | openakita | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | workspace data/mcp/servers 原生同步（nativeFileOnly，call_mcp_tool 间接调） | TBD |
| opencode | opencode | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new 穿透（stdioOnly） | TBD |
| deeptutor | deeptutor | cti-builtin, visionqa, comfy, vision, win-desktop-helper, openmem | ✅（拍板放弃挂载，勾选未撤） | 无（三层配齐仍卡 turn 装配层） | TBD |

## 维护口径

- **勾选列**：以 config-store 为唯一真相源；改勾选后 apply，本表手改同步。
- **挂载方式列**：对应 `src/providers/shared/per-session-mcp.ts` 的引擎 flag 矩阵 + `render.ts syncMcpToCli` 原生同步路径（详见 docs/MCP-TOOLS.md）。
- **实测状态**：回填格式 `YYYY-MM-DD ✅/❌ 一句话证据`；mimo 数据回来优先回填。
- 防冒名保证：无论池条目 env 写了什么，下发产物里每条 MCP 的 `CTI_BOT` 一律为该 bot 本名（render.ts 无条件覆写，99026de 实测）。
