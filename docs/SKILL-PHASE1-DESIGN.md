# SKILL Phase 1 统一技能方案（设计稿 · 不含代码）

> 输入：Phase 0 摸底表（docs/SKILL-PHASE0-SURVEY.md，commit 3ff5430）。
> 作者：dsh ｜ 2026-09-19 ｜ 状态：**设计待老大拍板，未动任何代码**。
> 本文所有"实测"均为 dsh 只读磁盘/配置取证，非转抄摸底表。

## 0. 一句话结论

**单一技能源（repo `skills/`）+ 桥 apply 双分发面**：有原生机制的家走「磁盘挂载面」（铺目录/挂 customSkillDirs），没有的家走「目录注入面」（首条消息只注 name+一句话+全文路径，用到才读）。全 12 家的注入面通道已被 visionCapable/toolRoute 两轮证明 12/12 可达。

## 1. 对摸底表的实测修正（3 处）

| # | 表里说法 | 实测修正 | 证据 |
|---|---|---|---|
| ① | dsh 技能目录 ❌ 无，"Phase 1 主战场=从零实现" | **不成立**。DSH harness 有原生技能加载，且**双挂载面在用**：用户级 `~/.dsh/skills/`（9 个：dsh-ops-* ×8 + all-platform-video-extract，与本会话目录完全对应）+ per-bot `cordis.yml` 的 `@deepseek-ai/dsh-skill-filesystem` `customSkillDirs`（已挂 `agents-to-feishu/skills/feishu-bridge`，注释"启用 1/1 个技能"）。Phase 1 对 dsh **不是发明机制，是复用现成挂载面**，成本骤降 | `~/.dsh/dsh-bot/cordis.yml` skill 段实读 |
| ② | claude `~/.claude/skills/` 空置 | 属实但有个畸形嵌套：`skills/skills/`（空目录，无任何文件）。铺目录前先清掉这个壳，防"嵌套一层导致永远扫不到"的静默失败 | `gci .claude\skills` |
| ③ | mimo `~/.local/share/mimocode/builtin_skills/` 可挂 | **不宜直挂**。实为安装器自管的版本库（条目名是 `0.1.14`/`desktop-xxxxxx`，不是技能名）。挂载契约=未知，只能真机探 | 目录实扫 |

另注：本会话目录里 ~30 个 lark-* 技能的物理来源在 `~/.dsh` 与 `C:\D\opt` 浅层都没扫到（疑 harness 内置包或深层路径）——不影响设计，挂载面已实锤。

## 2. 目标 / 非目标

**目标**：技能正文只写一份（repo 单一源），桥 apply 自动到各家；新增一家适配 = 加一个挂载适配器，不改内核。
**非目标（Phase 1 不做）**：技能市场/依赖解析/自动更新（openakita 注册表那套不跟）；各家内核源码改造（含 mimo/openakita 契约逆向）；deeptutor（老大已拍板 N/A）；UI 配置页（先只动 config-store JSON，见 §8 问题 3）。

## 3. 架构

```
agents-to-feishu/skills/<name>/SKILL.md        ← 唯一源（git 即版本管理；现已存在，feishu-bridge 是活例）
        │            apply（render.ts，与 visionCapable/toolRoute 同链 buildAgentGlobalInject 家族）
        ├─ 磁盘挂载面（原生家）：铺/挂 → claude·hermes·dsh·openclaw（openakita 二期）
        └─ 目录注入面（无原生家）：systemPrompt 追加「技能目录段」：
              name ｜ 一句话 description（≤60字）｜ SKILL.md 绝对路径
              ＋ 使用指令：「任务命中某技能时，先读该路径全文再行动」
```

- **目录注入面只发索引不发全文**：全文进首条消息会随技能数线性爆炸（前科：openmem 手册 5294 字符/3320 token 每次入上下文，老大亲自拍板删过）。
- 源目录保持 `skills/` 不动（`skills-market/` 是历史遗留别名区，**Phase 1 收编为唯一源 `skills/`**，memory-ops/comfyui-ops/feishu-bridge 三件对齐到一处；收编=git mv，零运行时风险）。
- config-store 数据模型：`agents[].skills = [names]`（每家勾选）+ `injection.defaultSkills = [names]`（全员默认，如 memory-ops）。开关独立于 visionCapable/toolRoute，互不阻塞。

