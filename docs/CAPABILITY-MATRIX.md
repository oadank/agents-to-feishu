# CAPABILITY-MATRIX —— 12 bot MCP 勾选基线台账

> 生成方式：从 `config-store.json` 各 agent 的 `mcps` 勾选自动汇总（2026-09-18 快照）。
> **lark/mh 已回填（2026-09-18 23:32–23:50，23:1x 滚重启后全表复测戳，旧戳 21:01–22:44 全部作废）；桌面/视觉/生图三列待 24 次真调回填。**
> 缺口A 终局矩阵见 openmem `0c0bc52a`；以聊天原文 message_id 为准。
> 生图仅勾选 dsh/zcode（及 deeptutor N/A）；桌面/视觉 11 家。

| bot | runtime | 勾选的 MCP | cti-builtin | lark 工具挂载方式 | lark_* | mh_* | 桌面 | 视觉 | 生图 |
|---|---|---|---|---|---|---|---|---|---|
| dsh | dsh | openmem, cti-builtin, win-desktop-helper, vision, comfy, visionqa | ✅ | 桥接穿透 | ✅ `om_x100b65e1ef13d8a4c2b9e5f9f734336`@23:34 | ✅ `om_x100b65e1d1258ca0c2f8114ad422134`@23:34 | TBD | TBD | TBD |
| claude | claude | win-desktop-helper, visionqa, openmem | ❌ | 自解析（B组） | ✅ `om_x100b65e1d2bba8a8c10545e72b2e9ba`@23:33 | ✅ `om_x100b65e1d4a71ca0c2b065dc727b1d9`@23:32 | ✅ `om_x100b65e2f7d890a0c1062316fcbd9a4`@00:49 | ❌ `om_x100b65e2f5eab8a4c319112f1041aa6`@00:49 未命中 | N/A |
| zcode | zcode | cti-builtin, win-desktop-helper, visionqa, comfy, vision, openmem | ✅ | 勾选即生效 | ✅ `om_x100b65e20aacf0a0c3e6f08479d37f8`@00:18 收编复测 | ✅ `om_x100b65e20c3134a0c28b3d1e1260b2f`@00:17 收编复测 | TBD | TBD | TBD |
| gemini | gemini | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new typedHttpAll | ✅ `om_x100b65e1e2dd58b4c16e6ec45db6094`@23:37 | ✅ `om_x100b65e1e73344a0c237b49d2722ea4`@23:37 | ✅ `om_x100b65e2396d8ca0dd821667ee000dd`@00:31 | ❌ `om_x100b65e2371e5cacdd883e4443c7e25`@00:32 复述不符 | N/A |
| codex | codex | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | config.toml 原生同步 | ✅ `om_x100b65e1fe3618a0c19e398146cc298`@23:38 | ✅ `om_x100b65e1e0008ca4c45b608854417fc`@23:38 | ❌ `om_x100b65e2fad0c0a8c3e3d9c38095028`@00:48 未命中 | ❌ `om_x100b65e2fbb35ca0c34486ea9e6948f`@00:48 复述不符 | N/A |
| mimo | mimo | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e190f5dca4dfaccdec238fb24`@23:50 | ✅ `om_x100b65e192f794a4c2fdc7adb79eabf`@23:50 复测 | ✅ `om_x100b65e2c68338a8c38acb35ab9c191`@00:36 | ❌ `om_x100b65e2c41f64a0c4ff0ce754e2321`@00:37 未命中 | N/A |
| hermes | hermes | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e1f32f1ca0c2f862c3456d57d`@23:42 | ✅ `om_x100b65e1f53978a0dd4075094472e8a`@23:41 | ✅ `om_x100b65e2cf562ca4c118897d57f4b1e`@00:34 | ✅ `om_x100b65e2cd2890a4c1916c5f480e423`@00:35 | N/A |
| reasonix | reasonix | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e18f4ca4a0c2b1847f9c2bc98`@23:43 | ✅ `om_x100b65e18ed580a8dda0fddf13f3193`@23:42 | ✅ `om_x100b65e2d40e80a8c37cfda1b1c2712`@00:41 | ✅ `om_x100b65e2d25070a4c1534930c91bf7c`@00:41 | N/A |
| openclaw | openclaw | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | openclaw.json rejectAllMcp | ✅ `om_x100b65e1997faca0c2b22c5c3c49b40`@23:49 复测 | ✅ `om_x100b65e19b1f08a0c237e3c5f13671a`@23:48 复测 | ✅ `om_x100b65e2e9d208a0c4fa6fe18e23ba8`@00:44 复测 | ❌ `om_x100b65e2e76b60a0c125fe8a997b5c9`@00:45 复述不符 | N/A |
| openakita | openakita | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | workspace nativeFileOnly | ✅ `om_x100b65e180c3c8b0c3e2dc83885e140`@23:46 | ✅ `om_x100b65e1858c5ca4c3e8c5eef7fba17`@23:45 | TBD | TBD | N/A |
| opencode | opencode | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e19dc3e4a8c29c1e6b1695148`@23:48 | ✅ `om_x100b65e19f7f04a0deec938ce46c6f4`@23:47 | ✅ `om_x100b65e2db13b8a0c4e986da4bd93c2`@00:39 | ❌ `om_x100b65e2d9f024acc07fd55ab66319c`@00:40 复述不符 | N/A |
| deeptutor | deeptutor | cti-builtin, visionqa, comfy, vision, win-desktop-helper, openmem | ✅（放弃） | 无 | N/A | N/A | N/A | N/A | N/A |

