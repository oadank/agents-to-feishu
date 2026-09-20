# 卡尾数据审计 · 2026-09-19（老大亲令，mimo 执行）

## 结论速览

| 判 | 家数 | bot |
|---|---|---|
| ✅ 真（引擎上报 cache，命中率有实义） | 5 | claude · codex · hermes · dsh · zcode |
| ✅ 真·但0%系兜底（引擎走 QW3.8F/litellm，根本不报 cache→记全miss，卡显0.00%"看着像全未命中"） | 5 | mimo · openakita · reasonix · openclaw · opencode |
| ⬜ 缺（卡尾该会话读不到数=空白，无独立源可显） | 2 | gemini · deeptutor |
| ❌ 编（卡显数字与 stats 实测矛盾） | 0 | — |

**核心判定：本轮无一家"编"。** 卡尾数字不是独立算出来的——`engine.ts` 的 `buildDivider` 直接 `readCacheStats(该chat的acpSessionId)` 逐字渲染 stats jsonl，显示层无第二数据源，物理上不具备"卡说一套 stats 说另一套"的条件。审计的卡值列因此用**渲染重放**（见方法）。真问题有两类，都不是造假：其一"0% 假象"（数据源限制），其二"会话错位空白"（gemini/deeptutor，缺）。

## 方法（含一处对老大拟单的修正）

1. **卡值来源修正**：原拟"对读 out.log 里卡片的百分比"不可行——实测 out.log 只记 divider 调试行（chat/sessionId/acpSessionId），**不落卡尾渲染值**；飞书侧 interactive 卡经 API 取回的是降级占位（"请升级客户端"），真实内容不可得。故卡值改为**确定性重放**：取该 bot 今日最后活跃 chat + rt.log 该 chat 末次 `handleIncoming` 时刻 + out.log 末条 divider 的 `acpSessionId`，用与 `readCacheStats` 完全相同口径回放到那一轮的 stats，即"卡此刻应显示的值"。
2. **实测值**：直读 `C:\Users\oadan\.dsh\<bot>-bot\stats\2026-09-19.jsonl` 原始记录（`source==='cli'` 且 `session` 前缀匹配该 acpSessionId）。
3. **兜底规则**（`stats.ts:60`）：usage 事件无 `cache_read`/`cache_write` 拆分时，把 `input` 全额记为 `cache_miss`→命中率恒 0%。litellm 中转的 QW3.8F 系引擎即踩此路。
4. contextLimit：各 bot 模型未配 contextWindow，一律回落默认 **1,000,000**。

## 逐家对账（卡值 = 重放｜实测 = stats 原始末轮 hit/miss）

格式：🎯命中率(末轮 lastRate)｜🟰本会话累计(avgRate)｜📚上下文%（tokens）。

| # | bot | 引擎/路由 | 卡值（重放） | 实测（stats 原始） | 结论 |
|---|---|---|---|---|---|
| 1 | **claude** | litellm→claude-model（报cache） | 🎯0% 🟰56.69% 📚16%(156K/1M) | sess 99ec8470 末轮 hit=0/miss=155813；当日13轮17次hit>0 | ✅真（末轮冷启无命中，累计56.69% 属实；156K 上下文真） |
| 2 | **codex** | codex-model（报cache） | 🎯100% 🟰100% 📚7%(72K) | sess 01a0b8f5 hit=33792/miss=0/1轮 | ✅真（满命中，末轮即全命中） |
| 3 | **mimo** | litellm→QW3.8F（不报cache） | 🎯0% 🟰0% 📚0%(1K) | sess ses_ 全18轮 hit=0/miss=input（兜底） | ✅真·0%系兜底（无cache拆分，非命中0） |
| 4 | **gemini** | litellm（62补拉）+ ACP usage | 卡尾**空白** | divider sess 9f71fae1 在当日10条 stats 中 0 匹配 | ⬜缺（会话id错位→该chat读不到，兜底补拉session对不上） |
| 5 | **hermes** | QW3.8F but 末轮报cache | 🎯100% 🟰100% 📚8%(80K) | sess ef3c21ca hit=38912/miss=0 | ✅真（有cache上报，满命中真实） |
| 6 | **openakita** | QW3.8F（不报cache） | 🎯0% 🟰0% 📚2%(15K) | sess ok-f1f4d hit=0/miss=15319 | ✅真·0%系兜底 |
| 7 | **reasonix** | QW3.8F（不报cache） | 🎯0% 🟰0% 📚29%(289K) | 12条全无 session（litellm补）→按全天0%；prompt 289K | ✅真·0%系兜底（289K 上下文是真·大户） |
| 8 | **openclaw** | QW3.8F（不报cache） | 🎯0% 🟰0% 📚6%(58K) | 13条无session，hit=0/miss=input | ✅真·0%系兜底 |
| 9 | **opencode** | QW3.8F（不报cache） | 🎯0% 🟰0% 📚0%(3K) | sess ses_f46e 2轮 hit=0/miss=30711,3487 | ✅真·0%系兜底 |
| 10 | **dsh** | dsh-acp→QW3.8F（报cache） | 🎯100% 🟰85.61% 📚8%(79K) | sess b7648232 末轮 hit=76800/miss=0；当日108/115 hit>0 | ✅真（累计85.61% 属实，末轮满命中） |
| 11 | **deeptutor** | — | 卡尾**空白** | 当日 0 条 stats、无 divider 行 | ⬜缺（该 bot 今日无 usage 落盘，无源可显） |
| 12 | **zcode** | zcode-acp（报cache） | 🎯100% 🟰100% 📚7%(71K) | sess sess_b79 hit=32256/miss=0；当日87/87 全命中 | ✅真 |

