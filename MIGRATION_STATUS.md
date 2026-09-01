# agents-to-feishu 迁移 + 模型联动 状态文档（2026-08-26 交接用）

> 给接手 agent 的最新现状快照。核心：**迁移已 95% 完成，syncModelToCli 模型联动代码已实现并验证传导，剩余为收尾 + 数个 provider 真实对话问题**。

## 一、项目背景
把 PM2 里 10 个 agents-to-im bots 迁移到 agents-to-feishu + 13600 config-center：
- 项目代码：`C:\D\opt\agents-to-feishu`（`npx tsc --noEmit` 通过）
- 配置真相源：`C:\Users\oadan\.agents-to-feishu\config-store.json`（13600 网页读写）
- 每个 agent 一个 nssm 服务 `agents-to-feishu-<id>`，全部 Running 并连接飞书
- PM2 10 个 bots 全 stopped + pm2 save 固化
- **服务进程 env = 启动时 PATH 快照**，LocalSystem 读不到 oadan 目录，已注入 `CTI_HOME`/`CTI_USER_HOME`

## 二、✅ 模型联动（syncModelToCli）—— 核心交付已完成
文件 `src/config-center/render.ts`，`writeAgentArtifacts` 里调用 `syncModelToCli(store, agent, globalExtra)`。
13600 网页切模型 → apply → `npx tsx scripts/gen-all-envs.mjs` 重新渲染 → 各 CLI 配置自动更新 → `nssm restart agents-to-feishu-<id>` 生效。

**各 CLI 联动点（已实现并验证传导）**：
| runtime | 配置文件 | 联动内容 |
|---|---|---|
| openakita | `~/.openakita/workspaces/default/data/llm_endpoints.json` | endpoints[0] base_url/model/api_key_env/note |
| opencode | `~/.config/opencode/opencode.json` | model+provider.<pk>（pk=prov.id 去-） |
| gemini | `~/.gemini/settings.json` | model.name |
| mimo | `~/.config/mimocode/mimocode.json` | model+provider.<pk>（api 字段做 base_url） |
| reasonix | `~/.config/reasonix/config.toml` | 顶层 model |
| hermes | `~/.hermes/config.yaml` | model.default + model.base_url |
| codex | `~/.codex/config.toml` | **见下方三（特殊）** |
| claude | 无（claude.ts 走进程 env ANTHROPIC_BASE_URL，不走 CLI 配置） |
| openclaw | 无单点 model 配置，未写入（注释说明） |
| dsh | 无（DSH harness 由 cordis.yml 管理） |

**关键 helper**：`setTomlValue`（逐行定位，避开 \r\n）、`setYamlValue`、`ensureCodexProvider`。
`CLI_MODEL_NAMES`：gw 的 `deepseek-v4-flash` → `deepseek-v4-flash-0731`（GW 端点实际模型名，已实测 /v1/models 唯一模型）。

**当前 config-store 所有 agent = volc-ark provider + deepseek-v4-flash model**（用户确认不切 gw，保持 volc-ark）。

## 三、⚠️ codex 特殊 —— 2 直连 + 1 litellm 转接
codex 只支持 OpenAI Responses 协议（`wire_api` 固定 `"responses"`，写 `"chat"` 会配置加载失败报 no longer supported）。
- volc-ark（`https://ark.cn-beijing.volces.com/api/plan/v3`）直连**支持** /responses（实测 200）
- gw（`https://gateway.henry-gao.com/v1`）直连**支持** /responses（实测 200）
- **阿里云不支持 /responses，必须经 LiteLLM 网关 `http://localhost:4000` 转接**
- 方案：给 codex config.toml 预置 3 个 `[model_providers.*]` responses 端点（volcark/gw/litellm），按 13600 选的 provider 切 `model_provider` + `model`。已实现并验证 codex config.toml 正确生成 3 段 + 激活 volcark（model=deepseek-v4-flash）。

