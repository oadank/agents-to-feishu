# WorkBuddy（第 13 家）能力台账 · 2026-09-19

| 域 | 判 | 证据 |
|---|---|---|
| lark | ✅ | lark_chat_members 数研究社群 bot 成员（tools=16 轮，20:2x 私聊实弹） |
| mh/openmem | ✅ | 搜「第13家」命中并复述标题（同一轮 16 工具） |
| 桌面 | ✅ | active_window 报前台窗口标题（FINAL text=5字） |
| 生图(自动投递) | ✅ | 禁用发送工具仍达：`generate_image 自动发图 …Agnes-1789822174248.png ok=true`，无 N+1 |
| 生图(手动send_image) | ✅ | 20:47 msg_type=image（台账轮，双防线未误伤） |
| 模型基座 | ✅ | 常驻 ACP custom-local:QW3.8F，多轮记忆"翡翠台灯"跨回合复述 ✓ |
| 视觉 | ⏳ | 见本文件底部追加判词 |

## 已知行为缺陷（引擎侧，非桥）
- 工具风暴：纯聊天"记一个词"烧 80 次工具、生图一轮 28 次；明令"不准调工具"仍调（本轮记 26 次）。
- 单轮时延：热态 60s 级，含生图 170s+。根因=模型爱翻工具+MCP stdio 子进程开销，人设压制可缓解，未根治。
- ACP 版 usage 事件暂缺（session_info_update 未见 tokens 字段），卡尾缓存列暂空，非造假（对齐 gemini 处理方式）。
视觉：✅ 复述出画面元素(罗盘/铜/针级特征) 20:53

## 09-19 晚间纠错（老大亲证）
- 🔴 废除'load谎报/强制换代失忆'误判补丁：codebuddy 有真记忆系统（~/.codebuddy/projects/*/memory/MEMORY.md + word_*.md 词文件），session/load 重启恢复实测有效。
- '工具风暴'判词修正：高工具数大头是它写/读自己记忆文件的正常动作（埋词=Write 词文件，追问=Read），并非全疯；--tools 白名单与 --effort medium 保留治真闲逛。
- 测试纪律入账：桥有插队警示卡（处理上一条时新消息排队），必须读完回复全文再出下一题，禁连发。

## 09-20 终审与 --tools 事故补账（对上表"六域全绿"的时效修正）
- 六域全绿证据链属 19 日 19:2x-22:2x（session/new mcpServers 数组形态）。22:2x 我加 `--tools Bash,Read,...` 治工具风暴——**该参数是全局白名单，把 mcp__* 整池连坐砍光**，WB 退化成裸文件工具引擎。22:2x-次日09:0x 窗口内任何"能力在线"的说法不成立，本文件当时未修正＝虚报，记耻。
- 期间两组对照实验均带同一把刀（对照组下毒），"mcp-config 文件不生效"系实验设计错误；真因 09:3x 才定罪。
- 修复 563d0a1：撤 --tools/--mcp-config 实验件，恢复原配数组形态。终审：真调 `mcp__cti-builtin__skill_index`→count=13；`skill_read(lark-im)`→首标题 `# im (v1)`；DeferExecuteTool 痕迹两条在卡，回复全文已读。技能面+工具面双绿。
- AGENTS.md 嫌疑排除：技能正文无 mcp__cti-builtin 字样；模型工具自报来自真实工具表。附带修正：`C:\D\opt\AGENTS.md` 曾自称"你是第13号WorkBuddy"，该目录与 dsh-web 共用致身份互串（老大 09:20 亲见），已改中性环境说明——**工作区根 AGENTS.md 对所有吃该目录的 agent 生效，禁写任何单一身份**。
