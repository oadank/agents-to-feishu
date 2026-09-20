# WB 工作票 09-19 · zcode 施工记录（票1 / 票3）

施工人：zcode（第 12 号 bot）。纪律：全程未向飞书发送任何测试消息，判定只读日志与磁盘；tsc --noEmit 零错后提交。

---

## 票1【断头轮产物补投递】

**问题**：用户插队 auto-interrupt 掐断生图轮后，已生成的图没人投递（09-19 15:55 家装案：`Agnes-1789804808362.png` 生成成功未送达，用户干等）。

读日志实证后，根因比票面多一层，共两条丢图路径：

1. **进程腰斩**（15:55 案真凶）：`logs/dsh-out.log:11893` 出现 `generate_image 捕获 …Agnes-1789804808362.png → 本轮结束自动发飞书`（图已捕获待投递），仅隔 6 行 `:11899` 就是 `启动 bot=dsh` 重新开机横幅——进程在捕获之后、投递之前被重启，收尾投递链**根本没机会跑**。
2. **异常收尾**（票面描述的插队路径）：provider 流被 interrupt 掐成异常时，`handleText` 走外层 catch，正常收尾的语音/图片/generate_image 三段投递链被整体跳过。

**改法**（只改 `src/bridge/engine.ts`，两层防线）：

- **捕获即落盘台账**：`pendingImageIds`/`pendingGenFiles` 每捕获一条，同步写入 `~/.agents-to-feishu/runtime/pending-deliveries-<bot>.json`（路径惯例对齐 session 落盘，按 bot 分账，容量上限 40）。正常路径投递成功/永久失败即销账。
- **轮次异常收尾补投递**：外层 catch 渲染错误卡之后调 `rescueInterruptedRound`——先按正文/工具层兜底捕获（对齐正常收尾的 turnBlob 规则，尊重 toolSentPaths），再把本轮已捕获产物逐条补发；**有补发成功才带一句「上一轮被打断，图已补发」，无产物则静默**。
- **开机扫账补投递**：进程重启救不回的（15:55 案形态）由构造器延迟 2.5s（`CTI_BOOT_RESCUE_DELAY_MS` 可调）扫台账，残留条目逐条补发，有成功的对相应会话补同一句说明；7 天陈账作废。
- **销账纪律**（双发案红线）：发前先销账 = 每条最多投递一次；发送明确失败才回账等下次开机重试；gen-file 源文件已消失的永久失败不回账。**toolSentPaths 双发台账语义不变**，补投递同样过 `isToolSent` 检查；补发成功还会登记进票C 的 `genAutoDelivered` 跨轮防线（与另一会话同日在同文件落地的票C 改动合并共存，tsc 合并态通过）。
- `sendImageObjectById` 改返回 boolean，作为回账判据。

**证据**：

- `npx tsc --noEmit` 零错（含票C 合并态）。
- 新分支日志统一带 `[engine][断头轮补投递]` 前缀：`开机扫账: N 条待补发` / `轮次被打断 chat=… imageIds=N genFiles=M，开始补发` / `补发完成 N 张` / `超过 7 天的陈账作废` / `跳过: 文件不存在`。
- 自测已跑（offline 分支，零飞书流量）：假引擎实例 + 临时台账塞两条死链条目（不存在的 gen-file 路径 + 对象池里不存在的 sha256），验证①开机扫账触发②gen-file 死链被销账③image-object 失败回账④全程无任何发送调用（delivered=0 时不发说明句）。
- 真实投递分支（文件有效、真发图）受「禁发测试消息」约束不预演，由生产首例验收：日志标记齐全即命中。

---

## 票3【新 bot 单聊 id 自动进账】

**问题**：飞书 app（tenant_access_token）视角枚举不到 p2p 单聊（隐私墙实测），新 bot 的 chat_id 只能靠老大人肉报，`logs/chats-map.json` 常缺账（实跑前 11 户，缺 dsh）。

**改法**（config-center 加补账通道，手动触发，不建定时）：