## 四、❌ 真实对话验证现状（scripts/verify-all.mjs，注意硬编码路径）
| agent | verify 结果 | 说明 |
|---|---|---|
| mimo / gemini / hermes / openakita / reasonix | ✅ PASS | 真实文字回复 |
| **codex** | ❌ FAIL | **不属联动问题**。配置已正确传导，模型已通（无 403），但 codex app-server 疯狂报 `ReasoningSummaryDelta/OutputTextDelta without active item`，文本增量事件被丢 → 收不到回复。**独立 provider 接入 bug**，需单独排查（可能与 codex 版本/流状态机有关，勿在联动任务里纠结） |
| opencode | ❌ 卡死 300s | 迁移时曾验证通过，本次 verify 卡死（疑脚本环境/并发，待查） |
| openclaw | ❌ 卡死 300s | 待查 |
| claude | ❌ spawn EINVAL | cli.bat 存在（C:\WINDOWS\system32\claude.bat），疑 verify 脚本 env 缺 |
| dsh | ❌ ACP 100 timeout | 疑 verify 脚本 env 缺（harness 路径在 config.dsh.env 有） |

**重要**：verify 脚本只 load `config.<id>.env`，环境远不如 nssm 服务的完整注入。PASS/FAIL 是"脚本直连"结论，**不 100% 等同真实服务**。opencode/claude/dsh 的真实服务是否正常，建议直接向真实服务（飞书里 @ 该 bot）发消息确认，而非只信脚本。

`scripts/verify-all.mjs` 用法：`node --import tsx/esm scripts/verify-all.mjs [agentId...]`（不传=全部；工厂函数映射见文件内 FACTORIES）。

## 五、✅ 已完成的收尾
- 清 `C:\D\opt\agents-to-feishu\config.env` hack（CTI_BOT=dsh 绑 gemini 的错配），已备份 `.bak-20260826-232733` 后删除。确认服务优先读 ~/.agents-to-feishu/config.<id>.env（10 个都在），不触达此回退文件。
- bot-memory.md 末尾追加"架构已迁移"醒目标注（2026-08-26），防旧 PM2/config.env 段落误导。

## 五·五、🔴 真实服务对话验证结果（2026-08-27 实测，P2P 私聊 text 消息）

**方法**：用 lark-cli 以 user 身份向每个 bot 的 P2P（open_id）发 **text** 类型消息「只回复一句话：收到，连接正常。」（**必须 text 类型** —— agents-to-feishu 的 parseContent 只解析 msg_type=text，post 类型 text.len=0 直接丢弃）。

**关键发现 1（post 丢弃 bug）**：`src/index.ts` parseContent 只处理 `msgType==='text'`，**post（富文本/带@）消息返回空字符串 → `if(!text) return` 直接丢弃**。之前群里 @ 用 post 发，所有 agents-to-feishu 都收不到（text.len=0），只有老 agents-to-im 桥接（解析 post）会应 one 答「当前群尚未绑定会话/OpenHuman」。

**结果汇总（P2P 私聊 text）**：
| agent | 结果 | 引擎日志 |
|---|---|---|
| gemini / hermes | ✅ **PASS**（真实回复「收到，连接正常。」，Model: ark-deepseek-v4 Provider: 火山 Ark 直连）| — |
| mimo / openakita / openclaw / opencode | ⏳ 收到并进入「思考中」，但 **4 分钟未产出最终文字**（挂起）| opencode 有 `[engine] FINAL text.len=8 thinking.len=273 finalText.len=320`（**引擎已完成但卡片未更新到最终文案 → 卡片更新 bug**）；mimo 等完成 |
| codex | ❌ **空回复**（引擎 `FINAL text.len=0 thinking.len=0`，真实服务复现 verify 的"无文字增量"）| 关联 "without active item" bug |
| claude | ❌ **spawn EINVAL**（真实服务复现 verify，非脚本 env 差异）| `Claude SDK 调用失败: spawn EINVAL` |
| dsh | ❌ **ACP 100 timeout**（真实服务复现 verify，非脚本 env 差异）| `DSH ACP 会话创建失败: ACP request 100 timeout`，无 [engine] FINAL |
| reasonix | ❌ **老 agents-to-im 桥接在应答**（fetch failed / OpenHuman / openhuman-v1）| 疑老 PM2 进程仍占 reasonix app_id 的 WS，需排查 |

**服务已重启**：mimo/reasonix/hermes/codex 4 个（CLI 配置文件 8/27 07:37 更新晚于 8/26 20:47 的服务启动，需重启才用新配置）→ 全部 Running。

