---
name: lark-ops
description: 飞书消息/群/身份操作规范：bot 与 user 身份铁律、lark-cli 命令速查、open_id 隔离
---

# 技能：飞书操作规范（lark-ops）

发消息、查群、@人、跨 bot 传话前先读本技能，防身份错位与报错循环。

## 身份铁律（选错=对方永远收不到）

| 场景 | 用什么 | 身份 |
|---|---|---|
| 回复当前对话 | 不用工具，桥接自动 | bot |
| 主动给用户/群展示 | `lark_send_text/image/post` | bot |
| 给其他 bot 派活/传话 | `lark_send_as_user(to=<对方agentId>)` | **user**（bot 身份发→对方 inbound-handler 直接吞掉） |
| 群里 @ 人/@ bot | `lark_chat_members` 查 id → `lark_send_as_user` | user（bot 身份无法正确 @ 其他 bot） |

## lark-cli 命令速查

- 读聊天记录：`lark-cli im +chat-messages-list --chat-id <id> --as user --order desc --page-size 10`（🔴 没有 `+messages-list` 这个子命令）
- 发消息：`lark-cli im +messages-send --chat-id <id> --text "..." --as user --idempotency-key <唯一key>`
- 列私聊：`lark-cli im +chat-list --types=p2p --page-size=100 --as user`（必须翻全页）
- 查群成员：`lark-cli im +chat-members-list --chat-id <id> --as user`

## 隔离与红线

- `open_id` 每个 app 视角隔离：拿别家视角 id 直发必报 `99992361 open_id cross app`。**现查不硬编码**：用自己视角 `lark_list_chats`。
- 群 `chat_id` 全局唯一，是 bot 间互通主通道。
- lark-cli 前先过 api-gate：`openmem mh_tool(name="飞书操作规范")`。
- 已作废再见即错：`POST /api/send`（agents-to-im 时代端点）、手写 Python 直调 open API、人设里存 app_secret 明文。

## 报错对照

| 报错 | 修法 |
|---|---|
| `unknown subcommand` | 子命令名抄错，读记录用 `+chat-messages-list` |
| `99992361 open_id cross app` | 换自己视角现查 chat_id/open_id |
| `230072` | 流式更新只能走卡片，text 有编辑次数上限 |
| SDK 返回 code=0 但没生效 | 假成功，卡片更新走 `PATCH /im/v1/messages/{id}` HTTP 直调 |
