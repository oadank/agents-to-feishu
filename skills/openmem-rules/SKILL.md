---
name: openmem-rules
description: openmem 记忆中枢使用规矩：闸门票制、查重、更新与删除、成品答案优先
---

# 技能：openmem 记忆规矩（openmem-rules）

读写 openmem（本机 MCP :3466）前先读本技能。

## 读：成品答案优先

- 标准问题（老大偏好/铁律/环境/服务端口/bot 花名册）先 `mh_tools_list` → `mh_tool(name=...)`（秒回，别现搜）。
- 要原始记忆片段/历史事件用 `mh_search`；要理解+综合用 `mh_ask`（慢，慎用）。
- nssm 服务台账默认不返回，查服务启动参数用 `mh_service` 或 `mh_search(source="agent-matrix")`。

## 生图素材：提示词库（先抽词再生图）

- **生图任务先查提示词库**，别自己硬编 prompt：
  - `mh_pr_random` → 随机抽一条完整人像/场景提示词（整段返回，直接可用）；可选 `{file:"sfw_portrait_v3"}` 限定词库。
  - `mh_pr_search({query:"场景描述", kind:"wildcards"})` → 按语义定向搜（如"水池边美女""雪地黑大衣"），返回最贴的整段提示词。
- 拿到词后自己加工（加人名触发词/风格/构图），再送生图（8090 `/generate` 或 generate_image 工具）。
- 这些工具与经验记忆隔离：`mh_search` 搜不到词库内容，必须用 `mh_pr_*` 前缀工具。

## 故障自救：MCP 报 "Session not found"（-32001）

- 现象：`mh_*` 调用报 `Error POSTing to endpoint: ... Session not found`（code -32001）。
- 根因：openmem（MCP :3466）重启过，本进程缓存的 Mcp-Session-Id 已失效；**streamable-http 的 session 是进程级缓存，新开对话不会重建连接**，自己重试多少次都没用。
- 正确自救：**立即停手报告**「openmem 刚重启过，MCP session 失效，需要重启本服务重新握手」——**禁止退化去网页搜索/绕路硬干/拿 HTTP 直查凑合交差**（10-01 dsh-web 因此被老大点名）。
- 预防铁律：**谁重启 openmem，谁负责通知重启依赖它的长驻进程**（dsh-web、12 bot 桥），否则全体 bot 的 mh_* 静默失效。

## 写：三道闸门（一票一条）

1. **领票**：`mh_skill(agent="WorkBuddy")`——一次只放行一条，写成功票即作废，下次再领。
2. **查重**：写入前 30 分钟内 `mh_search(requester="WorkBuddy")` 查同主题。
3. **去重**：相似度 ≥0.95 用 `mh_update(id=...)` 原地改，**不新增**；同主题只维护一条活条目，状态变了就 update。

## 删除

- MCP 无 delete，走 Web API：`curl -X DELETE "http://127.0.0.1:3467/api/entry?id=<uuid>"`。
- 写错的条目直接删，不搞 superseded_by 归档。

## 内容纪律

- 长内容/细节/长表一律写 openmem，对话里的铁律骨架另存用户记忆文件。
- 记忆循环：干活前先查，收工把要记的写回（source=WorkBuddy）；不写回=任务没完成。
- 真实家人信息与小说化名严格分离；chat_id/凭据不入 openmem。