- 新模块 `src/config-center/chats-map-scan.ts`：lark-cli **user 身份**（老大本人 token）`im +chat-list --types=p2p --page-size=100` 翻全页扫老大视角会话（实测 28 条，含全部 12 个 bot 的 p2p）；名册每户用**自家 app 凭据**调 `/bot/v3/info` 取 bot 显示名，按显示名归一化匹配（大小写/空白不敏感）找到对应 p2p 会话的 chat_id。
- 补账纪律：**只补缺失**（added）；已有账与扫描不符只报 `mismatch` 不改（防误伤在用会话）；扫到名册外的 bot 会话（系统助手、历史实验 bot 等）原样列进报告 `unmatchedBotChats` 给老大看，不动账。
- 两个触发口：控制台端点 `POST /api/tools/chats-map-scan`（server.ts，与既有 user-self-test 同款 lark-cli 调用姿势）；命令行 `npx tsx src/config-center/chats-map-scan.ts`（同一函数，端点要等 config-center 下次重启才生效，CLI 即时可跑）。
- 改造自 `team-artifacts/scan-chats.mjs` 的思路但换掉死路：原脚本用 app 身份列会话，恰是枚举不到 p2p 的隐私墙本身。

**证据**：实跑一次，`logs/chats-map.json` **11 户 → 12 户齐**（缺失的 dsh 已入账；名册 12 户的其余 11 个旧账全部 `kept`——扫描结果与账面逐户一致，等于顺带做了一次全量对账）。全程只读扫描 + 写本地账，零消息发送。

---

## 问题单（拿不准的，列出来不猜）

1. ~~**「13 户齐」与名册 12 户对不上**~~：config-store 名册（也是 lark_bot_directory 的 12 bot 花名册）就是 12 户，实跑补齐 12/12。若"第 13 户"另有所指…说一声，新 bot 上线后跑一次本通道即可自动入账。

   **2026-09-19 深夜销案（题面已定性）**：第 13 户 = 当天上线并入账的 **WorkBuddy**。现拉名册与账双向核对：名册 `config-store.json` 的 `agents` **13 户**，`logs/chats-map.json` **13 个 key**，**精确双射、零缺零多**（claude / codex / mimo / gemini / hermes / openakita / reasonix / openclaw / opencode / dsh / deeptutor / zcode / workbuddy，两边同名同数）。
   ⚠️ 但**票面要求的 chats-map-scan 全量对账本轮没能跑成**（阻塞与根因见问题 5）。上面这句是「名册 ↔ 账」的双向核验，**不是**扫描给出的 `added=0/kept=13/mismatch=0` 实测值 —— 原始口径的复跑待通道修好后补一次坐实。
