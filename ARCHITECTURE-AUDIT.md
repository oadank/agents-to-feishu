# 架构图审核报告

审核对象：`ARCHITECTURE-MAP.json`（version 1.0.0-draft）
审核方式：独立取证，不采信图中任何既有结论（含注释里的行号、"已核实"字样）
审核日期：2026-08-29
纪律：只审不改，未修改 `ARCHITECTURE-MAP.json` 与任何源码

---

## 结论摘要

| 项 | 数量 | 核实结果 |
|---|---|---|
| stages | 10 | 与代码阶段划分一致，无误 |
| nodes | 60 | 50 个带行号节点全部逐段打开核对；10 个 `lines:"-"` 节点（外部/模块级）核对文件存在性 |
| edges | 79 | 全部核对 `from`/`to` 节点 id 有效（0 个无效 id）；逐条回源码找证据 |
| flow | 1 条 / 21 个条目 / 20 段跳转 | **2 段跳转在 edges 中不存在（闭环断裂）** |
| diagnostics | 16 | 16 条引用的 node id 全部存在；**3 条步骤/结论有误** |
| 涉及文件 | 23 个 `file` 字段 | **23/23 全部真实存在（0 个路径错误）** |

- **CRITICAL：2 条**（均为行号偏差，无文件路径错误）
- **MAJOR：13 条**
- **MINOR：11 条**
- 无法证实：5 条

**一句话总体判断**：这是一份骨架扎实、行号整体可信度相当高的图 —— 23 个文件路径零错误、66 段行号里只有 2 段偏了 1~4 行、config-center 那批精确到个位的大行号（server.ts:60/112/322/412/438/630/693/736/769/780/998/1281、store.ts:341/377、render.ts:74/154/389、runtime.ts:52/104/348）**全部逐条命中，已核实无误**；但它在**机制性叙述**上失手了：Provider 三模型的"归零原理"两处写错、重试次数/退避写错、闭环 flow 断 2 处、流式降级指错了函数、6 个 in-process provider 各自的看门狗整块漏掉 —— 这些恰恰是"接手的人靠它排障"时最容易照着做错的部分。

---

## CRITICAL（行号或文件路径错误 —— 必须改）

> 文件路径：23/23 全部存在，**0 个路径错误**。以下 2 条为行号偏差，落点仍在目标函数/类内（不会把人带跑偏），但按"行号错一个即废"的标准必须改。

### C1 ｜ `n_comfy` ｜ 声称 `src/comfy/mcp-server.ts:147` ｜ 实际 147 是 handler 的 `return` 语句 ｜ 应为 **146**
- 声称：`"lines": "147"`，role 描述的对象是 `createComfyMcpHttpHandler`。
- 实际：`src/comfy/mcp-server.ts:146` 才是 `export function createComfyMcpHttpHandler() {`；147 行是 `  return async function comfyMcpHandler(req, res) {`。
- 取证：`src/comfy/mcp-server.ts:146`（grep 精确命中 `146:export function createComfyMcpHttpHandler() {`）。

### C2 ｜ `n_client` ｜ 声称 `src/feishu/client.ts:17` ｜ 实际 17 是 constructor，类声明在 13 ｜ 应为 **13**
- 声称：kind `class`，name `FeishuClient`，`lines: "17"`。
- 实际：`src/feishu/client.ts:13` 是 `export class FeishuClient {`；17 行是 `constructor(opts: FeishuClientOptions) {`。
- 取证：`src/feishu/client.ts:13`、`src/feishu/client.ts:17`。

---

## MAJOR（边不成立 / 职责描述与代码不符 / 诊断步骤有误）

### M1 ｜ 闭环 flow 有两段跳转在 edges 里根本不存在（闭环验证失败）
- 声称：`flow` 是"端到端闭合主流程"，数组 21 项。
- 实际：程序化校验 `flow[i] → flow[i+1]` 是否命中 edges，命中率 18/20，断裂 2 处：
  - **`n_stream → n_claude` 不存在**：edges 里只有 `n_stream → n_iface`（types.ts:80 接口）和 `n_iface → n_claude`（实现）。也就是说 flow 声称"接口直接跳到 claude"，但图上画的边是走 `n_iface` 中转。
  - **`n_element → n_render` 不存在**：edges 里 `n_element` 只有 `n_element → n_client` 与 `n_element → n_degrade`。而代码里真实关系是**反的**：`render()`（`src/bridge/engine.ts:525`）内部调用 `updateCardElement`（`src/bridge/engine.ts:528`），是 render 包含 element，不是 element 流向 render。
- 取证：`src/bridge/engine.ts:525`（`const render = async (markdown, isFinal = false)`）、`src/bridge/engine.ts:528`（`await this.opts.feishu.updateCardElement(...)` 在 render 体内）。
- 建议改为：flow 中 `n_stream` 与 `n_claude` 之间插入 `n_iface`；或补一条 `n_stream → n_claude` 的 `calls` 边（但那样会与 `n_iface` 的"实现"语义重复，推荐前者）。`n_element → n_render` 应改为 **`n_render → n_element`（`calls`）**，并把 flow 里 `n_settings → n_element → n_render` 调整为 `n_settings → n_render → n_element` 或直接让 flow 走 `n_render → n_element → n_final`。