## 4. 挂载适配器表（每家一个，apply 时执行）

| 家 | 面 | 动作 | 备注/待探 |
|---|---|---|---|
| dsh | 磁盘 | 挂进 cordis `customSkillDirs`（逐技能目录路径）或铺 `~/.dsh/skills/`；**择一，优先 customSkillDirs**（桥本来就在写 cordis，链路现成） | 会话内 skill 工具已在，验收=目录里出现新技能名 |
| claude | 磁盘 | 铺 `~/.claude/skills/<name>/SKILL.md`；先删 `skills/skills` 空壳 | 待探：运行时扫描 or 启动快照（后者需 nssm restart claude 才见） |
| hermes | 磁盘 | 铺 `~/.hermes/skills/<name>/`，对齐现有三件格式 | 机制在用，风险最低 |
| openclaw | 磁盘 | 铺 `~/.openclaw/workspace/skills/<name>/` | 它 workspace 规则文件全家桶**不要碰** |
| openakita | 磁盘(二期) | 先只读探 installed_skills.json 对"外来目录技能"的容忍度，再定 source_path 直挂 or 走它安装器 | 依赖 hash 它自管，硬塞=漂移风险 |
| mimo | 目录注入 | 暂按无原生处理（builtin_skills 不可直挂，见 §1③） | 契约探明后可升磁盘面 |
| codex | 目录注入 + 可选规则文件 | 目录段进注入；成熟后可追加 `~/.codex/AGENTS.md` 指针段 | AGENTS.md 是共享全局文件，写入要幂等标记块 |
| gemini / opencode / reasonix / zcode | 目录注入 | 纯注入面（zcode 可探 bot-config 字段作二期优化） | — |

## 5. SKILL.md 契约（统一交换格式）

- 目录名 = frontmatter `name`；`description` 单行 ≤60 字（它就是目录行，也进 claude 原生格式）；正文纯 markdown。
- 可选 `bots:`（缺省=注入 defaultSkills 的家都给）。
- **写法纪律**（吸收本轮探针教训）：技能正文里的数字/ID/路径示例一律真值，禁止"应该如此"式示例——技能会被 12 家当事实读。

## 6. 实施步骤（顺序即风控）

- **Step 0 · 真机探针（零代码，今晚可做）**：造 `probe-skill-9527`（正文藏唯一 token），用**现有**通道手动测：claude/hermes 手铺目录、dsh 手改 cordis、codex/reasonix/zcode 拿 `CTI_BOT_<ID>_SYSTEM_PROMPT` 手拼目录段。每发一家→飞书戳"你目录里有 probe 吗+背出 token"。摸底表自留的"静态盘查非行为证明"这一课在这里还账。**结果修正 §4，再动代码。**
- **Wave 1**：claude + hermes + dsh（磁盘面，3 家；render.ts 一个铺目录函数 + customSkillDirs 写入）。
- **Wave 2**：目录注入面收进 `buildAgentGlobalInject`（6 家）+ openclaw + openakita/mimo 探针结果落地。
- 铁律沿用：12 家滚动 apply **一次一家** + nssm 单家验活；restart 自己宿主须走他家代跳；与 MiMo 的 config-center 改动错峰 commit（工作区现存 `tool-route-roll.md` 仍是 M 未 commit，归属 MiMo 线，我不动它）。
- 验收口径（每家一句）：报出可见技能清单 + 点名的技能能读出 token。产物落 `C:\D\opt\team-artifacts\skill-phase1\`（这次不塞仓库内）。

## 7. 红线

- 不碰：litellm / D5 / key / engine / look.ts / registry.ts；MCP 配置不摘（老大裁过"配置不许摘，降级只文字级"——同款纪律迁移到本线：**卸载技能=从目录里摘名字，不删各家家目录文件**，回滚即恢复）。
- 写各家家目录（~/.claude 等）前必须备份同名路径；铺目录动作幂等（同名覆盖 SKILL.md，不递归删）。

## 8. 开放问题（请老大拍板）

1. `defaultSkills` 全员默认发哪几件？（建议起步只放 memory-ops + feishu-bridge）
2. 目录注入面 6 家的实现归属：dsh 写 render、reasonix 总控验收？（建议是）
3. 配置中心 UI 要不要"技能"页签？Phase 1 建议**先不动 UI**，纯 config-store JSON，跑顺再上页签。