## 五·六、🔴 两个根因修复（2026-08-27 实测）

### 1. dsh "ACP request 100 timeout" 根因 = 缺 persona.md（已修复 ✅）
- 现象：dsh 真实对话报 `DSH ACP 会话创建失败: ACP request 100 timeout`
- 根因：`render.ts` 只写 config.env + cordis.yml，**没生成 cordis.yml 引用的 `<botHome>/persona.md`**。acp-demo 插件树加载 `acp-agent` 时 `readFileSync(persona.md)` 报 `ENOENT` → 崩溃 → 永不初始化 → 60s 超时。
- 修复：`writeAgentArtifacts` 里为 DSH harness bot 生成 persona.md（内容 = global 注入 + agent systemPrompt，拼接对齐 `config.ts buildInjectedSystemPrompt`，分隔 `\n\n---\n\n`）。
- 验证：`npx tsx scripts/gen-all-envs.mjs` 生成 23038 字节 persona.md；重启 agents-to-feishu-dsh → acp-demo 预启动成功（常驻）→ 真实对话 `[engine] FINAL text.len=8`（成功产出回复）。

### 2. 重复回复 / reasonix OpenHuman 根因 = 遗留旧 daemon 服务（已停 ✅）
- 现象：gemini @ 消息回复 2 次（旧格式 Provider: volc-ark + 新格式 Provider: 火山 Ark 直连）；reasonix 报 `Agent: OpenHuman | Model: openhuman-v1`
- 根因：存在**遗留 nssm 服务 `agents-to-feishu`（无后缀）**，跑 `dist\daemon.mjs`（旧 agents-to-im 编译产物），以 LocalSystem 挂飞书 WS 抢部分 bot app_id 事件。`openhuman` 只存在于 `agents-to-im\src\...\runtime-configs.ts:355`。
- 修复：`nssm stop agents-to-feishu` + `sc config ... start= demand`（Manual，防自启）。gemini 重复回复消失（只回 1 次）✅。
- ⚠️ reasonix 停旧 daemon 后仍报 fetch failed/OpenHuman —— 疑 reasonix app_id 还有残留旧进程或需重启 reasonix 服务独占 WS，待查。

## 五·七、🔴 全 bot ACP 常驻改造（2026-08-27 已验证 ✅）
- **背景**：用户要求「10 个 bot 都要长连接，不要每次用才冷启动」。
- **根因**：mimo/openakita/opencode/reasonix/openclaw 5 个 provider 的 `prepare()` 有 `if (process.platform === 'win32') { rtLog(...); return; }` —— Windows 下**跳过预启动** → 每条首消息才惰性 spawn ACP（冷启动 60-300s）→ 首条消息「思考中挂起/卡死」（opencode/openclaw verify 和真实对话都卡）。
- **修复**：把 5 个 provider 的 Windows 分支改为**也预启动** `await this.ensureProcess()`（try/catch，预启动失败不阻塞服务启动，消息来时惰性重试兜底）。
- **验证**：重启 5 服务 → 各 ACP 子进程预启动常驻（mimo.exe / openakita-acp-server.py / opencode.exe / reasonix-cli acp / openclaw.exe 都在）；opencode 真实对话从「卡死挂起」→ `[engine] FINAL text.len=8` 正常回复 ✅。
- 10 个 bot ACP 现全部常驻：dsh(acp-demo)、codex/app-server、hermes、gemini + 上述 5 个。