### M2 ｜ `n_degrade` 指错了函数：client.ts:141 不是"整卡 PATCH 降级"，那是 cardkit 整卡 body 更新
- 声称：`n_degrade` = `src/feishu/client.ts:141`，role "增量更新失败（如 300309）时降级为整卡 PATCH，保证内容不丢"。
- 实际：
  - `client.ts:141` 是 `async updateCardBody(cardId, card, sequence)`，走的是 **cardkit.v1.card.update**（更新卡片实体 body），**不是** HTTP PATCH 消息。
  - 它在 engine 里**只有一处调用**：`src/bridge/engine.ts:649`，用途是**终态后刷新状态分割线**（更新 session/上下文/余额等可变字段），与降级无关，且失败只 `console.warn` 不影响主回复。
  - 真正的降级在 `src/bridge/engine.ts:538-542`：`updateCardElement` 返回 false → `cardId = null` → `buildSimpleCard(markdown, buildDivider())`（engine.ts:541）→ `updateCardHttp(messageId, card)`（engine.ts:542）→ 实现在 `src/feishu/client.ts:250`（HTTP PATCH `im/v1/messages/:id`）。
- 取证：`src/feishu/client.ts:141`、`src/feishu/client.ts:250`、`src/bridge/engine.ts:538-542`、`src/bridge/engine.ts:647-649`。
- 建议改为：`n_degrade` 的 file/lines 改为 `src/feishu/client.ts:250`（`updateCardHttp`，HTTP 整卡 PATCH），调用点注明 `engine.ts:541-542`；把 `updateCardBody`（client.ts:141）单列为终态状态行刷新，或并入 `n_render`/`n_final` 的 notes。

### M3 ｜ 诊断 `d_stream` 的排查步骤指向了错的函数（沿用 M2 的错误）
- 声称：`d_stream.check` = "…否则报 300309 并降级整卡 PATCH（engine.ts:528→client.ts:141）"。
- 实际：`engine.ts:528` 是 `updateCardElement` 调用点，它失败后走的是 `engine.ts:541-542 → client.ts:250`，不是 client.ts:141。
- 取证：同 M2。
- 建议改为："增量更新前必须先 `updateCardSettings` 开 streaming_mode（engine.ts:514）；否则报 300309，由 engine.ts:541-542 降级为 `buildSimpleCard` + `updateCardHttp`（client.ts:250）。终态另由 client.ts:534→141（`updateCardBody`）刷新状态行（engine.ts:649）。"

### M4 ｜ in-process 组"删 key 即归零"的机制是错的 —— 代码从不传 sessionKey
- 声称：`n_inproc.role` "单进程内按 sessionKey 存多 session；**删 key → 新 sessionId → 天然归零**"；`n_inproc.notes`、`d_new` 均沿用此说法。
- 实际：
  - 唯一调用点是 `src/index.ts:136`：`onSessionReset: async () => { await provider.resetSession(); }` —— **不传任何参数**。
  - 6 个 provider 的 `resetSession` 都是同一形状，以 `src/providers/dsh.ts:204-209` 为例：`if (sessionKey) { this.sessions.delete(sessionKey); ... }`。`sessionKey` 为 `undefined` ⇒ **一次 delete 都不会发生**，map 条目原样残留。
  - 真正让会话归零的是另一条链：`/new` → `SessionManager.reset`（`src/bridge/session.ts:93`）在 `src/bridge/session.ts:95` **生成全新 `session.id`** 并置 `pendingFresh = true`（session.ts:99）→ `consumeFresh`（session.ts:110）→ engine 传 `freshSession: fresh`（`src/bridge/engine.ts:575`）→ `streamChat` 用**新 sessionKey** 查 map 落空（dsh.ts:477）且 `params.freshSession` 为真（dsh.ts:495）→ `createSession` 新建（dsh.ts:502-503）。
  - 副作用：旧条目会一直留在 map 里，直到 `src/providers/dsh.ts:240-247` 的空闲回收（`IDLE_TIMEOUT_MS` 默认 30min，dsh.ts:176）或 `MAX_SESSIONS=20` 的 LRU 淘汰（dsh.ts:178、480-490）。
- 取证：`src/index.ts:136`、`src/providers/dsh.ts:204-209`、`src/providers/openclaw.ts:116-118`、`src/providers/opencode.ts:120-122`、`src/providers/reasonix.ts:120-122`、`src/providers/mimo.ts:121-123`、`src/providers/openakita.ts:127-129`、`src/bridge/session.ts:95`、`src/bridge/engine.ts:575`、`src/providers/dsh.ts:477/495/502`。
- 建议改为：role 改为"单进程内按 sessionKey 存多 session；归零靠 **bridge 层换新 session.id（session.ts:95）+ freshSession 标志** 使下次 streamChat 查不到旧绑定而新建 ACP session（dsh.ts:477/495/502）；`resetSession()` 因 index.ts:136 不传 key 而**不删 map 条目**，旧绑定靠空闲回收（dsh.ts:243，30min）或 LRU（上限 20，dsh.ts:178）清理"。

### M5 ｜ 诊断 `d_new` 的诊断结论照抄了 M4 的错误机制，会误导排障
- 声称：`d_new.check` = "其余 6 个（dsh/openclaw/opencode/reasonix/mimo/openakita）**删 sessionKey 即归零**"。
- 实际：见 M4，不存在"删 sessionKey"这一步。`/new` 后仍是旧对话时，应查的是 `session.id` 是否真的换（session.ts:95）以及 `freshSession` 是否透传（engine.ts:575），而不是查 map 有没有删。
- 取证：同 M4。
- 建议改为：按 M4 的机制重写；claude 分支（`claude.ts:242-257`：先 `dispose()` 再 `ensureProcess()`）的表述**经核实无误**，可保留。

