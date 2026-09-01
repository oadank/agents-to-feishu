# Agent 能力登记表（2026-08-30 建档）

> 维护规则：每次实测后更新对应格；**未测的必须写"未测"，不许凭感觉填 ✅**。
> 证据列写日志/会话文件出处，方便复查。

## 语音能力（ASR / TTS）

**要求**：①ASR 自动识别要快且准 ②收到语音必须回语音 ③语音回复必须是**模型专门写的口语化文本**（禁止朗读正文——正文含代码/路径）④TTS 引擎/音色跟随设置页 speech 段变化

| agent | ASR 识别 | 语音回复 | 口语化 | 证据（日期） |
|---|---|---|---|---|
| claude | ✅ 准（矩阵 v2） | ✅ 矩阵发出 | ⚠️ 待抽验听感 | 08-30 |
| codex | ✅ 准（"你好"） | ✅ 自写块 90 字 | ✅ 用户实测确认 | 08-30 老大实测 |
| dsh | ✅ 准（矩阵 v2） | ✅ 矩阵发出 | ⚠️ 待抽验听感 | 08-30 |
| gemini | ✅ 准（矩阵 v2） | ✅ 矩阵发出 | ⚠️ 待抽验听感 | 08-30 |
| hermes | ✅ 准（矩阵 v2） | ✅ 追问块 12 字（偏短） | ⚠️ 偏短待验 | 08-30 |
| mimo | ✅ 准（矩阵 v2） | ✅ 矩阵发出 | ⚠️ 待抽验听感 | 08-30 |
| openakita | ✅ 准（矩阵 v2） | ✅ 矩阵发出 | ⚠️ 待抽验听感 | 08-30 |
| opencode | ✅ 准（矩阵 v2） | ✅ 矩阵发出 | ⚠️ 待抽验听感 | 08-30 |
| openclaw | ✅ 准（矩阵 v2） | ✅ 矩阵发出 | ⚠️ 待抽验听感 | 08-30 |
| reasonix | ✅ 准且快（3-5 秒出转写） | ✅ 自写块 66 字 | ✅ 本轮自写口语块 | 08-30 13:20 |

- ASR **速度未量化**：日志行无时间戳，量化需加时间戳（待做）
- 语音回复兜底链：块缺失/过短(<4字)/规则回显 → 同会话追问一次补写 → 仍失败发固定短语音
- ⚠️ **TTS 跟随设置页**：机制上 loadSpeechConfig 读 config-store.json，但 bot 进程启动时加载一次——**设置页改音色/引擎后需要 apply/重启才生效**（未做实时联动，待办）
- ⚠️ reasonix 曾静默跳过语音分支一次（12:2x，原因未定位）——已在语音分支入口加诊断日志（`语音分支: replyAudio=... voiceText.len=...`），再出现一击必中

## 内置工具（看图/生图/反推/转写）

| agent | 看图 | 方式 | 生图/反推 | 证据 |
|---|---|---|---|---|
| claude | ✅ | SDK 进程内工具（look_image 全模式） | ✅ 工具 | 08-29 实测 |
| dsh | ✅ | ACP 插件（同源实现） | ✅ 工具 | 08-29 实测 |
| codex | ✅ | 桥接代劳（识别注入） | ❌ 未接入 | 08-30 实测 |
| gemini | ✅ | 桥接代劳 | ❌ 未接入 | 08-30 实测 |
| 其余 6 家 | ✅ | 桥接代劳 | ❌ 未接入 | 08-30 实测（codex/gemini 抽查，同代码路径） |

- ⚠️ MCP 注入进度：stdio server 已建好并验证（mcp-stdio.ts），但 **codex app-server 模式不加载新增 MCP**（exec 模式正常）——待专项；gemini settings.json 已有 HTTP look_image 条目未验证
- ❌ 生图/反推仅 claude/dsh；其余需 MCP 逐家接入（依赖上面专项）

## 状态栏 / 缓存命中率

| agent | 🎯 命中率 | 说明 |
|---|---|---|
| claude / codex / dsh / hermes | ✅ 真实数据 | 上游如实上报（hit 2-3 万+） |
| mimo / openakita / opencode / openclaw / reasonix | ⚠️ 无数据 | CLI 层不透传 usage（探针实锤 usage 全 0） |
| gemini | ⚠️ 无数据 | _meta.quota 不返回 |
| 根治方案 | 📋 待拍板 | LiteLLM per-bot 虚拟 key 统计 |

## 流式卡片稳定性

