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

1. **「13 户齐」与名册 12 户对不上**：config-store 名册（也是 lark_bot_directory 的 12 bot 花名册）就是 12 户，实跑补齐 12/12。若"第 13 户"另有所指（如老大视角里那个不属于名册的「陈丹的智能伙伴」bot 会话，或即将新建的 bot），说一声，新 bot 上线后跑一次本通道即可自动入账。
2. **config-center 端点生效时机**：新端点写进了代码，但运行中的 config-center 服务没重启，要下次重启才带上。本次验收走 CLI 同码路完成，未碰服务（按规矩不出变更单不重启）；要立即生效说一声，我出变更单重启。
3. **补投递只认图**：票面产物范围是 pendingImageIds/pendingGenFiles（图）。send_voice 语音、deeptutor 媒体件没纳入断头轮台账（语音重复发送比丢失更招人烦，保守处理）；要扩再说。
4. **mismatch 的处置**：本次实跑零 mismatch。将来出现（bot 改名/换号）通道只报不改，等老大裁决。