### M6 ｜ app-server 组"每次请求新建 app-server 进程"是错的 —— 进程常驻，只有 session 每次新建
- 声称：`n_rt_app.role` "**每次请求新建 session 的 app-server 进程**"；edge `n_appsrv → n_rt_app` type `spawns` label "每次新建"。
- 实际：三个 provider 的 client 都是**缓存常驻**的，只在 `dispose()` 时才关：
  - `src/providers/gemini.ts:74-77`：`if (this.client) { await this.client.prepare(); return this.client; }`
  - `src/providers/codex.ts:26-29`：同样 `if (!this.client)` 才 new
  - `src/providers/hermes.ts:54-58`：`if (this.client) { await this.client.prepare(); return this.client; }`
  每次新建的只有 session/thread：`gemini.ts:126`（`session/new`）、`hermes.ts:101`（`session/new`）、`codex.ts:71`（`thread/start`）。
- 取证：`src/providers/gemini.ts:74-77`、`src/providers/codex.ts:26-29`、`src/providers/hermes.ts:54-58`、`src/providers/gemini.ts:126`、`src/providers/codex.ts:71`、`src/providers/hermes.ts:101`。
- 建议改为：`n_rt_app.role` → "常驻 app-server 子进程（client 缓存在 gemini.ts:74-77 / codex.ts:26-29，只有 dispose 才关）；**每次 streamChat 新建 session/thread**（gemini.ts:126 / hermes.ts:101 / codex.ts:71），故无跨轮上下文"。edge 的 `spawns`/label 改为 `uses` / "常驻进程，每轮新建 session"。

### M7 ｜ `n_appsrv` 的"天然归零（reset 是 no-op 也无妨）"结论对，但理由链里混入了 M6 的错误
- 声称：`n_appsrv.role` "每次 streamChat 都新建 session，无常驻上下文，天然归零（reset 是 no-op 也无妨）"。
- 实际：前半句对（`gemini.ts:126` 每次新建；`resetSession` 确实是 no-op，见 `gemini.ts:96-99`、`hermes.ts:71-74`、`codex.ts:42-44`，`hermes.ts:72` 注释也明写"每次 streamChat 都新建 session"）。错的是它经 `n_appsrv → n_rt_app` 把"新建 session"传递成了"新建进程"。
- 取证：`src/providers/gemini.ts:96-99`、`src/providers/hermes.ts:71-74`、`src/providers/codex.ts:42-44`、`src/providers/gemini.ts:126`。
- 建议改为：role 保留，但删除/更正与 `n_rt_app` 的 `spawns 每次新建` 边（见 M6）。

### M8 ｜ claude 重试："最多 3 次重试 + 退避 1/2/4s" 数值错误
- 声称：`n_retry.role` "瞬态错误自动重投 prompt，**退避 1/2/4s，最多 3 次**"；`d_502.check` 同；`d_half.check` "然后重试最多 3 次"。
- 实际：
  - `src/providers/claude.ts:44`：`MAX_RETRIES = Number(process.env.CTI_CLAUDE_MAX_RETRIES ?? 3)` —— 这是**总尝试次数 3**，重试次数 = 2（第 1 次是正常执行）。engine 侧提示文案也是 `自动重试中（${attempt}/${MAX_RETRIES}）`（claude.ts:352），即 attempt 1/3、2/3 会重试，3/3 放弃。
  - `src/providers/claude.ts:350`：`const delay = Math.min(1000 * 2 ** (attempt - 1), 8000); // 1s / 2s / 4s`，但重试条件是 `src/providers/claude.ts:349`：`if (retryable && attempt < MAX_RETRIES)` ⇒ attempt 只有 1 和 2 能重试 ⇒ 实际只会退避 **1000ms 和 2000ms**；**4s 分支永远走不到**（attempt=3 时不再重试，直接走 claude.ts:357-360 报错）。
- 取证：`src/providers/claude.ts:44`、`src/providers/claude.ts:305`、`src/providers/claude.ts:349-350`、`src/providers/claude.ts:357-360`。
- 建议改为：role/diagnostics 统一改成"**共 3 次尝试（即最多 2 次重试），实际退避为 1s、2s；claude.ts:350 的 4s 分支因 `attempt < MAX_RETRIES`（claude.ts:349）不可达**"。

### M9 ｜ `n_parse` 职责写错了：parseContent 根本不解析 post
- 声称：`n_parse.role` "把飞书 content JSON 解析成纯文本（**text / post 等类型**）"。
- 实际：`src/index.ts:372-383` 的 `parseContent` 只对 `msgType === 'text'` 做 `JSON.parse(content).text`；其余一律返回空串，源码注释 `src/index.ts:381` 明写"其他类型（image/audio/post）**暂不解析，返回空**"。post 富文本消息在图里被算作已支持，实际会被 `src/index.ts:297`（`if (!text) return;`）静默丢弃。
- 取证：`src/index.ts:374-380`（text 分支）、`src/index.ts:381-382`（其他类型返回空）、`src/index.ts:297`。
- 建议改为：role 改为"只解析 `text` 类型（`{text}` JSON）；post/image/audio 返回空串，会被引擎 index.ts:297 静默丢弃 —— 收到富文本消息没反应时查这里"。

