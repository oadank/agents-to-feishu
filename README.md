# agents-to-feishu

把多个 AI Agent 桥接到飞书 / Lark 的独立、可分发框架（多 Agent 配置中心 + 飞书消息桥接）。

**设计原则（2026-08-25）**
- **完全独立**：运行与本机 DSH / dsh-harness 解耦，`config-store.json` 是唯一配置真相源。clone 项目、配好模型 key 即可跑。
- **配置中心**：管理任意多个 Agent，每个 Agent 是一个飞书应用 + 一套模型/MCP 配置。网页可视化增删改。
- **内建能力**：看图 `look_image` 项目自带（只在配置里填一个视觉模型 key 就能用，无需外部看图服务）。
- **重 MCP 外接**：要装客户端/权限的 MCP（如 win-desktop-helper 控制电脑）独立挂载，不强制依赖。

## 架构

```
config-store.json（唯一真相源：providers 池 / mcps 池 / agents 分配置 / vision 看图配置）
        │  配置中心 (agentsconfig 服务)
        ├── 渲染生成 → 每个 agent 的 config.<id>.env + cordis.yml（或自建内核配置）
        ├── 飞书桥接进程（每 Agent 一个）
        └── 网页（概览 / Agent 分配置 / 总配置·模型 / 总配置·MCP / 看图配置）
```

## 快速开始（新机器 clone 后 10 分钟上手）

> 前置：Node.js ≥ 20（Windows 建议 Git Bash）。各 Agent 的 CLI（claude/codex/gemini/opencode…）
> 装一个配一个——配置中心会**自动探测**（PATH 查找 + 常见安装位置），运行时管理页显示「✓ 已检测到」即可用。

1. 安装依赖：`npm install`
2. 启动配置中心（首次运行自动生成 `~/.agents-to-feishu/config-store.json` 骨架）：
   `npm run config-center`，浏览器打开 `http://localhost:13600`