## 终表口径

- lark/mh：11/11 通（2026-09-18 23:32–23:50 滚重启后复测 + zcode 09-19 00:17–00:18 收编复测，native）；deeptutor=N/A。
- zcode bypass 已根治（续令五）：server 名 displayName→id 收编共享解析后，lark/mh 复测双 native，bypass 形态消失。
- mimo/openclaw 首测瞬态（mimo mh 超时 / openclaw 刚重启未命中），各复测一次即双绿，已按复测戳记。
- 桌面/视觉/生图：按池勾选真调回填（题图 `team-artifacts/probe-ocr.png` 文字须为 `CTI-PROBE-2026`）。
- 体检器 commits：`0585a8c`/`cf74b5c`/`c392f5d`/`d813d20`/三域扩容见后续 hash。
- litellm 未碰；codex 仅 modelId=codex-model（老大口径）。

## 维护口径

- **勾选列**：config-store 唯一真相源；改勾选后 apply，本表手改同步。
- **挂载方式列**：`per-session-mcp.ts` flag 矩阵 + `syncMcpToCli`（docs/MCP-TOOLS.md）。
- **实测状态**：`✅/❌/N-A + message_id@hh:mm`；与脚本冲突以聊天原文为准。
- 防冒名：下发产物 CTI_BOT 一律 bot 本名（99026de）。

## 三域复测方法（桌面/视觉/生图 TBD 列回填口径 · 2026-09-18 续令四）

探针句式 = `scripts/mcp-capability-check.mjs` 的 `PROBE_*` 常量，逐字如下；判定一律只读真调、撞 429/网关限流即停不复试、以聊天原文 message_id 为准。

- **桌面**（11 家）：
  `[MiMo] 体检·桌面：请真调 win-desktop-helper 只读工具（active_window / list_apps / window_info 类），回「前台窗口名 + 窗口数」。禁止点击/按键/拖拽/截图写操作。没有工具就说：没有桌面。`
  判定：只读工具真调成功、回复含前台窗口名/窗口数即 ✅；写操作（点击/按键/拖拽）一律禁止触碰。
- **视觉**（11 家）：
  `[MiMo] 体检·视觉：请真调 visionqa/look_image OCR 或 describe，读 C:\D\opt\agents-to-feishu\team-artifacts\probe-ocr.png，只复述图中文字（原样英文数字）。禁止 curl；没有工具就说：没有视觉。`
  判定：固定题图 `team-artifacts/probe-ocr.png` OCR 复述，原样回出 `CTI-PROBE-2026` 即 ✅；复述不符 = ❌。
- **生图**（仅 dsh/zcode，其余 N/A）：
  `[MiMo] 体检·生图：请真调 generate_image/comfy，512x512 简笔「简笔画：一只猫」，120秒内出图即算成功，回「已出图」+图片路径或 image_key。没有工具就说：没有生图。`
  判定：512² 真出一张、120s 为限；回复带图片路径或 image_key 即 ✅。
- deeptutor 三域 + lark/mh 全 N/A（能力已放弃，老大拍板）。
- mimo 全域数据回来 → 按上口径直接落格，无需另定规则。