### M10 ｜ 边 `n_incoming → n_vision` 与 `n_img → n_vision` 无代码证据（lookImage 在 index.ts 是未使用的 import）
- 声称：edge `n_incoming → n_vision`（label "lookImage（index.ts:26）"）、edge `n_img → n_vision`（label "agent 看图"），以及 `n_vision.role` "被 index.ts:26 引入"。
- 实际：`grep -n "lookImage" src/index.ts` 全文件**只有 1 处命中** —— `src/index.ts:26` 的 `import { lookImage } from './vision/look.js';`，**没有任何调用点**。桥接层只把图片本地路径拼进文本（`src/index.ts:292`），看图动作不在 index.ts 里发生。
- 真正的看图路径是：配置中心挂 `/mcp/vision`（`src/config-center/server.ts:38` import、`src/config-center/server.ts:327` 路由），handler 由 `src/vision/mcp.ts:72` 的 `createVisionMcpHttpHandler` 提供，暴露 `look_image` 工具给 agent 自己调；`lookImage` 在配置中心侧的调用点是 `src/config-center/server.ts:769`（`/api/vision/test` 测试接口）。
- 取证：`src/index.ts:26`、`src/index.ts:292`、`src/config-center/server.ts:38`、`src/config-center/server.ts:327`、`src/vision/mcp.ts:72`、`src/config-center/server.ts:769`。
- 建议改为：删除 `n_incoming → n_vision`；把 `n_img → n_vision` 改为 `n_img` --(文本里带本地路径)--> 由 agent 经 `n_cfgcenter` 的 `/mcp/vision` 看图，即新增边 `n_cfgcenter → n_vision`（`mounts`，server.ts:38/327）并保留现有 `n_cfgcenter → n_vision`（`uses`，server.ts:34/769）。同时在 `n_vision.notes` 里标注"index.ts:26 是**未使用的 import**（死引用）"，与 `d_dead` 的排查方法呼应。

### M11 ｜ 诊断 `d_img` 的收尾一句把人指向了一条不存在的桥接层路径
- 声称：`d_img.check` "…看图走 **vision/look.ts:92 的 lookImage**"。
- 实际：`src/vision/look.ts:92` 的 `lookImage` 确实是入口函数（**行号无误**），但**桥接进程从不调用它**（见 M10）。用户发图后"agent 看图"是通过 MCP `/mcp/vision` 完成的。
- 取证：`src/vision/look.ts:92`、`src/index.ts:26`（仅 import）、`src/config-center/server.ts:327`、`src/vision/mcp.ts:72`。
- 建议改为："…看图由 agent 自己调用 `/mcp/vision`（server.ts:327 挂载，vision/mcp.ts:72 handler，底层 look.ts:92 的 lookImage）；桥接进程不调用 lookImage（index.ts:26 为未使用 import）。排查看图失败请查配置中心 `/api/vision/test`（server.ts:769）与视觉配置 `/api/vision`（server.ts:736）。"

### M12 ｜ `n_stall` 只看 claude，漏掉 6 个 in-process provider 各自的 300s 看门狗；`d_half` 对 9 个非 claude bot 完全不适用
- 声称：`n_stall.role` "超过 STALL_MS 没收到任何事件就判定流卡死，触发重试/放弃。默认 300s…这是「说一半没消息」的正解所在"；`d_half.check` 只讲 claude 的 `CTI_CLAUDE_STALL_MS` 与重试。
- 实际：除 claude 外，**6 个 in-process provider 各自实现了同型看门狗**，且行为不同（**不重试，直接以错误结束本轮**）：
  - `src/providers/dsh.ts:179`（`CTI_DSH_TIMEOUT_MS`，默认 300000）→ `src/providers/dsh.ts:603-605`：`onDone('DSH ACP 卡死：连续 300s 无输出，已中断')`
  - `src/providers/mimo.ts:99` / `:392-394`（`CTI_MIMO_TIMEOUT_MS`）
  - `src/providers/openakita.ts:105` / `:398-400`（`CTI_OPENAKITA_TIMEOUT_MS`）
  - `src/providers/openclaw.ts:93` / `:387-389`（`CTI_OPENCLAW_TIMEOUT_MS`）
  - `src/providers/opencode.ts:98` / `:391-393`（`CTI_OPENCODE_TIMEOUT_MS`）
  - `src/providers/reasonix.ts:98` / `:391-393`（`CTI_REASONIX_TIMEOUT_MS`）
  而 gemini/hermes/codex 侧未发现同类超时（grep `TIMEOUT_MS|STALL` 在三者中 0 命中）。
- 取证：上述各行；另 `src/providers/claude.ts:45`（claude 的 `CTI_CLAUDE_STALL_MS ?? 300_000`，**此项图上是正确的**）。
- 建议改为：`n_stall` 拆成两条（或 notes 补两组环境变量）：「claude 空闲看门狗 = CTI_CLAUDE_STALL_MS（claude.ts:45，默认 300s，**会重试**）」与「in-process 组看门狗 = CTI_DSH/MIMO/OPENAKITA/OPENCLAW/OPENCODE/REASONIX_TIMEOUT_MS（各默认 300s，**不重试，直接 onDone 报错**）」；`d_half` 的诊断分支里必须写清"先看 bot 的 runtime 是哪一个：claude 走 CTI_CLAUDE_STALL_MS 且重试；dsh 等 6 个走各自的 CTI_*_TIMEOUT_MS 且不重试；gemini/hermes/codex 无看门狗"。

