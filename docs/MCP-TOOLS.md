# MCP 工具挂载指南（12 bot 共用 cti-builtin / lark_* 等）

> 一页说完：新 bot 怎么挂 MCP、apply 怎么跑、怎么回滚。细节证据见代码注释（`src/providers/shared/per-session-mcp.ts` 实测矩阵）。

## 新 bot 挂 lark（或任何 stdio MCP）

1. 配置中心（:13600）勾选该 agent 的 MCP（如 `cti-builtin`）→ 保存即 apply + 重启该 bot。
2. 挂载方式由 runtime 自动分流，无需手工改文件：
   - **ACP 穿透型**（zcode/gemini/dsh/claude/reasonix/hermes/mimo/opencode/openakita）：勾选经 `CTI_BOT_<ID>_MCP_SERVERS` 下发，provider 按 `src/providers/shared/per-session-mcp.ts` 的引擎 flag 映射进 session/new（`stdioOnly` / `nativeFileOnly` / `rejectAllMcp` / `typedHttpAll`）。
   - **原生文件型**（openclaw / openakita / codex）：apply 时 `render.ts syncMcpToCli` 幂等落各自原生配置并自动带 `CTI_BOT=<botId>`：
     - openclaw → `~/.openclaw/openclaw.json` `mcp.servers.<id>`
     - openakita → `~/.openakita/workspaces/default/data/mcp/servers/<id>/{config.json,SERVER_METADATA.json}`（另写 `~/.openakita/data/mcp/servers/` 兼容）
     - codex → `~/.codex/config.toml` `[mcp_servers.<id>]` + `.env` 子表
3. 引擎是独立服务的（openclaw-gateway）要重启才重载 MCP 子进程 env（env 是启动快照）。

## apply 怎么跑

- 单个：`POST :13600/api/agents/<id>/apply`；按 runtime 全量：`POST :13600/api/agents-by-runtime/<runtime>/apply`。
- apply = 渲染 config.env/cordis.yml + syncModelToCli + syncMcpToCli + 重启该 bot。
- 审计日志：`logs/config-apply-<日期>.log`；写盘前自动备份 `<file>.bak-<时间戳>`。

## 回滚三板斧

1. **配置文件**：同目录 `.bak-<时间戳>` 拷回；或删掉 synced 条目再 apply（会按勾选长回——想真删先去勾选）。
2. **代码**：`git log` 找上个 commit → `git revert` / checkout 单文件。
3. **验证**：回滚后 `POST /api/agents/<id>/apply` + 重启引擎服务，发一条"调 lark_list_chats"实测。

## 已知边界

- syncMcpToCli 只写「勾选的 stdio 型」；http 型挂载（openakita catalog、codex url 段）不归它管。
- 取消勾选不删原生条目（保守设计）；文件被锁/JSON·TOML 解析失败会报错不静默（console + 审计日志）。
- codex app-server 模式当前**不加载** config.toml 的 mcp_servers（引擎 bug，另案）；openclaw ACP bridge 拒绝 per-session MCP（-32603）——这两家的 lark 全靠原生文件。