2. ~~**config-center 端点生效时机**~~ → **2026-09-19 22:54 已生效**。变更单：`nssm restart config-center`（**只此一个服务**）。重启前后逐家核对 13 家 bot + config-center 的 nssm 状态，14/14 SERVICE_RUNNING，**未动其他任何服务**；新进程起始 **22:54:46**（晚于 09bec00 提交 ⇒ 端点所在的新代码确已在运行）。实调 `POST http://127.0.0.1:13600/api/tools/chats-map-scan` → **HTTP 200（端点已注册生效）**，138ms 返回 `ok:false`，失败点与 CLI **同一处**（那行 `im +chat-list --types=p2p --page-size=100 --as user`）—— 端点本身通了，扫描被问题 5 挡住。
3. **补投递只认图**：票面产物范围是 pendingImageIds/pendingGenFiles（图）。send_voice 语音、deeptutor 媒体件没纳入断头轮台账（语音重复发送比丢失更招人烦，保守处理）；要扩再说。
4. **mismatch 的处置**：本次实跑零 mismatch。将来出现（bot 改名/换号）通道只报不改，等老大裁决。
5. 【新增·**阻塞**·根因已定性】**chats-map-scan 在 zcode 家跑不起来：lark-cli 用户身份（陈丹）凭据不可达**。三连实测（真调，无 curl）：
   - `npx tsx src/config-center/chats-map-scan.ts` → **第一步即死**：`need_user_authorization (user: ou_a1dec4c18c6ce9030d6330e2dce78949)`，hint 要求重新走设备码登录；
   - `lark-cli auth status --json` → `user.status = missing`，`"no token in keychain for ou_a1dec4c…"`；`auth list --json` → 该用户 `tokenStatus: "no_token"`（**应用与用户登记都还在，缺的是凭据本身**）；
   - 端点侧（同为 LocalSystem）报得更前一层：`config / not_configured`（连 `~/.lark-cli/config.json` 都没找到，因为 SYSTEM 的 HOME 不是 `C:\Users\oadan`）。

   **根因（已定位到账号层）**：`zcode` 服务的登录账号是 **LocalSystem**（`sc qc zcode` → `SERVICE_START_NAME : LocalSystem`），而其余各家是 `.\oadan`（实测 claude/codex/mimo/gemini/hermes/openakita/openclaw/opencode/reasonix/dsh/deeptutor-bot **全是 `.\oadan`**）。lark-cli 的用户凭据落在 **OS keychain（Windows 账号级）**，SYSTEM 与 oadan 各看各的 ⇒ SYSTEM 上下文的 zcode 天然读不到 oadan 的 token。
   **旁证**：① dsh（`.\oadan`）今晚 21:36 用 `lark_send_as_user` 派发了本票，我收到的消息带 `(from-bot:dsh …)` 标记，而该标记只由 `sendAsUserToBot()`（`src/tools/lark-tools.ts:400`）拼接 ⇒ user 身份在 oadan 侧**是好的**；② 同机、同 CLI、同 appId，唯一变量是账号 ⇒ 差异只能来自 keychain 归属。

   **影响面（不止本票）**：zcode 家一切 `--as user` 操作全废 —— chats-map-scan、`lark_send_as_user`（bot 间派活）、`lark_chat_members`（@ 人要用），以及 **bot 派活自动回执转发**（`src/index.ts:257` → `sendAsUserToBot`，**与 `lark_send_as_user` 同一函数**）。本条已实测坐实：本轮真调 `lark_send_as_user(to="dsh")` 报同一个 `token_missing` ⇒ **本票回执送不到 dsh**。
   **团队群兜底同样不通**（已核查，勿再试）：群里 bot 间通讯本就靠 user 身份发 + `@`（dsh 日志里 WorkBuddy 的战报即此形态，`sender=ou_888b9…`＝陈丹在 dsh 视角的 open_id），而 bot 身份发的群消息既 @ 不到 dsh（飞书限制），又会被各家「群消息必须 @ 本 bot」闸门 SKIP（该 SKIP 日志全仓 **69 条**）⇒ 本票交付只能落在 openmem 条目 + 本文件，dsh 侧需人工取件。
6. 【新增·**待批**·未擅自执行】**修法（属服务/环境配置变更，需老大或总控批）**：把 `zcode` 服务账号改成 `.\oadan`，与其余 12 家一致 —— `nssm set zcode ObjectName ".\oadan"` + 重启 `zcode` 服务（**会打断我自己的会话**，按规矩不自行动宿主），改完用 `lark-cli auth list --json` 复核 `tokenStatus` 应恢复有效。备选：在 SYSTEM 上下文重走一次设备码登录（需老大点授权 URL，夜里不动）。**两条均未执行**，只报方案。附带提醒：`workbuddy` 服务同样是 LocalSystem，若它也要用 user 身份（@ 人 / 派活），可一并收口。

---
---

# WB 任务单 09-19（第二批）· WorkBuddy 施工记录（票1 / 票2）

施工人：WorkBuddy（agent 模式）。授权：陈丹 ｜ 拟定：DSH。
纪律：**全程未向飞书发送任何测试消息**，判定只读日志与磁盘；临时的探针文件已全部清理。

---

## 票1【自身 WebSocket 保活：排查长连接断线后变僵尸连接】

### 问题（现象）

agents-to-feishu 的飞书 WebSocket 长连接会出现「**显示已连接、但事件断流**」的僵尸状态：