### M13 ｜ 边 `n_event → n_settings`（"先开流式"）因果与时序都反了
- 声称：edge `n_event → n_settings` type `writes` label "先开流式"；flow 里也排在 `n_rt_claude → n_event → n_settings`。
- 实际：`updateCardSettings(..., true)`（开流式）发生在 `src/bridge/engine.ts:512-521`，**在 `for await (const ev of provider.streamChat(...))`（engine.ts:572）之前**，是建卡后的初始化动作，**不由任何 StreamEvent 触发**。事件驱动的只有 `updateCardElement`（engine.ts:528，在 render 内由 flush 定时器 engine.ts:557-560 触发）。图中"事件 → 开流式"会让排障的人在事件流里找开流式的时机，找不到的。
- 取证：`src/bridge/engine.ts:514`（`updateCardSettings(cardId, '', seq, true)`）、`src/bridge/engine.ts:572`（streamChat 开始）、`src/bridge/engine.ts:528`、`src/bridge/engine.ts:534`（终态关流式）。
- 建议改为：把该边改成 `n_final`/`n_handle → n_settings`（`calls`，"建卡后开流式，engine.ts:514；终态关闭 engine.ts:534"），或至少把 type 从 `writes` 改为 `calls` 并把 label 改为"建卡后开流式（事件流之前）"，同时从 flow 的 `n_event` 之后移出。

---

## MINOR（措辞、可选优化、遗漏建议）

1. **`n_errcard` 行号 `660` 建议改为 `659-665`**：`src/bridge/engine.ts:659` 才是 `} catch (e) {`，660 是 catch 体首行；真正渲染错误卡是 `src/bridge/engine.ts:662`（`render(buildErrorMarkdown(msg))`），兜底发文本是 `src/bridge/engine.ts:664`。

2. **`n_cfg_srv.notes` 的 "/api/comfy:1186" 不准确**：`src/config-center/server.ts:1186` 是 `/api/comfy/templates`；comfy 相关路由共 4 条 —— `server.ts:1186`（`/api/comfy/templates` GET）、`server.ts:1196`（`/api/comfy/generate` POST）、`server.ts:1215`（`/api/comfy/reverse_prompt` POST）、`server.ts:1231`（`/api/comfy/output/:name`）。不存在裸 `/api/comfy` 路由。

3. **`d_remote` 的 "index.ts:29-46" 有歧义**：项目里有两个 index.ts。此处指 `src/config-center/index.ts:29-46`（`resolveHost`）。建议写全路径，否则会被误读成 `src/index.ts`（那个文件总共 414 行，29-46 是 `resolveProvider` 区域）。

4. **三条边缺失（有明确调用证据）**：
   - `n_stop → n_sess`：`src/commands.ts:70` 先 `await sessions.interrupt(chatId)` 再 `engine.interruptProvider()`（`src/commands.ts:71`）。
   - `n_compact → n_sess`：`src/commands.ts:76`（`sessions.get`）+ `src/commands.ts:86-89`（改 `session.context` 并置 `pendingFresh`）。
   - `n_handle → n_tts`：`src/bridge/engine.ts:656-658` 在 handleText 内调 `sendVoiceReply`，比现有 `n_final → n_tts`（`optional`）更贴合代码。

5. **`/help` 与 `/new:default` 未上图**：`src/commands.ts:132`（`/help`）、`src/commands.ts:58`（`case '/new:default':`，与 `/new` 共用分支）。stage s3 现在只列了 6 条命令，实际 7 个 case（含 default 兜底 `src/commands.ts:138`）。

6. **`n_tts.role` 条件描述不完整**：TTS 触发是**双条件** —— `src/bridge/engine.ts:656`：`if (opts?.replyAudio && voiceText)`。即 ① 用户发语音或文本命中语音触发词（`src/index.ts:367` 的 `wantsVoiceReply`）② agent 回复里必须写了 `【语音】…` 口语块（`src/bridge/engine.ts:69` 提取、`engine.ts:77` 从正文剥离）。只写"需要语音回复时"会让人以为用户要求语音就一定有语音。

7. **`n_stats.role` "落盘与读取" 半错**：`src/bridge/stats.ts` 只负责**写**（`recordStats` `stats.ts:50`、`resolveStatsDir` `stats.ts:39`），"读"在 `src/bridge/engine.ts:83` 的 `readCacheStats` 与 `src/config-center/runtime.ts:52` 的 `readAgentStats`（读的是同一批 `~/.dsh/<bot>-bot/stats/YYYY-MM-DD.jsonl`）。建议改为"统一 usage 落盘（读取方：engine.ts:83 / runtime.ts:52）"。

8. **`n_settings → n_client` 与 `n_element → n_client` 的 label "HTTP 直调" 错误**：两者走的是 lark SDK —— `src/feishu/client.ts:126`（`sdk.cardkit.v1.card.settings`）、`src/feishu/client.ts:99`（`sdk.cardkit.v1.cardElement.content`）。真正用 HTTP 直调（自取 tenant_access_token + fetch）的是 `src/feishu/client.ts:178`（sendCardHttp）、`:218`（replyCardHttp）、`:250`（updateCardHttp）、`:198`（sendCardIdHttp）。建议 label 改为 "SDK 调用"，或把 `n_client.role` 拆出"HTTP 直调组 / SDK 组"。

