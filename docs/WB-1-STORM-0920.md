# wb-1⑤ · 09-19 19:1x 工具风暴取证与防风暴方案（WorkBuddy · 2026-09-20）

口径声明：以下全部为磁盘实测（trace 文件 mtime/内容、会话 jsonl 逐条解析、桥日志、注册表现读），未采信任何记忆；dsh 给的三个数字（一轮 265 次 / 一分钟 20+ 个 / 每个约 130KB）逐一与实测对账，对不上的如实写明。

## 1. 是哪一轮（定位）

| 项 | 实测值 | 证据 |
|---|---|---|
| 落点 | `C:\Users\oadan\.workbuddy\traces\37024\` | WorkBuddy **桌面版** home（非桥家 `~\.codebuddy`；桥家同窗口只有 19:46/19:57 两枚小 trace） |
| 会话 | `8fe1cc3d-3a1a-4ed3-9556-f6ad4671190d`，workspace `C:\Users\oadan\WorkBuddy\2026-09-18-14-48-23`，驱动 pid=37024（hostname LeCoo） | 每个 trace 的 `trace.sessionId/workerPid` |
| 时间窗 | 09-19 **18:52–19:22**（dsh 说 19:1x，实际起于 18:52），19:22:56 上下文压缩后又续一轮到 19:38:44 | trace mtime 直方图 + jsonl 时间戳 |
| 量 | 窗口内 62 枚 trace（18:52 起 4-9 枚/分钟），全天该目录 273 枚；单分钟峰值 **9**（18:54） | 分钟直方图（见 §4 附） |
| 内容 | WB 第二批施工**票2**（reasonix bash 起不来：126→沙箱 allow_write 收窄→10s 超时排查），助手原话 19:00:32"又推进了一层"、19:05:27"全部 <3 秒"、19:05:35"Session 0"… | jsonl assistant 消息 + trace 里 Bash span 原文（`REASONIX_HOME`、`reasonix-session-tmp`、`prefer = "pwsh"` 等） |
| 模型 | `deepseek-v4.1-flash`（trace generation span 原文） | 桌面版默认；桥 WB provider 用 `custom-local:QW3.8F`（workbuddy.ts:50-53） |
| 人设 | 首条消息注入 `~\.workbuddy\SOUL.md`（"WorkBuddy 的行为准则"） | jsonl 第 1 行 identity_context 原文 |

**归属如实报**：施工人=WorkBuddy（票面授权陈丹，WB-TICKETS-0919.md 已注明），跑在桌面版入口，不是桥常驻 ACP 进程。票2 的 reasonix 配置后续按 dsh 09-20 令已移交专人，本人未再碰。

## 2. 为什么连发

1. **排障即循环**：票2 的活法就是"试→看→再试"（改 config.toml→起 reasonix→超时→换变量→再来），每一步=一整轮 LLM 往返，单步 ~7s、每步只发 1 个工具（Bash/Edit/Write/PowerShell）。轮次天然多，且引擎无回合上限时不会自己停。
2. **放大器A（trace 体积）**：每轮固定挂 **16 个 `mcp_tools` span**（MCP 目录全量 dump）→ 单枚 trace ≈123-135KB，dsh 看到的"每个约 130KB"= 1 Bash span + 16 mcp_tools + 1 generation。62 枚≈8MB 纯目录重复。
3. **放大器B（压缩自续）**：19:22:56 上下文被压缩，引擎注入 `Please continue with the conversation based on the summarized context above.` 自动续工，单 turn 又发 **93** 个 function_call（19:23–19:38）。这是全窗口最大单轮。
4. **入口差异**：桌面版入口没有 `--max-turns` 封顶；桥 provider spawn 有（workbuddy.ts:170 `'--max-turns','40'`）——同一引擎二进制，两个入口一有一无，风暴面全在"无"那边。

## 3. 与 dsh 数字对账（不认账的部分明说）

- **"一轮 265 次工具调用"**：两 home 全量扫描（17,607 个 trace）09-19 19 时段单 trace spanCount 峰值=36；会话 jsonl 单 turn 峰值=93（19:22 自续轮），19:00–19:22 整窗 function_call=64。**找不到 265 对应的实物**。265 若按 call+result 合并计数也对不上（93×2=186）。请以你侧出处复核，磁盘实测以本文表为准。
- **"一分钟堆出 20 多个 trace"**：实测单分钟峰值=9（18:54，两 home 合并口径）。62 枚摊在 18:52–19:22 共 31 分钟。
- **"每个约 130KB"**：✅ 吻合（123–251KB，主体 124–130KB）。
- 结论量级不变：22 分钟 62 轮普通聊天式连发、~8MB 痕迹，确实是风暴；但根数是"轮次多+每轮自带 16 份目录 dump+压缩自续无上限"，不是"一轮 265 并发"。

## 4. 防风暴方案（阈值 / 熔断 / 自检）

**已落地（本票③commit ae80a45 + 祖传，均文件:行号可查）**
- 熔断-进程级：`initialize` 失败当场强杀清把手，下条消息真重建（workbuddy.ts:193-206）——堵死"半死进程让每轮 rpc 饿死 900s 再重灌"的复利风暴。
- 熔断-在途级：`proc.on('exit')` 当场以 error 唤醒全部 pend（workbuddy.ts:186-193）——死进程不再让卡片挂 15 分钟。
- 阈值-桥入口：`--max-turns 40` + `--effort medium`（workbuddy.ts:169-170，09-19 三治遗留）。

**建议（需批准，本票未擅动）**
- 阈值-桌面入口：`~\.workbuddy` 用户级 settings 设 `maxTurns=40`，与桥入口对齐（key 名需先对 CLI 文档验证再落笔，属陈丹用户目录，按规矩先报）。
- 阈值-mcp_tools 体积：桌面 trace 每轮全量 dump MCP 目录（16 span 重复）属引擎诊断行为，桥家无关；若老大要压总量，方向是 trace 采样率（引擎侧开关），列观察项不动手。
- 自检-回合账本：桥 provider 已收 `usage_update`（workbuddy.ts:261-279）；后续可在 bridge/engine 加"单消息 tool 数 > N（建议 60，实测风暴轮 62-93）即日志点名 + 卡片提示"，纯记账不拦截。本票按"一次到位不试探"不再扩面，等票批。

## 5. 证据附录（复现命令）

```
# 分钟直方图（两 home）：18:52 起、峰值 9/min（18:54）、19:22 后仅 19:46/19:57
python -c "glob+getmtime 计数，脚本同文提交于本票会话"
# 会话解剖
C:\Users\oadan\.workbuddy\projects\c-Users-oadan-WorkBuddy-2026-09-18-14-48-23\8fe1cc3d-3a1a-4ed3-9556-f6ad4671190d.jsonl
  → 5150 行：function_call 1570 / result 1570 / reasoning 808 / message 943
  → 19:00–19:22:31 窗口 function_call=64；单 turn 峰值 93（19:22:56 压缩自续轮）
# trace 结构：{trace{spanCount,sessionId,workerPid,modelInfo...},spans[{name:Bash|mcp_tools|generation,toolInput...}]}
# 桥日志：logs/workbuddy-out.log 无任何 09-19 行（桥 WB 当日未风暴）；
# 注册表现读：workbuddy 服务 CTI_RT_LOG=mimo-rt.log（dsh 09-20 坐实），本审计未引用该文件任何行。
```

约束遵守：未 push、未重启服务、未发飞书测试消息、未碰 reasonix 配置。
