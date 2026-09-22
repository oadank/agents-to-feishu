# 派工单 第三批 · 2026-09-19 深夜（DSH 拟定，老大授权 bot 直发）

> 下发状态（2026-09-19 深夜）：zcode（票 z-1）✅ 已发、mimo（票 mm-1）✅ 已发（均 lark_send_as_user 私聊直达，带回执协议）；WorkBuddy（票 wb-1）⏸ 按老大指示暂不发；票 ds-1 继续待拍板。

前情：zcode 票1/票3 已交付（commit 09bec00，DSH 验收 PASS）；WorkBuddy 第二批票1(WS保活)/票2(bash126) 已验收（票1 代码入 HEAD 待重启生效，票2 PASS+遗留 10s 超时）；mimo 票A/C 完结、票B 布弹未触发、usage 审计报告已出。chats-map 实测 13 户齐（第 13 户=WorkBuddy 当天上线已入账——zcode 问题单 1 销案）。

---

## 【zcode｜票 z-1：票3 销案 + config-center 变更单】

背景：你两票验收 PASS（4 文件 418 行与票面相符，engine.ts 补投递标记 14 处，已推送）。问题单 1「13 户」已定性：第 13 户 = 当天上线的 WorkBuddy，logs/chats-map.json 现实测 13 户全在账。

1. 复跑 `npx tsx src/config-center/chats-map-scan.ts` 全量对账（预期 added=0 / kept=13 / mismatch=0，unmatched 照实列出），把销案记录追加进 docs/WB-TICKETS-0919.md 问题单段。
2. 出变更单重启 config-center（nssm 单服务，勿动其他 bot），使 `POST /api/tools/chats-map-scan` 端点生效；重启后实调一次端点验证与 CLI 同结果，nssm status 确认 Running。
3. 提交 docs 改动——**按文件点名 add，禁 git add -A**：docs/WB-TICKETS-0919.md 里 WB 第二批段落是 WorkBuddy 未提交内容，留给它自收尾。

纪律：全程不发飞书测试消息；只重启 config-center 一个服务。

---

## 【WorkBuddy｜票 wb-1：票2 第二层收口 + 台账缺陷 + 入库收尾】

背景：你票1 WS 保活 +79 行已在 HEAD（代码真，bot 重启生效窗口归老大拍板，勿自行动服务）；票2 的 126 已修好验收 PASS，遗留 10s 超时问题单待裁决。

1. （只读）把 reasonix 10s 超时的**文件系统侧痕迹**穷尽：reasonix logs 目录、session temp 的生成/删除时序、子进程是否被 spawn 过——给出「自检卡在哪一步」的行为描述；证据到边界即止，不擅动现行有效的 config.toml。
2. 准备两个**备用方案书**（只写方案不开工，待批）：A=桥侧 src/providers/reasonix.ts bash 工具降级走 FileSystem/MCP；B=报 reasonix 官方英文 issue 草稿（v1.38.10）。
3. 收尾：docs/WB-TICKETS-0919.md 第二批段落仍 M 未提交，按文件点名提交。
4. WB-CAPABILITY-0919.md 记的两项缺陷之「工具风暴」：复现完整证据链（哪轮/连发几次/日志行），提根因假设与桥侧防风暴方案，老大裁决后再开票。

纪律：不发飞书测试消息；不动任何服务；git 点名 add。

### wb-1 增补：dsh 取证交接（2026-09-19 23:3x，应 reasonix 转报）

reasonix 实测其 exec 沙箱整轮不可用（所有 bash 10s 超时，报 `session temp overlaps writable root "C:\"`），今天靠桌面助手绕行完成了 dsh 服务代重启。dsh 已做完边界取证（openmem `8c539271`），**桥侧无罪，雷在引擎配置侧**，直接并入你 wb-1① 调查范围：

1. 桥侧排除项：nssm reasonix AppDirectory=C:\D\opt\agents-to-feishu；providers/reasonix.ts spawn cwd=CTI_DEFAULT_WORKDIR||process.cwd()，该 env 未设；dsh 自家 bash 同窗自检正常——盘根不是桥传进去的。
2. config.toml（%APPDATA%\reasonix）两处盘根疑点：`[[bot.routes]].workspace_root = "C:\\"`（272 行；[bot] enabled=false，网关是死的，疑历史遗留但引擎解析未必跳过）；`[[remote.hosts]]` XDN `workspace = "C:\\"`（354 行）。另 `[sandbox] allow_write = ["C:\\D"]`（231 行）整个 D 盘写根，workspace_root 未显式设（默认=cwd）。
3. 引擎侧痕迹：`Roaming\reasonix\windows-sandbox-capabilities-v1\*.json` 23:24 仍 `status:"preparing"`、`canonicalPath:"C:\D"`、ownerPid=36024——沙箱 ACL 准备疑似永不收敛。
4. 你的方案书 A/B 口径可据此校准：候选修复=收窄 allow_write 至 C:\D\opt、清 bot.routes 的 C:\ 遗留、或 session temp 挪出 C:\ 卷——全在 config.toml/引擎侧，**红线不变：不擅动，方案书待批**。

---

## 【mimo｜票 mm-1：票B 弹头收尾 + usage 审计修复票 + 入库收尾】