9. **鉴权顺序值得在图上标一句（影响安全排查）**：`src/index.ts:300` 的白名单校验在 audio 分支（`src/index.ts:227-255`）和 image 分支（`src/index.ts:260-285`）**之后**，这两个分支会在鉴权前就下载资源并对未授权用户发提示后 return（`src/index.ts:254`、`src/index.ts:284`）。即未授权用户也能触发一次资源下载与 ASR 转写。

10. **配置落盘目录与读取目录的 env 不一致，是个潜在坑**：`render.ts` 写 `config.<id>.env` 用的是 `process.env.CTI_USER_HOME || 'C:\Users\oadan'` 拼接（`src/config-center/render.ts:430`），而 `loadConfig` 读的是 `env.CTI_HOME || USERPROFILE/HOME`（`src/config.ts:106`）。若部署时只设了 `CTI_HOME` 而没设 `CTI_USER_HOME`，会出现"配置中心说写成功了、bot 读的却是另一份"。建议在 `n_cfg_render`/`n_cfg` 的 notes 里点明。

11. **`n_render.notes` 的 25ms 与源码注释冲突（图是对的，源码注释陈旧）**：`FLUSH_INTERVAL_MS = 25`（`src/bridge/engine.ts:65`）确认图的"25ms 刷一次"正确；但 `src/bridge/engine.ts:8` 的文件头注释仍写"节流 PATCH（800ms 窗口合并）"。建议图上加一句"⚠ engine.ts:8 文件头注释的 800ms 已过期，实际常量是 engine.ts:65 的 25ms"，避免接手的人被源码注释带偏。

---

## 无法证实（需要人工确认的项）

1. **`n_cfgcenter.role` 的"独立 nssm 服务"**：端口默认值 13600 已核实（`src/config-center/index.ts:49`、`:52`，文件头用法注释 `src/config-center/index.ts:5` 亦为 `--port 13600`）。但**它是否真的以 nssm 服务注册、服务名是什么，全仓无脚本可证** —— `scripts/deploy-agents.ps1` 只创建 10 个 agent 服务（如 `scripts/deploy-agents.ps1:75-97`，跑 `node node_modules/tsx/dist/cli.mjs src/index.ts`，见 `scripts/deploy-agents.ps1:26-27`、`:92-93`），没有注册 config-center 的段落。需人工确认。

2. **`n_rt_claude.notes` 的"真实会话落盘 `~/.claude/projects/C--D-opt/<sessionId>.jsonl`"**：全仓 grep 无此路径，属 SDK/CLI 内部行为，源码不可证。代码里能确认的只有 `session_id` 由 SDK 的 `result` 事件带回（`src/providers/claude.ts:194`、`:211`）并作为 `usage` 事件的 `sessionId` 发往状态行（`src/bridge/engine.ts:609`）。同样，"命令行无 --resume/--continue" 已核实为**真** —— `query()` 的 options 只有 cwd / pathToClaudeCodeExecutable / permissionMode / allowDangerouslySkipPermissions / env（`src/providers/claude.ts:148-157`），无 resume 类参数。

3. **`d_half.check` 的"开 CTI_RT_LOG 看 claude-rt.log"**：`CTI_RT_LOG` 环境变量确实存在且被使用（`src/index.ts:43`、`src/providers/claude.ts:22`、`src/providers/dsh.ts` 内的 `rtLog`），但它只是"日志文件路径"变量，**文件名 `claude-rt.log` 是部署约定，源码里没有默认值**，需查 nssm 的 `AppEnvironmentExtra` 或部署记录。

4. **`d_stream.check` / `client.ts` 注释里的"日志累计 207 次 300309"、以及 `d_usage` 的"（2026-08-29 修过）"等历史性陈述**：属运行时/历史记录，源码不可证，需查日志与 git 历史。

5. **"配置中心无鉴权"**：在 `src/config-center/server.ts` 全 1300 行内 grep `authorization|bearer|requireAuth|token check|CTI_CONFIG_TOKEN` 仅 1 处命中（`src/config-center/server.ts:187`），且是**出站**调用外部 API 时带的 `Bearer` 头，非入站校验 —— 与图上"无鉴权"的说法一致。但我未逐行通读 1300 行的全部路由分支，故**结论倾向成立但需人工复核**。

---

## 遗漏检查（图里应该补但没补的模块/流程）

1. **构建与部署链路（最该补的一条）**：图上一个节点都没有，但生产行为完全取决于它。
   - `scripts/build.mjs:10-24`：esbuild 把 `src/index.ts` 打包成单文件 `dist/daemon.mjs`（`scripts/build.mjs:13`）。
   - `package.json:13`：`"start": "node dist/daemon.mjs"` —— 这条路径跑的是**打包产物**，改了 `src/` 不 `npm run build` 就不生效。
   - `scripts/deploy-agents.ps1:92-93`：nssm 服务的实际启动参数是 `node node_modules/tsx/dist/cli.mjs src/index.ts`，即**直接跑源码**（这条路径下改 src 只需重启），日志落在 `logs/<id>-out.log` / `logs/<id>-err.log`（`scripts/deploy-agents.ps1:82-83`）。
   - 两种部署方式并存，图上必须说明，否则 `d_stream` 的"改完必须重启 bot"和 `d_dead` 的"改了某文件没反应"都会给出不完整的处置。

