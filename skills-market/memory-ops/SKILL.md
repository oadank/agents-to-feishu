# 技能：openmem 统一记忆中枢（路标）

当涉及 openmem 记忆读写、经验沉淀、项目知识检索时使用本技能。

> ## ⚠️ 本文件只是**路标**，别往这里堆细节
> 「openmem 怎么用」的唯一真源 = **`C:\D\opt\openmem\MANUAL.md`**（git 可追溯）。
> 取法二选一：
> - **`mh_tool(name="openmem 使用手册")`** ← MCP，**0.3 秒秒回**（推荐）
> - 直接读 `C:\D\opt\openmem\MANUAL.md`（全文 7000+ 字，含接入/工具/写入规范/Web API/12 条坑）
>
> **要改这条知识 → 只改真源（MANUAL.md）+ 刷成品答案缓存，不要再改本文件。**

## 最小骨架（够你起步，不用翻真源）

| 项 | 值 |
|---|---|
| MCP（agent 用） | `http://127.0.0.1:3466/mcp`，工具前缀 `mh_` |
| Web 控制台（人看） | `http://127.0.0.1:3467` |
| 查询顺序 | `mh_tools_list` → `mh_tool(name=…)` → `mh_service` / `mh_search(query, top_k)` → 都不行才 `mh_ask(query)` |
| 写回 | `mh_write(content=…, source=<自己的 agent 名>)` |
| 报条数 | 只报**有效**数（`superseded_by is null`） |

⚠️ 地址一律写 `127.0.0.1`，**禁止 `localhost`** —— Windows 先解析 IPv6 `::1`，而服务只监听 IPv4，白等 2 秒。

## 三条铁律

1. 干活**前**先查 openmem（别自己猜），干完把值得留的**写回** openmem。**不写回 = 任务没完成。**
2. openmem 是**唯一**记忆工具。`agentmemory`（:3111/:3114）与 `wiki`（:3456）**已于 2026-09-12 整体下线删除**；旧工具（`wiki_recall` / `memory_recall` / `memory_smart_search` / `memory_lesson_save` …）**全不存在，别再调用**。
3. 写入 `source` **必填** = 你自己的 agent 名；人设/记忆文件只写「规矩 + 路标」，**会漂的硬事实（IP/端口/服务名单/token）只进 openmem**。

## 两条额外提醒

- 台账类内容（`source=agent-matrix/services`）默认被排除，要查需显式指定 source。
- **openmem 自己的记录也要当场验证再用**（曾把测试期已删的组件记成"已装"）；改完环境要回头刷条目 + 刷成品答案缓存。
