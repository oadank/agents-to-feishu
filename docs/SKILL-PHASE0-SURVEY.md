# SKILL Phase 0 摸底 —— 12 家内核「技能目录 / 规则文件注入 / 系统提示追加」分类表

> 交付对象：dsh（Phase 1 统一 skill 方案的设计输入）。
> 证据：2026-09-19 上午家目录磁盘快照 + 桥源码（src/config.ts / src/index.ts / src/config-center/render.ts / src/providers/*），**零代码改动**。
> 方法与局限：纯静态盘查（目录在不在、源码怎么拼提示词），没跑各内核真机验证加载行为——Phase 1 动手前每家需一发真机戳确认。

## 先读这三条结论

1. **唯一通用注入通道 = 桥「首条消息前缀」**。config.ts:170-215 把「统一注入（config-store injection 段 → CTI_SYSTEM_PROMPT_GLOBAL）+ 独立注入（CTI_BOT_<ID>_SYSTEM_PROMPT）」合成 bot.systemPrompt，12 家 provider 全部用同一个套路：每会话首条消息把 systemPrompt 拼在最前（各 provider 的 personaInjected 模式）。**任何要全 12 家都收到的令牌，走这条一定能到**（visionCapable 降级令就是这么走的）。
2. **真·系统提示座位只有 dsh 有**：render.ts:609-617 给 dsh 家写 `~/.dsh/<id>-bot/persona.md`，cordis.yml 的 acp-agent 段用 readFileSync 引用它（真系统提示位，不是用户消息）。其他 11 家没有等价物。
3. **原生技能目录分三档**：
   - **完整在用**：openakita（installed_skills.json 注册表 + 依赖 hash + 更新策略，12 家最完整）、openclaw（workspace/skills + plugin-skills + ClawHub 生态）、hermes（skills/ 三件真在用）。
   - **有机制待挂**：claude（~/.claude/skills/ 空目录，SKILL.md 规范现成）、mimo（~/.local/share/mimocode/builtin_skills/）。
   - **没有**：codex、gemini、opencode（走规则文件/plugins/command）、reasonix、zcode、dsh（Phase 1 主战场）。

## 分类表

| bot（内核） | 技能目录 | 规则文件注入 | 系统提示追加（原生通道） | 桥侧现状 | Phase 1 落点建议 |
|---|---|---|---|---|---|
| **dsh**（deepseek-harness fork） | ❌ 无（Phase 1 主战场） | ✅ `~/.dsh/global-persona.md` 全局 + `~/.dsh/<id>-bot/persona.md`（桥写）+ bot-memory.md | ✅ **真系统提示位**：cordis.yml acp-agent persona readFileSync（render.ts:609-617） | 首条消息前缀（dsh.ts:822 personaInjected）+ persona.md 双通道 | 以 dsh 为基准实现 skills 目录 + prompt 组装契约（serialize / durablePromptContent 附近），做出 12 家的参照实现 |
| **claude**（Claude Code） | ✅ `~/.claude/skills/` 在（SKILL.md 规范）但**空置**；plugins/ 在用 | ✅ `~/.claude/CLAUDE.md` 全局（支持 @import）+ memory/ | ✅ CLI `--append-system-prompt` 原生 flag（桥未用，src 内 grep 零命中） | 首条消息前缀 | 成本最低的一家：桥直接铺 `~/.claude/skills/<name>/SKILL.md` 即被原生加载 |
| **codex** | ❌ 无 skills 目录 | ✅ `~/.codex/AGENTS.md` 全局 + 项目 AGENTS.md 层级；`rules/default.rules` 在用 | ⚠️ config.toml 无直接 system prompt 字段；hooks.json 在用 | 首条消息前缀 | AGENTS.md 追加段 + rules 文件双路 |
| **gemini** | ❌ 无 skills 目录（extensions 机制） | ✅ `~/.gemini/GEMINI.md` 全局 + ROLE.md；settings.json contextFileName | ❌ 无原生字段 | 首条消息前缀（gemini-app-server-client ACP） | GEMINI.md 层级 + extensions |
| **hermes** | ✅ `~/.hermes/skills/` 三件真在用（devops / voice-operations / windows-file-operations） | ✅ `~/.hermes/SOUL.md` 全局 | ⚠️ app-server ACP；未见 CLI flag | 首条消息前缀（hermes.ts:168） | 已有 skills 机制 → 只需对齐统一 SKILL.md 契约 |
| **mimo**（MiMo Code） | ✅ `~/.local/share/mimocode/builtin_skills/`（内置技能；注意 `~/.mimocode/` 是空壳坑） | ❌ 未见全局规则文件（memory/ 自管） | ❌ 未见原生字段 | 首条消息前缀（mimo.ts:332） | 先探明 builtin_skills 加载契约，再决定复用或另铺 |
| **openakita** | ✅✅ **12 家最完整**：`~/.openakita/skills/installed_skills.json` 注册表（安装/启用/依赖 hash/更新策略）+ site-packages builtin_skills | ⚠️ workspace 记忆自管（scheduler memory nudge 定期回顾），未见静态规则文件 | ⚠️ 原生 python ACP server（scripts/openakita-acp-server.py） | 首条消息前缀（openakita.ts:339） | 原生技能注册表直接挂统一分发目录（entry 的 source_path 可指向桥分发的目录） |
| **openclaw** | ✅✅ `workspace/skills` + `plugin-skills/` + `skill-workshop/`（ClawHub 生态） | ✅✅ `workspace/` 下 AGENTS.md + SOUL.md + IDENTITY.md + USER.md 全家桶 | ✅ SOUL.md 即人设位 | 首条消息前缀（openclaw.ts:353）；openclaw.json rejectAllMcp（MCP 全拒，工具走桥内建） | workspace/skills 为落点；规则文件自成一派，别硬塞 |
| **opencode** | ⚠️ plugins/ + 项目侧 `.opencode/command`（无全局 skills 目录） | ✅ `~/.config/opencode/AGENTS.md` 全局 + opencode.json instructions + persona.md | ⚠️ opencode.json 配置 | 首条消息前缀（opencode.ts:332） | AGENTS.md 追加段 + command 分发 |
| **reasonix** | ❌ 无证据（家目录仅 settings.json / sessions / tasks / locks） | ❌ 只有 settings.json | ❌ | 首条消息前缀（reasonix.ts:345） | 纯靠桥注入通道（首条消息拼接） |
| **zcode** | ❌ 无证据（workspace 空） | ⚠️ `~/.zcode/v2/bot-config.v3.json` / config.json（bot 配置文件） | ⚠️ bot-config 字段 | 首条消息前缀（zcode.ts:663，每会话首条） | bot-config 注入段 |
| **deeptutor** | — 能力已放弃（老大拍板，矩阵 N/A） | persona 走 CTI_DEEPTUTOR_PERSONA env（deeptutor.ts:184） | env | env | 不参与 Phase 1 |

## 桥侧注入机制备忘（Phase 1 改造点参照）

- config.ts:170-215：`systemPrompt = buildInjectedSystemPrompt(统一 CTI_SYSTEM_PROMPT_GLOBAL + 独立 CTI_BOT_<ID>_SYSTEM_PROMPT)`，来源 config-store.json 的 injection 段。
- render.ts:226-230：apply 渲染时把两个注入键写进 config.env（mimo 的 visionCapable 降级令 d7243ab 也挂在这条链上）。
- index.ts:189-193：启动时这两个键**不**明文回灌 process.env（防剥离引号破坏多行），由 loadConfig 按 JSON 编码还原到 bot.systemPrompt。
- 各 provider 首条消息注入：claude.ts / codex.ts / dsh.ts:822 / gemini.ts:192 / hermes.ts:168 / mimo.ts:332 / openakita.ts:339 / openclaw.ts:353 / opencode.ts:332 / reasonix.ts:345 / zcode.ts:663。

## Phase 1 设计暗示（给 dsh 的输入，非结论）

- 统一 skill 分发 = 桥写 skill 目录（或 skill 索引）+ 每家一个「挂载适配」：**有原生技能机制的挂原生**（claude/hermes/openakita/openclaw/mimo），**没有的把 skill 索引拼进首条消息或规则文件**（codex/gemini/opencode/reasonix/zcode/dsh）。
- SKILL.md 契约（name/description/正文）建议作为统一交换格式——claude 原生同款，其他家当纯文本读也无损。
- 每家动手前先一发真机戳验证加载行为（本表是静态盘查，不是行为证明）。