2. **web/config-center 前端（约 30 个文件）**：`web/config-center/index.html` 及 10 组 `*-settings.html/.js`（agents / providers / runtimes / mcps / vision / voice / skill / inject / comfy / overview）。服务端在 `src/config-center/index.ts:55` 计算静态目录，`src/config-center/server.ts:333-361` 逐个页面提供（index / assets / voice-settings 等）。排查"配置页打不开/按钮点了没反应"时要跳到这里，图上一个节点都没有。

3. **6 个 in-process provider 的看门狗与 `CTI_*_TIMEOUT_MS` 系列**（见 M12）：`CTI_DSH_TIMEOUT_MS`、`CTI_MIMO_TIMEOUT_MS`、`CTI_OPENAKITA_TIMEOUT_MS`、`CTI_OPENCLAW_TIMEOUT_MS`、`CTI_OPENCODE_TIMEOUT_MS`、`CTI_REASONIX_TIMEOUT_MS`，各默认 300000ms。这是"说一半没消息"在 6 个 bot 上的真正答案，图里完全缺失。

4. **自动插队定时器与防误伤逻辑**（`n_busy` 只说了"弹插队卡"）：
   - `src/bridge/engine.ts:206-209`：`autoInterruptMs()`，环境变量 `CTI_AUTO_INTERRUPT_MS`，默认 10000ms。
   - `src/bridge/engine.ts:241-246`：10 秒未操作自动触发 `doAutoInterrupt`。
   - `src/bridge/engine.ts:298-303`：`shouldInterrupt()` 只在"旧任务仍活跃"时才真中断，避免误伤插队消息自己（对应 `❌ Claude 会话非正常结束` 这个具体症状）。
   - `src/bridge/engine.ts:176-188`：队列排空时清理插队卡标记与定时器（"更新后自动还原"的根因修复点）。

5. **in-process 会话的生命周期治理**：空闲回收定时器 `src/providers/dsh.ts:238-251`（`CTI_DSH_IDLE_TIMEOUT_MS`，默认 30min，dsh.ts:176）、LRU 上限 `src/providers/dsh.ts:178`（`CTI_DSH_MAX_SESSIONS`，默认 20）与淘汰逻辑 `src/providers/dsh.ts:480-490`。排查"会话莫名丢上下文/内存涨"要用到。

6. **用量 / 余额 / 状态行的异步预取链路**：`src/bridge/engine.ts:156-163`（`usageKind()` 按 baseURL 判定 ark / gw / deepseek）、`src/bridge/engine.ts:439-450`（后台预取不阻塞首屏）、`src/bridge/engine.ts:643-650`（终态后二次刷新状态行）、`src/config-center/runtime.ts:52/104/348`。现有 `n_cfg_rt` 只覆盖了"配置页展示"，没覆盖 bot 卡片状态行的这一半。

7. **语音回复的完整触发链**：`src/index.ts:367` `wantsVoiceReply`（正则触发词）、`src/bridge/engine.ts:69` `extractVoiceBlock` / `engine.ts:77` `stripVoiceBlock`、`:656` 双条件、`:684` `sendVoiceReply`（TTS→toOpus→uploadFile→sendAudio）。另有 `src/voice/edge-tts.ts` 这个 TTS 引擎文件图上未提及。

8. **stats 落盘目录规则**：`src/bridge/stats.ts:39-47` `resolveStatsDir()`（`DSH_HOME` / `CTI_BOT` / `CTI_DSH_ACP_CONFIG` 三级兜底）。`d_usage` 排查"命中率读不到"时几乎必查，图上只有 `n_stats` 一句"落盘与读取"。

9. **scripts/ 下的诊断与验证脚本（35 个）**：`scripts/diag-dsh.mjs`、`scripts/diag-codex.mjs`、`scripts/diag-reasonix.mjs`、`scripts/diag-dsh-events.mts`、`scripts/verify-all.mjs`、`scripts/smoke.mts`、`scripts/test-cardkit.mts`、`scripts/test-interrupt-guard.mts`、`scripts/feishu-verify.mjs`、`scripts/check-replies.mjs` 等。图里的 16 条 diagnostics 全部指向"读源码/看日志"，没有一个指向现成的诊断脚本 —— 这是排障效率上最大的一块空白。

10. **`skills/` 与 `skills-market/` 目录**：图上未提及，是否参与运行时链路需人工确认（未纳入本次取证范围）。

---

## 附：已核实无误的部分（明确说明查过了）

