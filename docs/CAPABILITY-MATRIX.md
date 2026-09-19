# CAPABILITY-MATRIX —— 12 bot MCP 勾选基线台账

> 生成方式：从 `config-store.json` 各 agent 的 `mcps` 勾选自动汇总（2026-09-18 快照）。
> **lark/mh 已回填（2026-09-18 23:32–23:50，23:1x 滚重启后全表复测戳，旧戳 21:01–22:44 全部作废）；桌面/视觉/生图三列待 24 次真调回填。**
> 缺口A 终局矩阵见 openmem `0c0bc52a`；以聊天原文 message_id 为准。
> 🔴 终审口径定稿（2026-09-19 老大令）：**终审口径=单域一家一读戳；quick 连轰表作废仅过程存档。**
> 🔴 判分规矩 v2（2026-09-19 老大令）：**✅/❌ 以物理痕迹为准**——先 grep 该家桥日志的工具事件/落盘/发图记录，有痕=✅（聊天文字仅作可见性确认），无痕才算 ❌ 并交日志原文。复测仅限：codex 桌面/视觉（判分器修后首次）、zcode 视觉（两✅=抖动收案）、dsh 五格（重启后）；判分器改动先拿 dsh（全绿已知答案）校一遍才许碰真 bot。
> 生图 11 家（637cc03 起 generate_image 随 cti-builtin 通用下发；deeptutor N/A）；桌面/视觉 11 家。