背景：20:5x 实测 claude 日志无 `auto /new on engine session lost`——票B 布弹未被自然消息命中；且 99ec8470 的 jsonl 移走后 claude 一直跑 fresh 态。

1. 弹头收尾：先提方案（推荐=恢复现场：jsonl 备份归位 + 以「代码修复 bbef2f7 + 探针实锤」结案、实弹记「未自然触发」），待老大拍板后执行，勿擅自归位。
2. 修复票两单（源自你的 USAGE-AUDIT 报告）：①无 cache 拆分时卡尾显示 N/A 而非 0.00%（readCacheStats 分母判 0 + cards.ts 兜底）；②gemini usage sessionId 错位（divider acpSessionId 与 litellm 补拉记录 session 字段不一致）——先定位，无把握修就出报告。tsc --noEmit 零错、按文件点名 commit、不动服务。
3. 收尾：docs/USAGE-AUDIT-0919.md（??）提交入库；team-artifacts/mimo-audit-0919/ 明确不入库或清理，二选一给建议。

纪律：不发飞书测试消息；禁止批量操作服务。

---

## 【dsh（我）｜票 ds-1：等老大拍板后执行】

1. 桥重启批次方案：engine.ts 已压三条新防线待装载（断头轮补投递 09bec00、票C 跨轮发图台账 638438b、WS 保活），另 9e19668 卡片三防。建议夜间低峰 **一次一个** nssm 重启 13 家桥 + status 逐一验证，禁批量。
2. 观察台账：生产首例断头轮补投递（grep `[engine][断头轮补投递]`）；ws-watch 告警频次变化（基线 81 条）。
3. 凭据收口：12d872fd/49908157 内 N5105 SSH 明文口令迁用户级 env/nssm env，条目改指针——等老大点头。

---

## 票 ds-1 执行台账（dsh，2026-09-19 深夜，老大令"干你自己的部分"）

- **滚重启**：13 家桥中 11 家（claude/codex/gemini/hermes/mimo/openakita/openclaw/opencode/reasonix/zcode/deeptutor-bot）逐一 `nssm restart` + `Get-Service` 验证 Running，23:06–23:08 完成；workbuddy 23:03 已被当日会话重启（在 8e7cf9a 新码上，跳过）；**dsh 由 reasonix 代动收尾**（禁自重启铁律）。重启前核过 git status：src 工作区干净（只有 docs 未提交，属各家自己的收尾件），无腰斩风险；重启前 zcode/mimo 轮子均已 FINAL 收尾。三家新防线（断头轮补投递 09bec00 / 票C 跨轮台账 638438b / WS 保活）+ 22 点后 WB 四连修（ce88190/15ad089/a649312/8e7cf9a）全部装载。
- **踩坑记档**：nssm 命令行输出 UTF-16 带 NUL，PowerShell `-replace "`0"` 后仍是**数组**，`$arr -notmatch 'RUNNING'` 按 filter 语义返回非空即真——首轮把 2 家健康的 claude/codex 误报"未起"提前停手。改用 `Get-Service.Status` 判定。教训：判服务状态别拿 nssm stdout 字符串匹配。
- **观察基线**：`ws-watch` 关键字 logs/*.log 全量 663 行（旧"81 条基线"是按日口径，日志行不带日期串，按日过滤口径作废）；`[engine][断头轮补投递]` 生产首例待自然断头轮出现，grep 即可验收。
- **凭据收口**：N5105 口令迁用户级 env `N5105_SSH_PASSWORD`（HKCU\Environment，回读验证✓）；openmem 两条明文条目 12d872fd/49908157 原地改指针（confidence 0.9）；自动化姿势首选密钥 `id_rsa_n5105`（实测存在）；桥内代码零消费方（grep 全仓仅 agnes URL 与 README，无 sshpass 调用）。**遗留**：指针条目历史指向过 `~/.workbuddy/MEMORY.md` 凭据段（WB 自管文件），已在其条目里挂警示，需 WB 侧自清。
- **提交纪律**：本文件按文件点名提交，不碰 WB-TICKETS（M，WB 自提）/USAGE-AUDIT（mimo 自提）/team-artifacts。

---

## 老大拍板项汇总

1. 桥重启批次（13 家引擎 bot 何时滚重启，一次一个）。——✅ 已拍板执行完（见 ds-1 台账）
2. reasonix bash 10s 超时方向：报官方 / 桥侧降级 / 接受现状（WB 备方案 A/B 待命）。——✅ 09-20 晨老大令"快修"：dsh 已改 config.toml 两处盘根（allow_write C:\D→C:\D\opt、bot.routes workspace_root C:\→agents-to-feishu，留 bak-dsh-sandboxfix-20260920）并重启 reasonix 单服务，待其 bash 自测回执。
3. mimo 票B 弹头：恢复现场结案，还是继续布弹。
4. 凭据收口是否即刻（dsh 执行）。——✅ 已执行完（口令迁 env，条目改指针）
5. 【新增·z-1 衍生】zcode 服务账户=LocalSystem（其余 12 家均 .\oadan），OS keychain 隔离致其 lark-cli user 身份全废（补账复跑/自动回执均卡）。待批：nssm 改 .\oadan + 重启 zcode。其 z-1 复跑项已由 dsh 代跑销案：13 户全 kept / added=0 / mismatch=0 / changed=false（扫 29 会话，名册外 bot 会话仅列报不动账）。
