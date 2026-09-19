---
name: lark-ops
description: 飞书消息机制：@ 格式、发送通道、身份铁律、通讯录、常见坑。涉及飞书发消息/@/私聊/群聊时使用。（自 dsh-ops 私产收编 2026-09-19）
---

# 飞书机制速查（2026-09-17 全量校正：通道已换成服务注入的原生 `lark_*` 工具）

> 🔴 **本技能旧版整篇作废**。以下写法实测已死，**任何情况下不要再执行**：
> `POST http://127.0.0.1:135xx/api/send`（13578-13589 全部无监听，端点随 agents-to-im 一起下线）、
> `lark-cli im +messages-send` / `lark-cli im images create` / `lark-cli --as user`、
> `node C:\D\opt\agents-to-im\scripts\send-feishu.cjs`（**目录和脚本都不存在**）、
> `send-feishu-voice.ps1`（语音现由桥接层自动合成）、以及任何手写脚本 / curl 直调飞书开放 API。
> 项目真名已是 `agents-to-feishu`（源码 `C:\D\opt\agents-to-feishu\`）。

## 工具清单（参数名照抄）
`lark_list_chats()` · `lark_send_text(receive_id, receive_id_type, text)` · `lark_send_image(chat_id, path)` ·
`lark_send_post(...)` · `lark_send_as_user(to, text)` · `lark_chat_members(chat_id)` · `lark_bot_directory()` ·
`lark_create_doc` / `lark_get_doc_text` · `lark_chat_history(chat_id)`

## 发消息身份铁律（判断骨架与旧版一致，执行层换了）
- 给**用户 / 群里展示**（回复、发图、汇报）→ **自己 bot 身份**：`lark_send_text` / `lark_send_image` / `lark_send_post`，**无需 [前缀]**，飞书自动显示你的 bot 名。
- 给**其他 bot**（派活、委托、传话）→ **user 身份**：`lark_send_as_user(to="<对方agentId>", text="[你的身份名] …")`。`to` 直接填 agentId，**系统自动定位与该 bot 的私聊，不用手工找任何 id**。原因不变：桥接对 `sender_type=app` 直接 return，bot 身份发的消息其他 bot 收不到。
- **收到别的 bot 派来的活 → 直接正常文字回复**，桥接会自动转达发起方。**再手工调 `lark_send_as_user` 回执 = 对方收到两条重复消息**（错误）。
- 发消息前自问一句：**这条给谁看？**（人 → bot 身份；bot → user 身份）

## @ 人
- **群消息 @ 人 / @ bot**：先 `lark_chat_members(chat_id)` 查 id，再用 **`lark_send_as_user`** 群发（bot 身份发消息无法正确 @ 其他 bot）。
- **富文本 @**：`lark_send_post` 正文里写 `<at user_id="<查到的 id>"></at>`。text 类消息不支持 @（`<at>` 会被当纯文本显示）。post 结构里 at 元素**必须带 user_name**，@ 与正文各占一行。
- 别只在文本里写 "@某某"，要真正 @ 到人。

## 通讯录（团队群 chat_id：`oc_b598b5209ec736d96c53e4b5b3cad491`）
- 🔴 **禁止背 open_id**：open_id 按 **app 视角隔离**，拿别的 app 视角查到的 id 去 `lark_send_text(receive_id_type="open_id")` → 直接报 `99992361 open_id cross app`（2026-09-12 实测）。旧技能里那张 9 bot open_id + app_id 表已整体撤下，别再抄回去。
- 现行取 id 姿势：`lark_bot_directory()` 拿全部 bot 的 open_id 与各家视角 p2p chat_id；`lark_list_chats()` 拿自己所在会话的 chat_id（**chat_id 全局唯一，不受 app 视角影响**）；要 @ 群成员用 `lark_chat_members(chat_id)`。
- 给用户（陈丹）发：① **回复当前对话是自动的**（桥接层发，不用调工具）；② 主动发要用**你自己视角**的 open_id（只能从收到的消息事件里拿），或干脆 `lark_send_as_user`。
- ⚠️ appId `cli_aad3d4bbaaf8dbb3`（"陈丹的飞书 CLI"机器人）的私聊**已接入 DeepTutor** —— 发它 = 给 DeepTutor 留言，不是团队智能体。只发到：团队群 / 用户真实私聊 / 其他 bot 的私聊。

## 常见坑
- **人设 / 注入改了不生效**：`lark_*` 注入文本来自配置中心 `config-store.json → injection.global`，渲染进 `config.<bot>.env` 的 `CTI_SYSTEM_PROMPT_GLOBAL`，bot 进程**启动时**读 → 改完要 `nssm restart <bot短名>`，且会话要 `/new` 重建才吃到新人设（见 `dsh-ops-pm2-nssm` 与 openmem 的 `be861a5c`）。
- **/new 命令**：私聊发 `/new`（不带 bot 名字）让 bot 重建会话；`/new:claude` 这种写法无效。
- **botOpenId 命名空间**（机制仍成立，历史背景）：`/open-apis/bot/v3/info` 返回的 open_id 与群 mentions 事件里的 open_id 不同命名空间，不匹配会导致群 @ 永远收不到；当年靠 env `CTI_BOT_<NAME>_BOT_OPEN_ID=<user 视角 open_id>` 修正（现由配置中心渲染，别再手改旧 ecosystem）。
- **看历史消息**：用 `lark_chat_history(chat_id)`，不要再用 lark-cli 拉。
- **语音**：桥接层**自动收发**。用户发语音 / 要求语音 → 你正常文字回答，并在正文之外另起一段写 `【语音】口语内容` 供合成；**禁止再手动跑任何 TTS 脚本**（手动发 = 重复回复 = 错误）。
- **中文**：工具参数直接传字符串（内部 UTF-8），不需要再绕 python/node。
- 发送后确认成功即结束，**不要重复发**；任务做完一定回复当前对话（失败也报原因），不要沉默。