| bot | runtime | 勾选的 MCP | cti-builtin | lark 工具挂载方式 | lark_* | mh_* | 桌面 | 视觉 | 生图 |
|---|---|---|---|---|---|---|---|---|---|
| dsh | dsh | openmem, cti-builtin, win-desktop-helper, vision, comfy, visionqa | ✅ | 桥接穿透 | ✅ `om_x100b65e1ef13d8a4c2b9e5f9f734336`@23:34 | ✅ `om_x100b65e1d1258ca0c2f8114ad422134`@23:34 | ✅ `om_x100b65edcf078ca0c4b5b19995cd89f`@03:59 native | ✅ v2有痕(判定器未匹配误杀)：引擎 FINAL tools=13 + 3959B 卡片回复成功 @03:59/04:01(探针 om…16d61b09/om…8d213e3f) | ✅ `om_x100b65edc89ba4a0c4aea0a8790ef64`@04:00 agnes·新引擎首秀(03:53 重启；旧 XDN 戳 om_…924d298@00:04 作废) |
| claude | claude | win-desktop-helper, visionqa, openmem | ❌ | 自解析（B组） | ✅ `om_x100b65e1d2bba8a8c10545e72b2e9ba`@23:33 | ✅ `om_x100b65e1d4a71ca0c2b065dc727b1d9`@23:32 | ✅ `om_x100b65e2f7d890a0c1062316fcbd9a4`@00:49 | ✅ `om_x100b65e390c7b4a0c33d4c4e6dadf6e`@02:07 [WB] 复测复述正确 | ✅ `om_x100b65e34543a4a0c02786b202c6080`@01:11 agnes |
| zcode | zcode | cti-builtin, win-desktop-helper, visionqa, comfy, vision, openmem | ✅ | 勾选即生效 | ✅ `om_x100b65e20aacf0a0c3e6f08479d37f8`@00:18 收编复测 | ✅ `om_x100b65e20c3134a0c28b3d1e1260b2f`@00:17 收编复测 | ✅ `om_x100b65ed0edee0a0c44efb9fbe9d36d`@03:41 native | ✅ `om_x100b65ed1d3fa0a0c44cbccabe690e2`@03:47 native·复述正确(首测未命中,复测过) | ✅ `om_x100b65e382b790a0c440669ccc31d92`@02:02 agnes |
| gemini | gemini | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new typedHttpAll | ✅ `om_x100b65e1e2dd58b4c16e6ec45db6094`@23:37 | ✅ `om_x100b65e1e73344a0c237b49d2722ea4`@23:37 | ✅ `om_x100b65e2396d8ca0dd821667ee000dd`@00:31 | ✅ `om_x100b65e39c2440a0c3e71e487b8f414`@02:04 [WB] 复测复述正确 | ✅ `om_x100b65e354a004a4c36b51db09ed051`@01:15 agnes |
| codex | codex | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | config.toml 原生同步 | ✅ `om_x100b65e1fe3618a0c19e398146cc298`@23:38 | ✅ `om_x100b65e1e0008ca4c45b608854417fc`@23:38 | ✅ v2有痕(判定器误杀)：codex rollout-00-46 session function_call 实锤 active_window×2+list_apps×2+get_skill×2 @00:48 | ✅ v2有痕(判定器误杀)：codex rollout-02-01 session function_call 实锤 ocr_image×3+look_image×2 @02:05(om…f2b4dd) | ✅ `om_x100b65e358ba78a0c16ec582edfe30c`@01:14 agnes |
| mimo | mimo | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e190f5dca4dfaccdec238fb24`@23:50 | ✅ `om_x100b65e192f794a4c2fdc7adb79eabf`@23:50 复测 | ✅ `om_x100b65e2c68338a8c38acb35ab9c191`@00:36 | ✅ om_x100b65e39be0c0a4c31e6ccffede9ce@02:05 [WB] v2有痕(判定器误杀)：mimo CLI log look_image completed×4(UTC 18:00/18:05×2/18:53)+复述CTI-PROBE-2026一致 | ✅ `om_x100b65e369e774a8c1575467379449a`@01:18 agnes |
| hermes | hermes | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e1f32f1ca0c2f862c3456d57d`@23:42 | ✅ `om_x100b65e1f53978a0dd4075094472e8a`@23:41 | ✅ `om_x100b65e2cf562ca4c118897d57f4b1e`@00:34 | ✅ `om_x100b65e2cd2890a4c1916c5f480e423`@00:35 | ✅ `om_x100b65e36ecd74a0c39551d5e7200a6`@01:16 agnes |
| reasonix | reasonix | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e18f4ca4a0c2b1847f9c2bc98`@23:43 | ✅ `om_x100b65e18ed580a8dda0fddf13f3193`@23:42 | ✅ `om_x100b65e2d40e80a8c37cfda1b1c2712`@00:41 | ✅ `om_x100b65e2d25070a4c1534930c91bf7c`@00:41 | ✅ `om_x100b65e37a5840a4dd47b8c02c5247d`@01:22 agnes |
| openclaw | openclaw | win-desktop-helper, visionqa, openmem, cti-builtin | ✅ | openclaw.json rejectAllMcp | ✅ `om_x100b65e1997faca0c2b22c5c3c49b40`@23:49 复测 | ✅ `om_x100b65e19b1f08a0c237e3c5f13671a`@23:48 复测 | ✅ `om_x100b65e2e9d208a0c4fa6fe18e23ba8`@00:44 复测 | ✅ `om_x100b65e38d7424a0c29b86d035fe1c9`@02:00 [WB] 复测复述正确 | ✅ `om_x100b65e38d6050a4c16ad6772db60fb`@02:00 agnes |
| openakita | openakita | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | workspace nativeFileOnly | ✅ `om_x100b65e180c3c8b0c3e2dc83885e140`@23:46 | ✅ `om_x100b65e1858c5ca4c3e8c5eef7fba17`@23:45 | ✅ v2有痕：openakita.log@02:55:57 call_mcp_tool win-desktop-helper active_window+list_apps 实调(探针 om…f1f1ee@02:55) | ✅ `om_x100b65e989cf10a4c00d2e62695020f`@08:50 v2有痕(判定器粗体误杀第6例)：复述正确含**CTI-PROBE-2026**，引擎历史有痕(rt.log@10:00:29 会话历史回放)；旧戳 om…3ac2a6ca@02:08 | ✅ `om_x100b65e9845940a0c4fa85aecc2a015`@08:51 native·agnes(已出图17.4s，rt.log@08:51:18 会话历史「已出图 ✅」有痕)；旧戳 om…c0fa830a@02:33(31edcd9 删 style 修复后补) |
| opencode | opencode | cti-builtin, win-desktop-helper, visionqa, openmem | ✅ | session/new stdioOnly | ✅ `om_x100b65e19dc3e4a8c29c1e6b1695148`@23:48 | ✅ `om_x100b65e19f7f04a0deec938ce46c6f4`@23:47 | ✅ `om_x100b65e2db13b8a0c4e986da4bd93c2`@00:39 | ✅ `om_x100b65e38e6878a4c44e18829df200d`@01:59 [WB] 复测复述正确 | ✅ `om_x100b65e30d79f8a0c1540c775c341f3`@01:26 agnes |
| deeptutor | deeptutor | cti-builtin, visionqa, comfy, vision, win-desktop-helper, openmem | ✅（放弃） | 无 | N/A | N/A | N/A | N/A | N/A |

## 终表口径

- lark/mh：11/11 通（2026-09-18 23:32–23:50 滚重启后复测 + zcode 09-19 00:17–00:18 收编复测，native）；deeptutor=N/A。
- zcode bypass 已根治（续令五）：server 名 displayName→id 收编共享解析后，lark/mh 复测双 native，bypass 形态消失。
- mimo/openclaw 首测瞬态（mimo mh 超时 / openclaw 刚重启未命中），各复测一次即双绿，已按复测戳记。
- 桌面（续令六 00:31–00:49 扫表）：8✅/1❌ codex。
- 视觉（续令七 01:59–02:08 [WB] 复测）：agnes-3.0-flash 后端链（886a591 主站→.com→本地 :8091 兜底 + 076a02a 尾数强调 prompt）后 **7✅/2❌**——新增 claude/gemini/openclaw/openakita/opencode 五✅（hermes/reasonix 保留旧戳）；❌=mimo 复述不符×2（疑后端单次吞尾如实复述）、codex 未命中+复述不符（与桌面同款引擎病）。
- 生图（续令八 02:0x-02:3x 终扫落格）：9 家 8✅（ecab05b5 mimo 终扫 01:11-02:00，成功样本后端全部 agnes，口径=自动 image 为唯一 ✅）+ zcode agnes@02:02 新戳 + openakita 修复后补 ✅@02:33（style 400 根因修复 31edcd9：schema 删 style + openai_images 不透传）；dsh 生图旧 XDN 戳待收官窗换 agnes 复测。
- **dsh/zcode 暂缺**——mimo 正在那两家调生图自动发，防撞读排除，待其后补（老大令：这两家重启与否听令）。
- 桌面/视觉/生图：按池勾选真调回填（题图 `team-artifacts/probe-ocr.png` 文字须为 `CTI-PROBE-2026`）。
- 体检器 commits：`0585a8c`/`cf74b5c`/`c392f5d`/`d813d20`/三域扩容见后续 hash。
- litellm 未碰；codex 仅 modelId=codex-model（老大口径）。
- v2 复核（2026-09-19 04:1x-04:4x，老大令查引擎日志）：dsh 视觉 ❌→✅（引擎 FINAL tools=13+3959B）；codex 桌面 ❌→✅（rollout-00-46 function_call active_window×2+list_apps×2）、codex 视觉 ❌→✅（rollout-02-01 ocr_image×3+look_image×2）；openakita 桌面 ⏸→✅（openakita.log 02:55:57 active_window+list_apps 实调）；mimo 视觉 ❌→✅（真身=~/.local/share/mimocode/log/2026-09-18T1753*.log，cti-builtin_look_image completed×4 @UTC 18:00:35/18:05:20/18:05:24/18:53:52，visionqa_look MCP 超时后自动切兜底，复述 CTI-PROBE-2026 与真值一致——判定器被回复内幻觉披露/真值裁判说明+反引号搞挂，文字匹配误杀）。桌面 11✅ 全绿；视觉 11✅ 全绿。粗体/格式误杀清单：①dsh 视觉 ②codex 桌面 ③codex 视觉 ④mimo 视觉(幻觉披露+反引号) ⑤openakita 桌面 ⑥openakita 视觉@08:50(回复把 CTI-PROBE-2026 包进**粗体**，判定器纯文本匹配没剥 markdown；本地可验探针 mid=om_x100b65e9881a70a0c4e9[WB 视觉]/om_x100b65e984b2a4acc36a[WB 生图]，工单所给 mid 为飞书端视角转抄、12 家桥日志均无此串——判分以引擎有痕为准不受影响)。教训：判定器/桥日志无痕 ≠ 真没调，引擎侧日志才是完整证据链——各家位置不同（codex rollout jsonl / openakita.log / dsh 桥 FINAL / mimo ~/.local/share/mimocode/log；~/.mimocode/sessions 是空壳坑）。

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