## 五·八、🔴 reasonix OpenHuman 根因 = N5105 openhuman.service（已停 ✅）
- **现象**：reasonix 真实对话报 `Error: fetch failed / Agent: OpenHuman | Model: openhuman-v1`；reasonix 新服务 out.log 无 handleIncoming（收不到消息）。
- **根因（远程排查确认）**：N5105 (100.110.110.12) 有 systemd `openhuman.service`（"agents-to-im openhuman bridge"），`CTI_BOT=openhuman`、`ExecStart=/usr/bin/node /opt/agents-to-im/dist/daemon.mjs`；`/opt/.agents-to-im/config.env` 里 `CTI_BOT_OPENHUMAN_APP_ID=cli_a9313c8bbc799bb5` —— **该 app_id 正是 reasonix 的 app**。旧 agents-to-im 把 reasonix 的飞书 app 配成 openhuman bridge 跑在 N5105，抢占 reasonix 事件 → 新服务收不到 + 被 OpenHuman 应答。日志 debug_realtime_openhuman.log 显示它处理 reasonix 的 P2P (oc_d8a3...) 且调 OpenHuman。同时 N5105 有 `openhuman-web.service`（静态前端 http.server 7799）。
- **修复**：N5105 `systemctl stop openhuman.service && disable`（已 inactive + disabled）。openhuman-web（纯静态，不抢 app）暂留。
- **验证**：停后 reasonix 新服务 `handleIncoming text.len=15` 恢复收到消息（不再被抢占）；OpenHuman 应答消失。reasonix-cli 处理中（重型 CLI，慢），无报错。
- **SSH 姿势**：N5105 用 paramiko（root/200418），见 dsh-ops-env。

## 五·九、🔴 workdir 工作目录「统一 + 分别」设置改造（2026-08-27 后端核心已完成）
- **需求**（用户）：各系统默认启动目录不同，不能再硬编码 `C:\D\opt`；要「全局统一设置 + 每 agent 分别设置」。
- **实现**（src/config-center/store.ts + render.ts + server.ts + config.ts）：
  - `ConfigStore.defaultWorkdir?: string`（顶层全局默认）
  - `AgentDef.workdir?` 改为**可选**（每 agent 覆盖）
  - `resolveAgentWorkdir(store, agent) = agent.workdir ?? store.defaultWorkdir ?? CTI_USER_HOME ?? os.homedir()`（不再硬编码）
  - render.ts 用 helper 写 `CTI_DEFAULT_WORKDIR` / `CTI_DSH_ACP_CWD`
  - server.ts 新建 agent 时 workdir 兜底改用 defaultWorkdir（去掉 'C:\\D\\opt'）
  - config.ts loadConfig 的 defaultWorkdir 改读 `CTI_DEFAULT_WORKDIR`（与 render 一致）+ homedir 兜底（原来读错 key 且硬编码）
- **验证**：`npx tsc --noEmit` 0 错误；`npx tsx gen-all-envs.mjs` 10 全 ok 无回归。
- ⏳ 待续：config-center 网页「统一设置 defaultWorkdir」入口（后端可加 `PUT /api/default-workdir`，前端 overview-settings 加输入框）。

## 六、🔜 未完成收尾（接手继续）
1. **真实服务对话确认**：对 opencode/opencode 卡死、claude/dsh 疑脚本 env 差异——直接向飞书真实服务发消息验证（而非脚本）。
2. **codex app-server "without active item" bug**：独立排查（若用户重视 codex 真实对话）。
3. **删旧记忆**：agentmemory 的 lesson 走 `memory_governance_delete` 会 deleted:0（lesson 不支持该接口删）。若要删误导条目需确认途径；bot-memory 的历史 PM2 段落建议保留（已追加迁移标注防误导）。
4. **重启受联动影响服务**：mimo/reasonix/hermes/codex 等改了 CLI 配置的服务，需 `nssm restart agents-to-feishu-<id>` 才用新配置（部署脚本 scripts/deploy-agents.ps1）。
5. **最终向用户汇报完整迁移清单**。

## 七、关键坑速查（勿重踩）
- `scripts/gen-all-envs.mjs` 必须 `npx tsx` 跑（node 直跑 ERR_MODULE_NOT_FOUND，import 的是 TS 模块）。
- AppEnvironmentExtra 必须写注册表 `<svc>\Parameters\AppEnvironmentExtra`（MultiString），不能写顶层；nssm get 输出带零宽空格不能直接解析。
- GW key 在 `C:\Users\oadan\.dsh\.credentials.yaml`（GW_API_KEY 单行）。ARK key 也在同文件。
- 各 CLI 配置路径见"二"表格。
- 生命周期：改 config-store/render.ts → `npx tsx scripts/gen-all-envs.mjs` → `nssm restart agents-to-feishu-<id>`。
- verify-all 脚本加载 config.<id>.env 用 JSON 还原 systemPrompt（多行）时注意 `JSON.parse`。
