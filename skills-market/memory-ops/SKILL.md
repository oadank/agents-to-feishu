# 技能：openmem 统一记忆中枢运维

当涉及 openmem 记忆读写、经验沉淀、项目知识检索时使用本技能。

> ⚠️ 2026-09-12 起，**记忆只认 openmem**。agentmemory(:3114) 与 wiki(:3456) 已整体下线删除，内容已全量并入 openmem；旧的 `memory_recall` / `wiki_query` 等工具**不复存在**，别再调用。

## 读写姿势

- openmem MCP：`http://127.0.0.1:3466/mcp`（工具前缀 `mh_*`）
- Web 控制台：`http://127.0.0.1:3467`
- **任务前**：查 openmem + bot-memory.md + 技能库
- **任务后**：把值得留的事实 / 结论 / 坑**写回 openmem**

## 常见操作

| 目标 | 工具 |
|---|---|
| 语义检索历史经验 | `mh_search(query="...", top_k=N)` |
| 预设秒回（主人偏好、服务端口等常用答案） | `mh_tool(name="...")`，先 `mh_tools_list` 看有哪些 |
| 拿不准就问别的 AI | `mh_ask(query="...", agent="<自己>")`（约 10s） |
| 按服务名查台账 | `mh_service(name="...")` |
| 看库状态 | `mh_status` |
| 读单条 | `mh_get(id="...")` |
| **沉淀经验 / 结论** | `mh_write(content="...", source="<自己的 agent 名>")` |

## 铁律

- **写回必须带 `source`**（= 自己的 agent 名，小写连字符），不带等于没写。
- **报条数只报有效数**（`superseded_by is null`），别报全表行数。
- 摸清的经验立即沉淀，减少重复摸索烧 token；同类任务先查速查表再动手。
- ⚠️ **openmem 自己的记录也要当场验证再用**（曾把测试期已删的组件记成"已装"；改完环境记得回头刷新条目）。

## 查询建议

- 台账类内容（`source=agent-matrix/services`）默认被排除，要查需显式指定 source。
- 核心知识（pinned）会过期；刚改完环境（端口 / 服务增减）要同步刷新对应条目 + 预设答案缓存。