## 附注 / 建议（非本轮交付范围，供决策）

- **"0% 假象"可优化**：5 家 litellm/QW3.8F bot 卡尾恒显 🎯0.00%，易被老大/读者误读为"零命中=不省"。实为引擎未上报 cache 字段、被 `stats.ts:60` 兜底计全 miss。建议引擎无 cache 拆分时分母判 0→卡尾该段显示 `N/A` 或 `—` 而非 `0.00%`（改动小，仅 cards.ts/readCacheStats）。
- **gemini 会话错位**：其 usage 的 sessionId 与 litellm 补拉记录 session 字段不一致，致 divider 精确过滤后归零、卡尾空白。属数据一致性缺陷，值得单独排查（mimo 未擅自改，因老大本轮只要审计）。
- claude 表内 sess 99ec8470 = 今日票B 实弹会话（其 jsonl 已被移出引擎库留备份），stats 保留其当日命中率记录，与本审计无冲突。


---

## 补发轮·逐家台账（老大令：每核完一家即时落一行；卡值=首轮登记的渲染重放值，实测=本脚本现算 raw stats 逐格对账）

| bot | 卡上🎯/📚（重放登记） | stats实测🎯（末轮/全天） | stats实测📚 | 结论=真/缺/疑 |
|---|---|---|---|---|

| claude | 🎯0.00% 📚156K | 末轮🎯0.00%·全天88.10% | 📚156K（20条） | 真（数字与 stats 对账一致；当日17/20轮 hit>0） |
| codex | 🎯100.00% 📚72K | 末轮🎯100.00%·全天88.50% | 📚72K（103条） | 真（数字与 stats 对账一致；当日89/103轮 hit>0） |
| mimo | 🎯0.00% 📚1K | 末轮🎯0.00%·全天0.00% | 📚1K（19条） | 真*（0%系兜底：stats 全 hit=0 如实渲染，非矛盾） |
| gemini | （四格空白） | 末轮🎯0.00%·全天0.00% | 📚196K（10条） | 缺（四格全空=引擎不回传；stats 10条全 hit=0 印证） |
| hermes | 🎯100.00% 📚80K | 末轮🎯100.00%·全天96.99% | 📚80K（13条） | 真（数字与 stats 对账一致；当日11/13轮 hit>0） |
| openakita | 🎯0.00% 📚15K | 末轮🎯0.00%·全天0.00% | 📚15K（24条） | 真*（0%系兜底：stats 全 hit=0 如实渲染，非矛盾） |
| reasonix | 🎯0.00% 📚289K | 末轮🎯0.00%·全天0.00% | 📚289K（12条） | 真*（0%系兜底：stats 全 hit=0 如实渲染，非矛盾） |
| openclaw | 🎯0.00% 📚58K | 末轮🎯0.00%·全天0.00% | 📚58K（13条） | 真*（0%系兜底：stats 全 hit=0 如实渲染，非矛盾） |
| opencode | 🎯0.00% 📚3K | 末轮🎯0.00%·全天0.00% | 📚3K（20条） | 真*（0%系兜底：stats 全 hit=0 如实渲染，非矛盾） |
| dsh | 🎯100.00% 📚79K | 末轮🎯100.00%·全天89.80% | 📚79K（115条） | 真（数字与 stats 对账一致；当日108/115轮 hit>0） |
| deeptutor | （空白） | 无源 | 无源 | 缺（当日无 stats 落盘） |
| zcode | 🎯100.00% 📚71K | 末轮🎯100.00%·全天100.00% | 📚71K（87条） | 真（数字与 stats 对账一致；当日87/87轮 hit>0） |

**补发复核总计：真 5 + 真*(兜底0%) 5；缺 2；疑 0。** 对账口径：卡值（首轮登记）与 raw stats 现算逐格相符=10/10，两家缺均为无源空白（非矛盾）→ 无一"疑/编"。卡尾数据可信度总评：**可信**——显示层与 stats 同源直读、无第二数据源，造假物理不可行；唯一系统性问题是 5 家兜底 0% 建议改显 N/A（详见首轮附注）。

*口径注：本表"全天%"为该 bot 当日全部会话合并；首轮报告 🟰 列为卡片所在单会话(acpSessionId)累计（如 claude 单会话56.69% vs 全天88.10%、dsh 单会话85.61% vs 全天89.80%），口径不同、互不矛盾。卡上可见四格（🎯末轮%与📚K）与实测逐格相符。