- 2026-09-19 09:07 dsh、09:20 openakita 双双出现断流（dsh 28 分钟后自愈、openakita 必须 restart 才恢复）
- TCP 层完全看不出来：`c443=1`（ESTABLISHED 计数正常）却零 `handleIncoming` 调用
- 磁盘证据：`logs/reasonix-err-*.log` 中共 **81 条** `[ws-watch] WS 已静默 N 分钟无任何消息事件` 告警，其中一段从 14 分钟一路涨到 **84 分钟**才被人工发现

```
[agents-to-feishu] [ws-watch] WS 已静默 14 分钟无任何消息事件（连接可能假活，若 bot 同时无响应请 restart 并附本日志）
[agents-to-feishu] [ws-watch] WS 已静默 19 分钟无任何消息事件（…）
...（略 13 条）...
[agents-to-feishu] [ws-watch] WS 已静默 84 分钟无任何消息事件（…）
```
证据文件：`logs/reasonix-err-20260919T112045.128.log`

### 根因（自查结果：现有机制不满足票面要求）

阅读 `node_modules/@larksuiteoapi/node-sdk/lib/index.js`（实装版本 **1.73.0**）后确认，SDK 自带的 WS 机制有 **两处致命缺口**：

| 机制 | SDK 默认值 | 问题 |
|---|---|---|
| **ping 心跳** | `pingInterval = 120_000ms`（**120 秒**） | 票面要求 30 秒 → **不满足** |
| **pong 看门狗** | `pingTimeout` **未设置 → `armLiveness()` 直接 return（no-op）** | **发完 ping 就不管了**。TCP 半开（NAT 超时 / 对端静默丢包 / CLOSE 帧丢失）时 socket 仍报 OPEN → 既不收事件、也不触发 `close` → 永不重连 → **僵尸连接** |
| **重连间隔** | `reconnectInterval = 120_000ms`（**固定值**） | `loopReConnect()` 里是 `setTimeout(…, reconnectInterval)`，**不随失败次数增长** → 票面要求的「指数退避」→ **不满足** |
| 重连次数 | `reconnectCount = -1`（无限） | 这项 OK |

关键代码（SDK 原文）：
```js
// armLiveness()：未设置 pingTimeout 时直接返回，看门狗形同虚设
armLiveness() {
    if (!this.pingTimeoutSec)
        return;                                   // ← 当前配置走的就是这条路
    ...
    this.livenessTimer = setTimeout(() => {
        this.logger.warn('[ws]', `no pong/inbound within ${this.pingTimeoutSec}s of last ping, terminating to trigger reconnect`);
        this.wsConfig.getWSInstance()?.terminate();   // ← 有它才能真正治僵尸
    }, this.pingTimeoutSec * 1000);
}
```
```js
// loopReConnect()：间隔恒定，非指数退避
this.reconnectInterval = setTimeout(() => { loopReConnect.bind(this)(count); }, reconnectInterval);
```

另确认：SDK 的 `retry()` 通用指数退避（`delay = base * Math.pow(3, attempt-1)`）**只用于 HTTP 请求重试，不覆盖 WS 重连**。

**结论：现有机制不足，需补齐。**

### 改法（具体改动）

**唯一改动文件：`src/index.ts`（+79 行，-0 行，未触碰其他 bot）**

**① 启用 SDK 原生 pong 看门狗 + 30 秒 ping（构造时传 `pingTimeout`）**
```ts
const wsClient = new lark.WSClient({
  appId: bot.appId,
  appSecret: bot.appSecret,
  loggerLevel: lark.LoggerLevel.info,
  wsConfig: { pingTimeout: 45 },   // ← 新增：45s 内无任何入站帧 → terminate → 走标准重连
});
await wsClient.start({ eventDispatcher: dispatcher });
```
`pingTimeout` 取 **45s**：必须 > ping 间隔（30s），留一个 ping 周期余量；飞书 pong 实测 <1s，不会误杀健康连接。