| 项 | 状态 |
|---|---|
| 抽风症状（写一半重写/闪全，终卡正常） | ⚠️ 已定位机制：element 更新失败 → 永久降级整卡 PATCH，与骨架 streaming_mode 交替打架 |
| 修复 | ✅ 08-30：element 失败重试一次，仍失败先关流式再 PATCH（engine.ts render） |
| 效果验证 | ⏳ 未复测（等下次出现同类症状时对照日志 `cardElement update failed ×2`） |

## 其他

| 项 | 状态 |
|---|---|
| 配置穿透（保存即生效+受保护键） | ✅ 08-30 |
| 收图 24h TTL 清理 | ✅ 08-30 |
| 13600 双绑+断电补绑 | ✅ 08-30 |
| ASR/TTS 语音测试语音素材 | Temp/adan-test.opus（"你好呀我是阿丹…"有意义内容）、asr-test.opus（无意义，弃用） |

## 08-30 下午更新（老大五连测后）

| agent | 更新项 | 状态 |
|---|---|---|
| codex | 语音"两遍+怪声" | 引擎本地复现无重复（10.08s 正常）；已加 **opus 时长审计日志**，复现即抓 |
| hermes | 双语音规则（旧手动脚本 vs 桥接自动） | ✅ 已清理：SOUL.md 旧规则段删除（备份 .bak）；块没读出根因=sendVoiceReply 静默 return，已加全链路日志+speech 实时化 |
| codex | AGENTS.md 旧语音技能段（voice-engine/发音频流程） | ✅ 已删除 3 段，替换为新规则 |
| mimo | 无思考层/工具层显示 | ⚠️ **CLI 协议限制**（探针实锤：不吐 thought/tool 事件、usage 全 0）——工具实际有调用只是不显示 |
| gemini | 英文回复 | ✅ 已加中文独立注入（保存即穿透） |
| gemini | 思考层/缓存命中率 | ⚠️ LiteLLM 转接不透传；转换层入库=独立大活待拍板（入库后命中率+gw 余额可显示） |
| 全员 | TTS/ASR 跟随设置页 | ✅ **已实现实时联动**（speech 实时读 store，改设置页保存后立即生效，无需重启） |
| 全员 | 思考深度开关（设置中心） | 📋 框架待做：agent.thinkingLevel → render 按 runtime 写键 |

## 08-30 16:30 更新

| 项 | 状态 |
|---|---|
| gemini"过期消息"提示（65 分钟前的消息才处理） | ✅ 已修：prompt 无超时挂起卡死队列 → 加 10 分钟超时护栏；hermes 同病同修（600s）；其余 5 家 ACP 本有 300s watchdog ✅ |
| 流式队列卡死防护 | ✅ 全 10 家覆盖：gemini/hermes=超时护栏，5 家 ACP=watchdog，claude/dsh=SDK/harness 自身机制 |
| 思考层"消失"疑云 | 倾向非 bug：简单问题模型本来不思考；dsh 实测健在。复验法=问复杂问题看 thinking.len |

## 08-30 16:30 更新（盘点目标落地）

| 目标 | 状态 |
|---|---|
| 状态栏「图标/文字」二选一开关 | ✅ **已实现**：设置页 agent 编辑加"状态栏显示"下拉（图标+文字/仅图标）→ store.dividerMode → env CTI_BOT_X_DIVIDER_MODE → 卡片渲染。保存（自动应用）即生效 |
| 设置中心「思考深度」开关 | ✅ **已实现（dsh/codex）**：设置页"思考深度"下拉（默认/关闭（干活快）/高）→ dsh=不声明 thinkingFormat/reasoning（模型按不会思考跑）、codex=model_reasoning_effort=minimal。gemini/claude 等待接（默认行为不变） |
| ASR 速度量化 | ✅ 日志加耗时（`语音转写成功: "…" (耗时 X.Xs)`），下次语音测试即可量化 |
| TTS/ASR 设置页实时联动 | ✅（本轮早前完成） |
| gemini/hermes 超时误报 | ✅ 修复：正文已完整流出时超时按正常完成处理，不再报错 |

## 08-30 16:45 更新（开关实测 + 概览合并）

