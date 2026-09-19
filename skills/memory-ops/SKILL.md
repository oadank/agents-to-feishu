---
name: memory-ops
description: dsh 的记忆与知识管理机制：openmem 唯一记忆工具（mh_* 工具）、知识循环、写入姿势、记忆 vs 人设分层、常见坑。涉及写记忆/搜经验/沉淀知识时使用。（自 dsh-ops 私产收编 2026-09-19）
---

# openmem —— 路标（真源就是本文件）

> ⚠️ 本文件是 agent 自动加载的**唯一**说明。**没有第二份手册**（MANUAL.md 已于 2026-09-18 删除：
> 能塞进技能文件的塞进来，塞不进的一律不留）。
> 要改这条知识 → **只改本文件**，三份副本同步：`~/.dsh/skills/dsh-ops-memory`、
> `~/.workbuddy/skills/openmem-memory`、`agents-to-feishu/skills-market/memory-ops`。

## 最小骨架（够你起步）

| 项 | 值 |
|---|---|
| MCP（agent 用） | `http://127.0.0.1:3466/mcp`，工具前缀 `mh_` |
| Web 控制台（人看） | `http://127.0.0.1:3467` |
| 查询顺序 | `mh_tools_list` → `mh_tool(name=…)` → `mh_service` / `mh_search(query, top_k)` → 都不行才 `mh_ask(query)` |
| 写回 | `mh_write(content=…, source=<自己的 agent 名>)` |
| 改已有条目 | `mh_update(id=…)` —— **保留 id**，别删了重写；整条作废才直接删 |
| 🔴 **写入前** | `mh_write` 有**服务端闸门**（三道 / 无豁免；被拦别猜别绕 —— 返回体里直接给过法，照做就过）：① 手上没票 → `mh_skill(agent="<你的名字>")`；② 最近没搜过库 → `mh_search(…, requester="<你的名字>")`；③ 与已有条目太像 → 改用 `mh_update`。**票管一条，写成功即作废** |
| 报条数 | 只报**有效**数（`superseded_by is null`） |

⚠️ 地址一律 `127.0.0.1`，**禁 `localhost`** —— Windows 先解析 IPv6 `::1`，而服务只监听 IPv4，白等。

## 三条铁律

1. 干活**前**先查 openmem（别猜），干完把值得留的**写回**。**不写回 = 任务没完成。**
   **写 = 维护**（你是共建者，不是过客）：先 `mh_search` 查重 → 同主题用 `mh_update` 合并 → 错的直接删。
2. openmem 是**唯一**记忆工具。`agentmemory`（:3111/:3114）与 `wiki`（:3456）**已于 2026-09-12 整体下线删除**；旧工具（`wiki_recall` / `memory_recall` / `memory_smart_search` / `memory_lesson_save` …）**全不存在，别再调用**。
3. 写入 `source` **必填** = 你自己的 agent 名；人设/记忆文件只写「规矩 + 路标」，**会漂的硬事实（IP/端口/服务名单/token）只进 openmem**。

## 代码类知识：只存路标，不存代码

```
[文件] C:\D\opt\agents-to-feishu\src\config\render.ts:530
[符号] syncModelToCli(botId, model) : void
[作用] 一键切模型时把 model 写进该 bot 的 CLI 配置
[坑]   必须无条件调用，早期加了 if 判断 → dsh/deeptutor 不生效
```
🔴 `[文件]` / `[符号]` **必须原样照抄** —— 它们是检索钥匙，翻译成「那个切模型的函数」就永远搜不到。
一条卡片一件事。**检索只负责定位，代码永远现读。**

## 写之前记住这几条（全都踩过）

| 坑 | 对策 |
|---|---|
| `mh_search` 传 `limit` | 参数是 **`top_k`**，传错报 `-32602` |
| 改了条目不刷成品答案 | **= 白改**（`mh_tool` 是另一套预生成缓存） |
| 条目超 ~500 字 | embedding 截断，**后半截永远搜不到** |
| 符号类查询写大白话 | 符号**原样**写进 query（`syncModelToCli` / `18800`） |
| 拿 `curl GET /mcp` 探活 | 会挂死 3 分钟 —— 探活用 `sc query openmem` |
| Git Bash 的 `curl` 发中文 | GBK 乱码 —— 测中文用 Python `requests` |
| MCP 响应乱码 | 显式 `r.content.decode('utf-8')`，别用 `r.text` |
| 直连 PG 查 uuid 列表 | 要写 `::uuid[]` 转型，否则 `uuid = text` 不存在 |

## dsh 侧说明

- `~/.dsh/bot-memory.md` 现在**只是铁律 + 路标**（2026-09-12 从 826 行 / 132KB 瘦到 47 行），**不再是知识库**，别再往里堆细节。
- DSH 平台机制 / 语音链路 / ComfyUI / 米家 / Session 1 桌面控制等细节已提炼进 openmem，用 `mh_search` 查。
- `persona`（`~/.dsh/global-persona.md`）仍是每次会话注入的常驻认知；记忆 vs 人设的分层原则用 `mh_search("记忆 vs 人设 分层")` 查条目。