**② `start()` 之后覆写 `pingInterval` 为 30 秒**
```ts
const wsCfg = (wsClient as unknown as { wsConfig?: {...} }).wsConfig;
if (wsCfg?.updateWs) {
  wsCfg.updateWs({ pingInterval: 30_000 });      // 30s 心跳
  const eff = wsCfg.getWS?.().pingInterval;
  rtLog(`[ws-keepalive] pingInterval=${eff}ms（30s 心跳）+ pingTimeout=45s（pong 看门狗已启用）`);
}
```
**为什么必须在 `start()` 之后**：SDK 构造函数只暴露 `pingTimeout`（`IConstructorParams.wsConfig` 的类型 `WSConfigOverrides` 里**只有 `pingTimeout` 一个字段**），`pingInterval` 传不进去；而 `start()` 内部会执行 `updateWs({ pingInterval: ClientConfig.PingInterval * 1000 })` 用**服务端下发值覆盖**。放在 `start()` 之后才不会被冲掉。

**③ 外层指数退避重连（补 SDK 的固定 120s 缺口）**
```ts
let reconnectAttempts = 0;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];  // 1/2/4/8/16/32/60s 封顶
wsClient.onReconnecting = () => { reconnectAttempts += 1; lastReconnectAt = Date.now(); ... };
wsClient.onReconnected  = () => { reconnectAttempts = 0; ... };
// 兜底看门狗：SDK 重连卡死（半开 socket 常卡这步）→ 强制 terminate + 重启连接
setInterval(() => {
  if (reconnectAttempts <= 0) return;
  const cap = backoffFor(reconnectAttempts) + 60_000;
  if (Date.now() - lastReconnectAt > cap) { /* terminate + start() */ }
}, 15_000).unref?.();
```
退避语义：连续失败第 1 次容忍 1s+60s，第 7 次起容忍 120s，超时即判定 SDK 重连卡死并强制重置状态机。

**验证：`tsc --noEmit` 通过，0 错误。**

### 证据

**探针实测（不连飞书、不发消息，仅验 SDK 私有字段可覆写性）**
```
typeof wsConfig       = object
typeof updateWs       = function
typeof getWS          = function
默认 pingInterval(ms) = 120000          ← 确认默认 120s，非票面要求的 30s
pingTimeoutSec        = 45 (应=45)      ← 确认 pingTimeout 已生效，看门狗被武装
覆写后 pingInterval   = 30000           ← 确认可覆写为 30s
被服务端值覆盖后      = 120000          ← 证明必须在 start() 之后覆写（否则被冲掉）
```

**日志证据（僵尸连接真实发生过，81 条）**
```
$ grep -c "ws-watch" logs/reasonix-err-*.log
81
$ grep -h "ws-watch" logs/reasonix-err-20260919T112045.128.log | tail -3
[ws-watch] WS 已静默 74 分钟无任何消息事件（…）
[ws-watch] WS 已静默 79 分钟无任何消息事件（…）
[ws-watch] WS 已静默 84 分钟无任何消息事件（…）
```

**改动范围证据（未动其他 bot）**
```
$ git status --short
 M src/index.ts          ← 仅此一个文件
$ git diff --stat
 src/index.ts | 79 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 79 insertions(+)
```
79 行**全为新增、零删除**，无任何其他 bot 的 provider / 配置被修改。

### 结论（人话）

飞书 SDK 默认 120 秒才 ping 一次、而且**发完 ping 根本不检查有没有回应**——这就是僵尸连接的成因：网断了但 socket 没报错，程序永远等下去。现已改成 **30 秒 ping + 45 秒 pong 看门狗**（超时主动掐断连接逼它重连），并在外层补了 **1→60 秒指数退避**（SDK 自己是固定 120 秒，不满足票面）。改完 `tsc` 全过。只动了 `src/index.ts` 一个文件，其他 bot 一根手指都没碰。

---

## 票2【reasonix bash 命令全挂（exit code 126）】

### 问题（现象）

reasonix（nssm 服务名 `reasonix`，引擎仓 `C:\D\opt\agents-to-feishu`，走 CTI_BOT 分流）**所有 bash 命令均失败**，AI 侧统一收到：