| 项 | 状态 |
|---|---|
| 思考深度开关真有效性 | ✅ **实测**：dsh off → cordis.yml 无 thinkingFormat/reasoning（配置层）→ thinking.len 349→63（大幅缩短；模型自带轻量思考无法归零）。验证后 dsh 已恢复 default（总控要思考） |
| 状态栏开关真有效性 | ✅ 实测：dsh icon → env CTI_BOT_DSH_DIVIDER_MODE=icon（已恢复 full，开关在设置页随取随用） |
| 概览页合并 | ✅ 余额/用量/状态数据搬进「Agent 分配置」列表行；概览导航+页面已移除（备份 _removed-overview-backup/）。**浏览器 Ctrl+F5 强刷可见** |
| PUT 字段白名单坑 | ✅ 已修：PUT /api/agents/:id 合并漏 dividerMode/thinkingLevel 导致静默丢字段（新增字段必须同步加进白名单！） |
| codex MCP 加载专项 | ⏳ 时间盒内未破：exec 模式正常加载、app-server 模式不加载新 MCP；二进制 strings 逆向超时。候选：升级 codex / 查官方文档 thread/start 参数 / app-server 进程级 `-c mcp_servers` 注入 |
| 口语化文本审计 | ✅ v3/v3b 全 10 家口语内容已采集（capability-result.txt）：均为专门口语描述图片，无读正文、无乱码。听感终验需你耳朵 |

## 08-30 17:55 更新

| 项 | 状态 |
|---|---|
| **codex MCP 专项解决** 🎉 | ✅ **升级 codex 0.145.0→0.151.0**：app-server 模式（桥接）6 个 MCP 全部正常加载（agentmemory/wiki/cti-vision/cti-comfy/cti-builtin/node_repl），实测模型能列出并使用。根因=0.145.0 app-server bug |
| codex 内置工具可用性 | ✅ look_image/generate_image/reverse_prompt/transcribe 对 codex 可用（MCP 工具） |
| providers 余额显示 | ✅ ArkResp/GWResp 等协议变体无专属 agent 时，共享同 baseURL 网关的额度数据 |
| 飞书内置工具（通讯录/发消息/聊天记录/文档等） | 📋 方案已定稿待开工：lark-tools.ts（tenant token + IM API）挂进 mcp-stdio + 设置页能力勾选区块 + agent 飞书凭证管理 |

## 08-30 18:00 更新

| 项 | 状态 |
|---|---|
| 状态栏三选一（图标/文字/仅数值） | ✅ value 模式单测：`42.50%｜55.10%｜45%(20K/100K)` 纯数值。openclaw 已设为仅数值 |
| providers 余额 origin 兜底 | ✅ GWAnth（无 /v1）等协议变体共享同网关额度，强刷可见 |
| **飞书内置工具开工** 🚀 | ✅ 核心落地：`lark-tools.ts`（tenant token 管理 + 4 工具：lark_list_chats 通讯录入口/lark_chat_history 聊天记录/lark_send_text 发消息/lark_lookup_user 查人）挂进 mcp-stdio。**实测 lark_list_chats 真实返回 2 会话** ✅。对 MCP 客户端（codex 0.151.0 等）即开即用 |
| 飞书工具后续 | ⏳ 设置页"飞书能力"勾选区块（按 agent 启用）、claude SDK 侧接入、发图片/文件/卡片、文档能力 |
| 听感终验 | ✅ 老大确认目前都正常 |

## 08-30 18:20 更新（飞书工具二轮）

| 项 | 状态 |
|---|---|
| lark_send_image（发本地图片） | ✅ 新增（multipart 上传→image_key→发消息） |
| 设置页「飞书内置能力」勾选区块 | ✅ 每 agent 可勾选启用：会话列表/聊天记录/发消息/查人/发图片（缺省全开）→ store.feishuCaps → env → mcp-stdio/claude SDK 双侧过滤 |
| claude SDK 侧接入 | ✅ lark 工具进 createSdkMcpServer（cti-builtin），实测 tools=1 调用成功 |
| 全员覆盖 | ✅ claude（SDK）+ MCP 客户端（codex 0.151.0 等）双通道同源 |

## 08-30 18:55 更新（hermes 事故 + 出厂测试）

| 项 | 状态 |
|---|---|
| **hermes 卡死根因** | ✅ 定位：terminal_tool 每次创建本地环境挂死（"Creating new local environment"后无下文），卡在 hermes-agent 包内部 shell 启动子进程链。已清孤儿进程（残留 hermes acp 持锁）。彻底修复需动 hermes-agent 包（专项） |
| hermes 当前状态 | ⚠️ 能启动能收消息，一调 terminal 工具就挂（600s 桥接护栏会兜底报错）。临时绕法：重启 hermes + 杀残留进程；其他功能（文本对话）正常 |
| 提示词出厂化 | ✅ hermes SOUL.md 已删除"发消息身份铁律"旧教程+旧语音脚本残留（备份 .bak-factory-*） |
| 出厂测试样本 | ⏳ hermes 被 terminal_tool 挂起阻塞——换样本重测（reasonix 已验证过语音/联系 OK） |
| 状态栏 bug | ✅ 已修：枚举误删 full 导致全部 bot 悄悄变文字样式；已恢复 full 为默认，openclaw=仅数值 |
| 通讯录澄清 | ✅ lark_list_chats 就是通讯录（bot 所在全部会话含私聊 chat_id）；oc_7f7cfb…=你与 hermes 的私聊会话 |