- **文件存在性：23/23 全部存在**（`src/index.ts` 414 行、`commands.ts` 141、`config.ts` 220、`bridge/engine.ts` 722、`bridge/session.ts` 179、`bridge/stats.ts` 87、`providers/types.ts` 90、`claude.ts` 367、`dsh.ts` 652、`gemini.ts` 275、`feishu/client.ts` 377、`feishu/cards.ts` 283、`voice/asr.ts` 191、`voice/tts.ts` 433、`vision/look.ts` 177、`comfy/mcp-server.ts` 169、`core/llm.ts` 206、`config-center/{index.ts 76, server.ts 1300, store.ts 407, render.ts 671, migrate.ts 107, runtime.ts 365}`）。
- **边 id 完整性：79 条边的 `from`/`to` 全部命中 60 个节点 id，0 个悬空引用**；除 `n_llm`（图上已声明为死代码、故意孤立）外无孤立节点。
- **flow 首尾闭合：首 `n_user`、尾 `n_user` 正确**（相邻断裂见 M1）。
- **16 条 diagnostics 引用的 node id 全部存在**（`d_noreply`…`d_dead`，共 38 次引用，0 个无效 id）。
- **6 个环境变量名全部真实存在**：`CTI_CLAUDE_STALL_MS`（claude.ts:45）、`CTI_MSG_MAX_AGE_MS`（index.ts:93）、`CTI_CONFIG_HOST`（config-center/index.ts:30）、`PENDING_IMG_TTL_MS`（index.ts:33，值为 `10*60*1000`，**"TTL 10 分钟"属实**）、`CTI_RT_LOG`（index.ts:43、claude.ts:22）、`CTI_HOME`（config.ts:106）。另核：`CTI_CLAUDE_MAX_RETRIES`（claude.ts:44）。
- **默认值属实**：看门狗默认 300s（claude.ts:45 的 `300_000`）✔；`MSG_MAX_AGE_MS` 默认 600000ms（index.ts:93）✔；图片 TTL 10 分钟（index.ts:33）✔；配置中心端口 13600（config-center/index.ts:49/52）✔；`MSG_MAX_AGE_MS` 的 `0 = 不限制` 语义（index.ts:321 的 `if (MSG_MAX_AGE_MS > 0)`）✔。
- **Provider 三模型分类本身正确**：claude 单常驻进程（`claude.ts:106` 的 `private q: Query | null`、`claude.ts:133` `ensureProcess`、`claude.ts:242-257` `resetSession` 先 dispose 再起重，`/new` 确实必须杀进程）✔；6 个 in-process 组确有 `private sessions = new Map<string, AcpSession>()`（dsh.ts:172、openclaw.ts:88、opencode.ts:93、reasonix.ts:93、mimo.ts:94、openakita.ts:100）✔；gemini/hermes/codex 的 `resetSession` 确实都是 no-op（gemini.ts:96-99、hermes.ts:71-74、codex.ts:42-44）且每次新建 session（gemini.ts:126、hermes.ts:101、codex.ts:71）✔ —— 分类成立，错的是**机制叙述**（M4/M6）。
- **config-center 那一批大行号全部逐条命中**（这是图上精度最高、最见功力的部分）：`server.ts` 60 / 112 / 313 / 322 / 412 / 417 / 438 / 464 / 491 / 630 / 693 / 736 / 769 / 780 / 998 / 1281，`store.ts` 341 / 377，`render.ts` 74 / 154 / 389（另有 `syncModelToCli` 在 render.ts:536），`migrate.ts` 32，`runtime.ts` 52 / 104 / 348，`config-center/index.ts` 29-46 / 55 —— **全部与代码一致**。
- **核心链路行号全部命中**：`index.ts` 177-182（WSClient）/ 155-175（EventDispatcher）/ 191-340（handleIncoming）/ 372（parseContent）/ 212-224（去重）/ 300-303（鉴权）/ 321-329（过期保护）/ 390（handleCardAction）；`commands.ts` 47 / 57-66 / 68 / 75 / 93 / 97 / 118 / 30（validateSendableImage）；`engine.ts` 169 / 193 / 217 / 311 / 358 / 424 / 525 / 548 / 562 / 717；`session.ts` 67 / 93 / 110 / 135；`types.ts` 9-17 / 73-90 / 80；`claude.ts` 133 / 242 / 283 / 305-357 / 313-315；`dsh.ts` 182 / 204 / 232；`feishu/client.ts` 98 / 122 / 353；`feishu/cards.ts` 26 / 100 / 117 / 276 / 281；`voice/asr.ts` 106 / 40；`voice/tts.ts` 148 / 395；`vision/look.ts` 92；`vision/mcp.ts` 28 / 72；`config.ts` 104 / 106 / 110 —— **全部逐段核对通过**。
- **`n_llm` 的死代码结论属实**：`src/core/llm.ts` 导出 `LlmClient` 等 7 个符号（llm.ts:16/21/31/37/45/53/79），全仓（排除 node_modules 与 dist）grep `core/llm` **0 处 import 命中**，唯一提及它的文件就是这份 `ARCHITECTURE-MAP.json` 自己。
- **`n_rt_claude` 的"无 --resume/--continue"属实**（claude.ts:148-157 的 options 无 resume 类参数）。
- **`/new` 对 claude 必须杀进程属实**（claude.ts:242-257：`dispose()` 后 `ensureProcess()`），且注释 `claude.ts:246` 明写"此前这里是空的，导致 /new 后上下文照旧累积"。
- **`d_dup` / `d_stale` / `d_boot` / `d_cfgapply` / `d_voice` / `d_dl` / `d_btn` / `d_dead` 的排查步骤与行号全部属实**（分别对应 index.ts:212-224、index.ts:93+321-329、config.ts:106/110、server.ts:112+1281、asr.ts:106/40+tts.ts:395/148+engine.ts:690、client.ts:353、index.ts:164-166、core/llm.ts）。
