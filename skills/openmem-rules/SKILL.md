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