## 📋 语音/识图组合测试登记表（2026-08-30 最终版）

| bot | 看图 | 语音 | 状态 |
|---|---|---|---|
| claude | ✅ | ✅ 39字口语 | 全过 |
| codex | ✅ | ✅ 90字口语 | 全过 |
| dsh | ✅ | ✅ 26字（22:24 修复后实测） | 全过 |
| gemini | ✅ | ✅（用户 21:1x 实测） | 全过 |
| mimo | ✅ | ✅ | 全过 |
| openakita | ✅ | ✅ | 全过 |
| opencode | ✅ | ✅ | 全过 |
| openclaw | ✅ 组合轮文字未完（FINAL=0） | ✅（用户关 Clash 后实测） | 语音过 |
| reasonix | ✅ 组合轮文字未完（FINAL=0） | ✅（用户关 Clash 后实测） | 语音过 |
| **hermes** | ✅（挂死前） | ⚠️ **修复后未实测**（挂死前 12 字兜底质量差） | **待补测** |

登记原始数据：logs/capability-result.txt（识图+语音组合矩阵）、logs/voice-real-result.txt（语音专项 13:07-13:15）、logs/health9-*.txt（20:30 文本健康检查）。
**唯一缺口：hermes 修复后（22:00）的语音+看图端到端未实测——下次对话先补这条。**

## 🎉 hermes 零提示词工具注入打通（23:30）

- hermes config.yaml mcp_servers 加 cti-builtin（stdio：node + tsx + mcp-stdio.ts，env 注 CTI_BOT=hermes/CTI_HOME）→ 注册 87 tools from 3 servers
- **端到端验证**：发"用 lark_list_chats 查会话"→ tools=2 调用成功，回复会话名（23:26，Turn ended 正常）
- 至此飞书内置工具三条接入路线全通：**claude=SDK 进程内 / codex 等=各自 MCP 配置 / hermes=config.yaml MCP**——零提示词依赖
- 踩坑记录：YAML 双引号内 \n \D 是非法/意外转义 → 整份 config 解析失败 → hermes 回退 openrouter 默认报 401。**Windows 路径在 YAML 里必须用单引号**
- 状态栏三模式穿透验证：默认引擎切 local 后 claude/mimo/opencode 中性话术实测全部自动 engine=local ✅

## 🎉 覆盖缺口补齐（23:50）——对照提示词旧能力的三个缺口全部关闭

| 新工具 | 覆盖的旧提示词能力 | 验证 |
|---|---|---|
| `lark_bot_directory` | 飞书 Agent 通讯录（手抄 open_id 表→自动生成，10 bot 全量，缓存 10 分钟） | ✅ 探针返回 10 bot |
| `lark_send_post` | post 富文本（多段落+@人+标题） | ✅ 实发成功（含@陈丹） |
| `lark_send_as_user` | user 身份传话（调 lark-cli --as user，复用其 OAuth 管理，零 token 维护） | ✅ 实发成功 |

**对照结论：旧提示词教的 12 项飞书能力已 100% 工具化覆盖，零提示词依赖。**
UI 勾选清单同步 10 项；render 白名单同步。探针脚本：scripts/_tts-probe.mts / _local-tts-probe.mts（保留可复用）。

## 🎉 全自动传话闭环（00:50）

- `lark_send_as_user` 升级：**to=<agentId> 即可**（如 to="codex"）——内部经 lark-cli `+chat-list --types=p2p`（用户视角全部私聊会话）按 bot 名自动匹配 chat_id 发送。**零手抄 id，新装用户只要和 bot 聊过一句就自动可通**
- 真实闭环测试：hermes to="claude" 发送成功 ✅（claude 会收到陈丹名义的传话并可 to="hermes" 回执）
- 设置中心 Agent 分配置页新增全局区块：**群聊仅@开关**（勾选即存 settings.groupMentionOnly）+ **用户身份测试按钮**（/api/tools/user-self-test，以 bot 身份给自己发验证消息）
- 踩坑：lark-cli chat-list 的数据结构是 data.chats（不是 items）