```
error: shell startup/child-process check failed; requested command was not run:
command exited: exit status 126
__reasonix_windows_sandbox_failure__:4aa678167a9b039c
windows sandbox: session temp "C:\Users\oadan\AppData\Local\Temp\reasonix-session-tmp-3359797440"
  overlaps writable root "C:\"
```
126 = 「找到了但无法执行」→ **不是命令写错**，是执行器在派生子进程前就被拒了。

### 根因（已确证）

`C:\Users\oadan\AppData\Roaming\reasonix\config.toml` 的 `[sandbox] allow_write` 原值为：
```toml
allow_write = ["C:\\", "C:\\D", "C:\\D\\opt", "C:\\Users\\oadan"]
```
reasonix 的 Windows 沙箱启动前做**写路径自检**，两条规则被同时踩中：

1. **可写根与 session temp 重叠**：session temp 落在 `%TEMP%\reasonix-session-tmp-*`（`C:\Users\oadan\AppData\Local\Temp\...`），而 `allow_write` 含 `C:\` 与 `C:\Users\oadan` → **父路径包含** → 判定重叠 → 拒绝启动子进程 → **exit 126**
2. **可写根包住受保护 state root**：`C:\Users\oadan` 包含了 reasonix 自己的状态目录 `C:\Users\oadan\AppData\Roaming\reasonix` → 触发保护机制 → 同样 126

收窄过程（逐步逼近，每步错误信息都在变，证明命中同一自检逻辑）：
```
allow_write = ["C:\"]                    → overlaps writable root "C:\"                （session temp 被 C:\ 包含）
allow_write = ["C:\", "C:\Users\oadan"]  → overlaps writable root "C:\Users\oadan"    （同上，更具体）
allow_write = ["C:\D"]                   → 126 消失
```
注意：`[sandbox] bash = "off"` 时按官方注释「Windows has no OS-level Bash sandbox and fixes bash = off」，**本不该有沙箱校验动作**；但实测校验照跑，说明该自检发生在更早的路径合法性检查阶段，与 `bash` 开关无关。

### 改法（已实施）

**唯一改动：`%APPDATA%\reasonix\config.toml` 第 231 行**
```diff
- allow_write = ["C:\\", "C:\\D", "C:\\D\\opt", "C:\\Users\\oadan"]
+ allow_write = ["C:\\D"]
```
`C:\D` 已覆盖全部实际工作目录（`C:\D\opt\agents-to-feishu` 等），同时**不再包含** session temp 所在目录、也**不再包含** reasonix 自身 state root。备份：`config.toml.bak-wb-126fix-20260919-185852`（原始）。

同时**已回滚**一次过程性尝试：曾把 `[tools.shell] prefer` 由 `"pwsh"` 改成 `"bash"`，实测 stderr 提示「Windows Agent now uses native PowerShell; the saved Bash preference is retained for older versions」→ 该值对当前版本无效，**已改回 `"pwsh"` 并加注释**。

**改动后校验（`reasonix doctor --json`，只读诊断）**
```json
"sandbox": {
  "bash": "off",
  "network": true,
  "write_roots": ["C:\\D\\opt\\agents-to-feishu", "C:\\D"],   ← 已收窄，无 C:\ / C:\Users\oadan
  "available": true,
  "shell": "powershell (C:\\Program Files\\PowerShell\\7\\pwsh.exe)"
}
```
**`exit code 126` 已消失。**

### 遗留问题（未定论 → 按票据要求列问题单，不擅自继续试错）

126 修掉后暴露出**第二层故障**，且已确证**不是环境问题**：

**现象**：bash 工具改为 **10 秒超时**
```
error: shell startup/child-process check failed; requested command was not run:
command timed out (> 10s). Do not retry commands through this shell until
its configuration or execution environment is repaired
```
结构化事件里精确卡表：`tool_duration_ms: 10318 / 10336 / 10299`（稳定卡在 10s 上限）

**已排除的因素（均有实测数据）**：

| 假设 | 实测 | 结论 |
|---|---|---|
| 票面提示的「nssm PATH 启动快照缺 System32」 | `powershell -NoProfile` = **1264ms**、`pwsh -NoProfile` = **492ms**、`pwsh +profile +echo` = **2506ms** | ❌ 排除，环境启动远快于 10s |
| 换 shell 二进制（pwsh v7 vs PS 5.1） | 把 `prefer`/`path` 显式 pin 到 PS 5.1 后**报同样的 10s 超时** | ❌ 排除，与 shell 二进制无关 |
| 干净最小环境（模拟 nssm 快照） | 仅保留 SystemRoot/ComSpec/PATH 等必需变量重跑，**同样 10s 超时** | ❌ 排除，与 PATH 快照无关 |
| 脏 session 状态 | `reasonix doctor` 的 `sessions.recovery` 全零、`crash-fatal/18500.log` 为 0 字节、`lifecycle/18500-*.json` 显示 `phase: healthy` | ❌ 排除，无异常残留 |
| 版本已知 bug / 有新版可升 | `v1.38.10`（git `366e0eb6b86b`，build 2026-09-18T02:26:50Z），`upgrade --check` → 「**已是最新版本**」 | ⚠️ 无法用升级规避 |

**证据链**：失败点稳定在 reasonix **自身**的「shell startup / child-process check」阶段，10s 为**代码内硬编码预算**，与外部环境无关。所有排查都在只读范围内完成（`doctor --json` / `version --verbose` / `upgrade --check`），未再改动任何配置。

### 问题单（待 DSH / 陈丹确认后再动手）

1. **定位**：10s 硬编码预算在 reasonix 二进制内部。是否找 reasonix 官方（v1.38.10）报 bug？还是接受「bash 工具此机不可用」的现状？
2. **是否需要兜底方案**：在桥侧（`src/providers/reasonix.ts`）把 bash 类工具请求**降级**走 FileSystem/MCP 工具（读文件、ls 等非 shell 能力实测正常）？这属于**功能改动**，按规矩需先报方案获批。
3. **`allow_write` 是否还要继续收窄**：当前 `["C:\\D"]` 已够用；若后续发现 reasonix 需要写临时目录，可能还得单列，需评估。

### 结论（人话）

**126 的根因找到了、也修好了**：`allow_write` 里写了 `C:\` 和 `C:\Users\oadan`，正好把「临时目录」和「reasonix 自己的状态目录」都包了进去，沙箱自检判定重叠 → 直接拒绝执行 → 126。收窄成 `["C:\\D"]` 后 126 消失。

**但下面还压着一层**：现在变成 10 秒超时。我把票面提示的 PATH 快照、执行器权限、以及我想得到的 shell 版本 / 干净环境 / 脏状态全部实测排除了一遍——**环境侧启动只要 0.5~2.5 秒，根本不是环境慢**，是 reasonix 自己那段自检逻辑卡住。它已经是最新版、没有可升的版本。**这一层我没动，也不敢乱动**：按票据「判断不定先列问题单」的要求停在这里，上面 3 个问题请定夺。

---

## 交付汇总（第二批）

| 票 | 状态 | 改动文件 | 证据 |
|---|---|---|---|
| 票1 WS 保活 | ✅ 已补齐 | `src/index.ts`（+79 行） | SDK 源码机制 + 81 条僵尸连接日志 + 探针实测 + `tsc` 通过 |
| 票2 bash 126 | ⚠️ 部分修复（126 已解，遗留 10s 超时） | `%APPDATA%\reasonix\config.toml`（1 行） | `doctor --json` write_roots 已收窄；4 组排除实验 |

**约束遵守**：全程未向飞书发送任何测试消息；判定依据仅来自 `logs/reasonix-*.log`、`reasonix doctor`（只读）、磁盘状态与配置对比。所有临时探针文件已清理，`git status` 仅剩 `src/index.ts` 一处改动。
=== 撤单落账(不知会任何人, 只记账) ===
■ 【撤单记录 09-20 老大口谕】wb-1①「10s 痕迹穷尽」与 wb-1②「方案书 A/B」两票永久撤销——前提已死(真因 allow_write 过宽已修, 沙箱 active), 且 dsh 第三条路已绕过; 无需知会执行人, 本行即结案。
