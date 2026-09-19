---
name: vision-verify
description: 视觉/体检探针的判分与核验口径：物理痕迹为准、单发等 FINAL、误杀清单模式
---

# 技能：视觉核验（vision-verify）

给 bot 做视觉/生图体检、判定"有没有真调工具"时用本技能，防误杀与假阴性。

## 判分口径（v2：物理痕迹为准）

1. **格子里以引擎物理痕迹为准**：rt.log / 引擎历史回放里有真调记录（`Executing tool: call_mcp_tool` + 参数）才算数。
2. 判定器纯文本匹配会**误杀 markdown**：回复把 token 包进 `**粗体**` 或加反引号，判定器若不剥格式就漏判——先剥格式再匹配。
3. 工单给的 mid 可能是飞书端视角转抄，本地桥日志未必搜得到；以本地可验 mid + 引擎有痕为准，报告里写清证据链。

## 探针姿势（坑36 铁律）

- **单发等 FINAL**：两条探针间隔 <20s 会触发引擎串行锁互杀（第二条排队→auto-interrupt）。慢引擎（local-cerebellum 推理 97s 级）必须一条跑完再发下一条。
- 永久题图：`C:\D\opt\agents-to-feishu\team-artifacts\probe-ocr.png`（内容 CTI-PROBE-2026）。
- OCR 大小写波动正常（CTi vs CTI），主体一致即算过；回复里有诚实披露更好。
- 探针期间禁批量重启；看回包用 `logs/openakita-rt.log`（或对应 bot 日志）里 `[Session:...] Agent:` 行。

## "引擎卡死"排查速查（openakita 实例，2026-09-19 py-spy 实测改判）

- 🔴 **stderr 静默 ≠ 卡死**：任务完成后的 memory finalization（`Relational encoding` 之后）stderr 静默是常态；py-spy 7 连 dump 实测主循环全程 asyncio `_poll` idle，无阻塞。
- 🔴 **判死前必查飞书 DM 卡片**：`lark-cli im +chat-messages-list --chat-id <id> --as user`，卡片含完整回复（`updated: true`）= 已送达。2026-09-19 10:23 探针实为 33s 完成+送达（卡 om_…385da），此前「卡死 4 分钟」是只盯 rt.log 的误判。
- 桥 watchdog(5min) respawn 可能发生在任务成功之后——respawn ≠ 引擎卡死证据，先核对卡片。
- 真要抓引擎栈：`py-spy dump --pid <ACP引擎pid>`（pid 从 rt.log `ACP spawned pid=` 取；对活进程直接可用，无需提权）。
