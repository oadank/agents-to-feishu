# 技能：AgentMemory / Wiki 知识库运维

当涉及 AgentMemory MCP、Wiki 知识库读写、记忆沉淀、经验持久化时使用本技能。

## 读写姿势

- AgentMemory：http://127.0.0.1:3114（MCP agentmemory:*）
- Wiki：http://127.0.0.1:3456（MCP wiki:*）
- 任务前：查 bot-memory.md + agentmemory + 技能库；完成后：append 值得留的事实

## 常见操作

| 目标 | 工具 |
|---|---|
| 存经验 | memory_lesson_save / memory_save |
| 查旧经验 | memory_recall / wiki_query |
| 项目进度 | wiki_get_progress / wiki_update_progress |
| 共享记忆 | wiki_remember |

## 铁律

- 摸清的经验必须立即存 bot-memory + agentmemory，减少重复摸索烧 token
- 同类任务先查速查表再动手