3. 网页「总配置」：建一个模型 Provider（填你的 baseURL + API Key + 模型，如 `https://ark.cn-beijing.volces.com/api/plan/v3` + 火山方舟 key；或任何 OpenAI 兼容网关）
4. 网页「Agent 分配置」：新建 Agent——飞书应用凭证（App ID/Secret，[创建应用指南](https://open.feishu.cn/document/home/introduction-to-custom-app-creation/overview)）、
   选 runtime（自动探测到的 CLI）、选 provider/model、勾选 MCP、设端口。保存即自动渲染配置。
5. 启动该 Agent 的桥接进程（每个 Agent 一个进程）：
   ```bash
   node node_modules/tsx/dist/cli.mjs --require node_modules/tsx/dist/preflight.cjs src/index.ts
   ```
   开发环境可临时用环境变量指明身份：`CTI_BOT=<agentId> node node_modules/tsx/dist/cli.mjs src/index.ts`
   （Windows 长期运行建议用 nssm/计划任务把该命令注册成服务，服务环境需带 `CTI_BOT=<agentId>` 和 `CTI_USER_HOME`）
6. 在飞书里给这个 bot 发第一条消息——闭环完成。

**凭证存放**：网页填写的 key 存 `~/.agents-to-feishu/.credentials.yaml`（项目自有凭证层，`KEY: value` 格式）；
也兼容读取 `~/.dsh/.credentials.yaml`（历史遗留）。**不要把 key 提交进仓库。**

**跨机器适配**：代码中无机器特定路径——用户目录一律 `os.homedir()` 解析，CLI 路径 = 配置中心「运行时管理」页
可覆盖（写进 config-open.json）+ 自动探测兜底。遇到"命令不存在"，优先查该页的探测状态。

## 配置

- 配置存储文件：`~/.agents-to-feishu/config-store.json`（未生成则首次创建默认骨架）
- 凭证：每个 provider/看图的水平，可在对应 `apiKeyEnv` 的背后放
  `<home>/.agents-to-feishu/.credentials.yaml`（`KEY=value` 或 `KEY: value`）或直接在网页填。
- 配置中心服务：端口默认 13600，网页 `http://<host>:13600`（本机长期运行可注册为 nssm 服务 `agentsconfig`）。

## ZCode 运行时接入（2026-09-05）

第 12 个 agent：ZCode 桌面版内置 CLI 经 **ZCode Protocol**（`zcode.cjs app-server --stdio`，换行分隔 JSON，非 ACP）常驻接入。

- **依赖**：ZCode 桌面版（CLI 位于 `C:\Program Files\ZCode\resources\glm\zcode.cjs`），`CTI_ZCODE_CLI` 可覆盖路径。
- **配置穿透（唯一模型来源）**：config-store 选的 provider/model/key 经配置中心渲染进 `config.<bot>.env`，provider 读 `CTI_BOT_<ID>_MODEL / _BASE_URL / _API_KEY / _CONTEXT_WINDOW / _THINKING_LEVEL` 组装协议的 `runtimeModel`（inline apiKey），在 `session/create|resume` 时下发——网页切模型 → apply → 下条消息生效，不依赖也不修改 `~/.zcode/cli/config.json`。
- **MCP 穿透**：配置中心勾选的 MCP 池渲染成 `CTI_BOT_<ID>_MCP_SERVERS` JSON，provider 映射为协议 `mcpServers`（stdio → command/args/env；streamable-http → http url）随会话下发。会话级注入，不写客户端配置文件；`~/.zcode/cli/config.json` 的 `mcp.servers` 可作为桌面端/CLI 自己的补充层，两层同名会话内自动去重。
- **权限（无头必读）**：app-server 交互会话默认 build 模式 = 一切工具调用需审批（无头场景表现为 "Permission request failed" 全拦截）。provider 在 create/resume 显式传 `mode: 'yolo'` 解决；服务器→客户端的 `interaction/requestPermission` 兜底自动选 allow 选项。
- **思考层与闪烁**：GLM-5.3 工具循环每轮都出新思考（单轮可达 1.9 万字），引擎💭块是尾部 400 字滑动窗口——高频转发会让整窗内容反复全换（视觉=正文从头重打）。provider 流式只转发思考前 400 字后冻结，`turn.completed` 补发真实尾部 1100 字（终卡 1500 尾窗保真）。终态全量推送仍有一次正常闪动（全 bot 共有的引擎收尾）。
- **工具环境坑**：app-server 的 Bash 工具 PATH 是内部构建的精简清单，不含用户级 Python——已用 `~/bin/python|python3|py` shim 根治（Git Bash 会执行 ~/bin 下无扩展名脚本）。
- **会话**：sessionKey → zcode sessionId 映射落盘 `~/.agents-to-feishu/runtime/zcode-sessions.json`，桥接重启自动 `session/resume` 续上下文；`/new` 关闭重建；`/stop` 走 `session/stop`。
- **冒烟**：`node node_modules/tsx/dist/cli.mjs scripts/zcode-smoke.mjs`（两轮对话验证流式 + 会话连续性 + 穿透）。

## 配置中心 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/store` | 读整个 config-store |
| POST | `/api/agents` | 新建 Agent |
| PUT/DELETE | `/api/agents/:id` | 改/删 Agent |
| POST | `/api/agents/:id/apply` | 应用：渲染生成其配置文件并重启进程（真实生效） |
| GET  | `/api/agents/:id/status` | 该 Agent 运行时状态（Session/Cache/平均/上下文/余额） |
| GET/PUT | `/api/vision` | 读/写内建看图配置 |
| POST | `/api/vision/test` | 测试看图（imagePath + task: describe/reverse/text） |
| PUT | `/api/providers/:id` / `/api/mcps/:id` | 改总配置（模型/MCP 池） |

## 目录结构

```
src/
  index.ts           飞书桥接入口（每 Agent 一个进程，CTI_BOT 区分）
  config.ts          配置加载（读 config.<id>.env）
  bridge/            engine / session（消息 → 流式 → 卡片）
  providers/         运行时 provider 接口 + DSH ACP 实现（将替换为自建内核）
  config-center/     store / render / runtime / server / migrate（配置中心）
  vision/            look.ts（内建看图，3 工具 describe/reverse/text）
web/config-center/   配置中心前端（Vue3 + Element Plus，暗黑主题）
```

## 架构思维导图与排障索引（2026-08-29 正式版 v1.0.0）

接手排查问题，先看这几个文件，不用通读源码：

- **`architecture-map.html`** — 可交互思维导图（给人看）。中心是项目，外圈 11 个阶段按消息闭环排布（虚线环 = 闭合主流程 19 步）；点分支下钻，点节点看「职责 / 目录 / 文件 / 行号 / 上游 / 下游」，上下游按钮可点击跳转；顶栏「问题定位」按 18 种症状直达该看的代码（图上会高亮相关节点及其所属阶段）；搜索框可按功能名/文件名定位。
- **`ARCHITECTURE-MAP.json`** — 机器可读数据（给 agent / 工具查）。11 stages / 69 nodes（每个带 dir / file / lines / role / notes）/ 96 edges（`from==id` 是下游、`to==id` 是上游）/ `flow`（端到端闭环，首尾都是用户）/ `diagnostics`（症状 → 相关节点 + 排查步骤，含环境变量名、默认值、行号）。
- **`ARCHITECTURE-AUDIT.md`** — 独立子代理审核报告（2026-08-29）。CRITICAL 2 / MAJOR 13 全部修复，图内行号已逐条回源码核实；「无法证实」项在对应节点 notes 标注（待人工确认）。

维护方式（单一数据源）：改 `ARCHITECTURE-MAP.json` 后执行 `node scripts/build-architecture-map.mjs` 重新生成 HTML。**改了源码导致行号变化时，必须同步更新 JSON 里对应节点的 `lines` 再重新生成**，否则图会把人带偏。

## 说明

- 目标演进中：当前 provider 层仍复用 DeepSeek Harness 的 ACP（将逐步替换为自建 cordis 式内核），但**配置与看图已完全独立于 dsh**。
