# skills/ —— 全团队技能唯一中央目录（规范版）

> 2026-09-19 老大裁定：所有可分发技能**只放这一处**（本目录，git 管理）。`skills-market/` 已并入并废除，禁止再建第二个中央目录。

## 目录规范（硬约束）

```
skills/
└── <kebab-case 技能名>/     ← 一技能一目录，目录名=技能名
    ├── SKILL.md             ← 必需。frontmatter 含 name + description；正文即技能全文
    ├── scripts/ 等          ← 可选。技能自带的可执行脚本/参考资料随目录走
    └── (禁止 .git 嵌套)     ← 从外部仓库复制时必须剔除 .git
```

- `name`：与目录名一致；`description`：一句触发说明（模型靠它决定用不用），**≤200 字**。
- 全 12 家读取通道：`skill_index`（列清单）/ `skill_read`（读全文），另有额外扫描根走 env `CTI_SKILLS_DIRS`。
- 新技能落地 = 往本目录加一个子目录，**默认全员自动可见**（老大裁：能力丢进来大家都能收到）。

## 现有技能（7）

| 技能 | 说明 |
|---|---|
| `all-platform-video-extract` | 解析 1000+ 视频平台链接取标题/封面/各清晰度直链（自 C:\D\opt\all-platform-video-extract 收编，含脚本） |
| `comfyui-ops` | 本机 8090 生图调度台运维（原 skills-market 并入） |
| `feishu-bridge` | 飞书桥接运维：消息不通/卡片不刷新/插队卡不弹诊断 |
| `lark-ops` | 飞书操作规范（workbuddy 迁移中，待 commit） |
| `memory-ops` | openmem 记忆读写规矩（原 skills-market 并入，09-18 版） |
| `openmem-rules` | openmem 规则速查（workbuddy 迁移中，待 commit） |
| `vision-verify` | 看图能力验证规程（workbuddy 迁移中，待 commit） |

## 散落存量（Phase 2 迁移清单，勿现在动）

`~/.dsh/skills/`（9，含与中央重复的 video-extract——DSH 挂载在用）、`~/.workbuddy/skills`（18）、`~/.hermes/skills`（3）、各家内核私产（openakita 注册表/mimocode 安装器自管，格式不通用不硬迁）。原则：**新技能只进中央；存量改稿时顺手搬进来改指向，不批量搬家**。
