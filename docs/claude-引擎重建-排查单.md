# claude bot「引擎进程已重建 3/3」故障排查单

## 一、现象（用户视角）

飞书 claude bot，发一句「只回复收到，禁止调用工具」：

- 卡片空白，**45 秒**没任何输出
- 接着出现 `⚠️ 引擎进程已重建，重试 1/3…`、`⚠️ 引擎进程已重建，重试 2/3…`
- 总耗时 **1 分 12 秒**后失败

**和 Clash 无关**：用户已完整关闭 Clash（TUN 也关），照样复现。

## 二、工程位置

- 桥：`C:\D\opt\agents-to-feishu`，claude provider = `src/providers/claude.ts`
- 日志：
  - `C:\D\opt\agents-to-feishu\logs\claude-rt.log`（实时，关键）
  - `C:\D\opt\agents-to-feishu\logs\claude-out.log`（pump 结束/死亡现场）
  - `C:\D\opt\agents-to-feishu\logs\claude-err.log`
- 模型网关：litellm `http://127.0.0.1:4000`（claude-sonnet-4-5 组，实测 curl `/v1/messages` **1.4-1.8s 正常返回**）
- 服务：`nssm restart claude-bot`（重启后生效）

## 三、已确认的现场（2026-10-17 21:14，来自 claude-rt.log）

```
13:14:08.706 [handleIncoming] text=只回复收到，禁止调用工具
13:14:10.607 [claude] MCP 穿透: win-desktop-helper, visionqa, openmem, comfy, vision, rea
13:14:10.627 [claude] ensureProcess: 已起重进程 cwd=C:\D\opt
13:14:10.627 [claude] streamChat: freshSession=false workdir=C:\D\opt historyLen=2 text.len=12
13:15:10.678 [claude] 空闲 60s 零事件（首包未到，疑引擎进程不在），判定流卡死 attempt=1
13:15:11.687 重建进程 → 13:15:12.695 子进程 exitCode=0（1 秒就退）
13:15:14.709 再重建 → 60s 零事件 → attempt=3 → dispose
```

要点：

1. **`freshSession=false`（resume 老会话）必挂**。
   - 反证：我在命令行用 `claude.exe -p "hi"`（**全新会话**）能出字，但要 58-75 秒；用空 `CLAUDE_HOME` 也一样 65 秒。
   - **所以「新会话 58 秒慢」和「resume 老会话 60 秒零事件」是两件不同的事，别混谈。**
2. `60s 零事件（首包未到）` = SDK `for-await` 一个事件都没吐出来（连 `system/init` 都没到）。
3. 重试时子进程 `exitCode=0` **1 秒即退**（不是崩，是正常退出但什么都不产出）。
4. litellm 侧同一时刻日志 `POST /v1/messages?beta=true 200 OK` **有**记录（说明请求发出去了、网关回了），但桥这边收不到任何事件流。

## 四、已排除项（别重复踩）

| 怀疑 | 实测 | 结论 |
|---|---|---|
| litellm 慢 | curl 三次 1522/1398/1457 ms | 排除 |
| hooks | `--settings '{"hooks":{}}'` 仍 58.6s | 排除 |
| settings.json / 历史会话污染 | `CLAUDE_HOME` 指向空目录仍 65.8s | 排除 |
| 环境变量套路 | 全套 `DISABLE_*` / `NO_PROXY` 无效 | 排除 |
| Clash / TUN | 用户已关 Clash，故障照旧 | 排除（但**新会话 58s 延迟**确与 TUN 有关：关 TUN 后 `-p` 变 1s 级） |
| USERPROFILE=systemprofile | 已在 2026-10-17 修过（`claude.ts` ensureProcess 里有注释） | 已修 |

## 五、当前最强怀疑（未验证，请从此处切入）

**MCP 建连阶段把 SDK query 卡死。**

实测 `claude mcp list`（干净环境）：

```
anysearch            √ Connected
win-desktop-helper   √ Connected
openmem              √ Connected
beeftv               × Failed to connect — CONNECTION_CLOSED
```

- `beeftv` 在 `C:\Users\oadan\.claude.json` 全局 `mcpServers` 里（stdio `C:\D\opt\BeefTV\app\cli\beeftv.exe mcp serve`），**拉起即断**。
- 桥另外还注入了 7 个穿透 MCP（`win-desktop-helper, visionqa, openmem, comfy, vision, rea`），其中 `visionqa / comfy / vision / rea` 的可用性没验过。
- 怀疑点：resume 模式下 SDK 要先等 MCP 全部建连完成才吐 `system/init`，只要有**一个** server 连不上又迟迟不给终态，就会一路卡到 60s 桥侧超时；重试时进程 1 秒退出（已经缓存了失败态）。

**关键待验证实验**（桥侧，注意必须在 **resume 老会话**场景下测，不要用 `-p` 新会话）：

1. 在 `claude.ts` 的 `ensureProcess` 里临时把 `mcpServers` 置空（`mcpServers: {}`），重启 bot，用**同一个老会话**发「只回复收到」，看是否还 60s 零事件。
2. 若空 MCP 就好 → 逐个（先 beeftv、再 visionqa/comfy/vision/rea）加回，定位是哪一个。
3. 若空 MCP 仍挂 → 转查 SDK 的 `resume` 路径本身（`~/.claude/projects/<cwd编码>/<sessionId>.jsonl` 是否损坏 / 会话历史 `historyLen=2` 是否异常），或 SDK 版本（当前 claude CLI 2.1.302）。

## 六、辅助线索

- 同一时段被排除的旁证：WorkBuddy 渲染进程发 HTTPS，`api.github.com` 1.4s、`google/generate_204` 1.5s 正常；`api.anthropic.com` 任意路径 4-130ms 即失败。
- DEBUG=* 能抓到 CLI 会请求 `https://api.anthropic.com/mcp-registry/v0/servers?version=latest&limit=100...`（官方 MCP 注册表，非必要流量）。这条若挂住也可能是 58s 的来源之一，但**解释不了 resume 60s 零事件**。

## 七、验收标准

同一个 claude bot 老会话连发 3 次「只回复收到，禁止调用工具」，**3/3 一次成功、无「引擎进程已重建」、单轮 < 15 秒**。

## 八、改完记得

- `nssm restart claude-bot`
- 结论写回 openmem（source=workbuddy 或 dsh），别只留在聊天里
