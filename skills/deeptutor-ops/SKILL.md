---
name: deeptutor-ops
description: DeepTutor 本地源码部署的运维方法论——官方升级流程、新增搜索/媒体 provider、shim 桥接本机基建、catalog 写回坑、官方诊断验证。适用于 C:\D\opt\deeptutor（v1.6.3+，含本地补丁基线）。
version: 1.0.0
---

# DeepTutor 本地运维（C:\D\opt\deeptutor）

源码装（git clone HKUDS/DeepTutor）+ nssm 服务 `deeptutor`（.venv\Scripts\deeptutor.exe start，拉起后端 :8001 + 前端 :3782）。仓库带本地补丁基线（tag `baseline-*`，git user 已配 oadank）。

## 官方升级流程（已验证可复用）

1. **基线**：本地补丁 `git commit` + `git tag baseline-<ver>-patched` + **`git push fork main --tags`**（2026-09-02 起有云端备份：remote `fork` = 私有仓库 github.com/oadank/deeptutor；origin 仍指官方 HKUDS/DeepTutor 仅用于 fetch 升级，无推送权）+ `git bundle create C:/D/opt/backup/...bundle --all`（260MB 全量，可整体还原）
2. `git fetch origin --tags` → `git merge v<新版本>` → 解冲突（本地补丁点见下）
3. `nssm stop deeptutor` 后 `pip install -e .`（**服务运行时必失败：deeptutor.exe 被锁**）；web `npm ci --legacy-peer-deps`
4. `nssm start` → launcher 按源码 fingerprint 自动 rebuild 前端（1-2 分钟，standalone dist `.next-deeptutor`，不是 web/.next）
5. 验证：`GET /api/settings/catalog`、各服务官方诊断端点（见下）、设置页

## 本地补丁清单（升级后逐项核对）

| 补丁 | 位置 | 备注 |
|---|---|---|
| anysearch 搜索 provider | `services/search/providers/anysearch.py` + `providers/__init__.py`×2 + `config/provider_runtime.py` SEARCH_PROVIDERS | spec 表必须先有行，装饰器查不到 spec 会**静默不注册** |
| subagent options 去重 | `web/lib/subagents-api.ts` getBackendOptions inflight promise | 防 9 编辑器并发压垮（Failed to fetch 根因） |
| markitdown 视觉描述 | `services/parsing/engines/markitdown/engine.py` | 接 Ollama qwen3-vl:4b-instruct（11434/v1），开关真生效 |
| i18n 缺失键全量补齐（2026-09-02） | `web/locales/{en,zh}/app.json` | ~139 键（人格选择器/KB 源/Books 摘录/可视化面板等）；commit ad7d45c5 |
| 人格/技能名支持中文（2026-09-02） | `deeptutor/services/persona/service.py` `_NAME_RE` + `web/lib/skill-slug.ts`（PATTERN/RE/slugify）+ `web/tests/skill-slug.test.ts` | 正则加 `\u4e00-\u9fff`；commit c86538f9；基线 tag `baseline-v1.6.3-patched` |
| fcntl Windows 垫片 | `.venv/Lib/site-packages/fcntl.py` | 不在仓库，git pull 无影响，但重装 venv 会丢 |

## 新增媒体能力 = shim 桥 + catalog

- **videogen-shim**（nssm `videogen-shim`，:18850，`C:\D\opt\videogen-shim\`）：单进程双能力——`/contents/generations/tasks`（async_task 约定，模型分流 minimax-h3→8090 /video、agnes-video→N5105:8081）+ `/v1/images/generations`（OpenAI Images 兼容 → 8090 /generate，model 映射模板 z-image/Krea2）。改代码必须 `nssm restart videogen-shim`。
- 8090 控制台接口：`POST /video {prompt,duration,aspect}` 与 `POST /generate {prompt,width,height,template}` 都是**同步阻塞**（含 XDN 米家开机 300s），返回 `{ok, file:本地绝对路径}`；`GET /output/...` 与任务表 `/tasks`。
- catalog 加 profile/model 后 **必须 `nssm restart deeptutor`**：后端内存持有 catalog，某些操作写回文件，**直接改 JSON 不重启会被冲掉**。真相以 `GET /api/settings/catalog` 为准。

## 官方诊断验证（每次改动后跑）

`POST /api/{settings,document-parsing} 的 tests/{service}/start`（无 body 用当前配置）→ `GET .../tests/{service}/{run_id}/events`（SSE）。注意：**videogen/imagegen 诊断提交探针即报成功不等渲染**（会真实产生一次生成）。路由 v1.6.3 起是 `/api/...`（旧 `/api/v1/` 404）。

## 其他坑

- 官方诊断探针会真实渲染一段视频/图（billable），不是纯连通性检查
- pip 装包前先 `nssm stop deeptutor`（exe 锁）；装完 start（launcher 自动 rebuild 前端）
- 前端"Failed to fetch"排查顺序：先 curl 直连 8001/代理 3782 → 都通就是浏览器侧（缓存旧 chunk/Clash 系统代理/多编辑器并发）→ F12 Network 拿失败请求 URL 是唯一铁证
- XDN 需要时由米家开机卡唤醒（🔴 **没有空闲自动关机**——该任务从未设置过）：首次视频生成含米家开机，冷启动 5-8 分钟属正常；`/power_on` 可主动触发

## 语音全家桶架构（2026-09-02 定型）

- **TTS 网关**：`C:\D\opt\scripts\tts-openai-compat.mjs`（nssm `tts-openai-compat`，:18793，OpenAI /v1/audio/speech 兼容）。model id → 引擎：edge/local(MeloTTS :18792)/xiaomi/wangwang/voiceclone(小米克隆,默认小团团样本)/voicedesign(描述定制)/audio8(本地克隆 :18795)。配置单一真源 `C:\Users\oadan\.agents-to-feishu\config-store.json` speech.tts。
- **TTS wrapper 已独立**：`C:\D\opt\tts-wrapper\`（tts-wrapper.mjs + edge-tts.mjs + 自带 ws），agents-to-im 依赖解除。导出 `synthesize(text, {channel, provider})`。
- **edge 30s 超时双因**：微软时段性故障（会自愈）+ DeepTutor 发 OpenAI 默认 voice=alloy → 网关 edge 分支已加 Neural 命名白名单回退 zh-CN-XiaoxiaoNeural。默认引擎 catalog tts active_model（当前 edge；不稳时切 tts-model-local）。
- **STT**：`C:\D\opt\asr-service\asr-service.mjs`（18790，sherpa 只吃 WAV）——浏览器 webm/opus 已加 ffmpeg 预转 16k PCM（FFMPEG_BIN env）；asr-openai-compat（18791）转发。
- **audio8**（nssm `audio8-tts`，:18795，本地 onnx 克隆）：`POST /synthesize {text, voice?}` → wav；长文本已切句（≤90 字/段拼接，170 字≈76s）。音色库 `voices/`（xiaotuantuan）。
- **DeepTutor 语音横幅**：用户录音经 useVoiceRecorder onClip 回调 → onAddFiles 附件链（🎤 横幅回放原声）；AI 回语音用 TtsSpeakTool（口语化强制：工具描述禁止照抄正文/代码）→ 🔊 Voice reply 横幅。互斥=pauseOtherAudio 全局管理器（ChatMessageList.tsx，横幅 onPlay + 喇叭 new Audio 双入口）。
- 喇叭朗读/录音的诊断顺序：`tail C:/D/opt/scripts/tts-openai-compat-stderr.log`（"[TTS-微软] 失败: 消息处理超时"=微软接口不可达；fallback 自动落 MeloTTS）。

## 补丁/改造实操坑（2026-09-02 下午集）

- **deeptutor web 源文件是 CRLF**：python 多行 replace 必须 io.open 默认通用换行读（CRLF→LF 才匹配），写 newline="\n"；heredoc（`<<'EOF'`）传含 `\n` 字面正则的 python 补丁会把 `\n` 展开成真换行**毁掉目标文件**——复杂补丁一律 Write 工具写脚本文件再执行
- **nssm get 输出是 UTF-16LE**：python subprocess 读后必须 `decode('utf-16-le')`，直接 split(b'\x00') 会按字符切碎
- **改完必须验证真的编译进产物**：`ls -la web/.next-deeptutor/BUILD_ID`（mtime 晚于改动）+ `grep -rl "改动特征串" web/.next-deeptutor/standalone/.next-deeptutor/static/chunks/`——别让老大拿旧 bundle 测试
- **deeptutor 服务 PATH 快照缺 python** → 沙箱 exec "系统找不到指定的文件"：`nssm set deeptutor AppEnvironmentExtra` 重写三值（PATH 补 Python312+Scripts+WinGet Links / DEEPTUTOR_HOME / PYTHONUTF8=1）
- **编辑/删除按钮 v1.6.3 自带**（用户消息 hover 铅笔=分支编辑、assistant hover 删 turn）——hover 才显示（opacity-0 group-hover）

## 前端 i18n / Personas（2026-09-02 实测）

- i18n：i18next，`web/i18n/init.ts` **keySeparator:false → 所有键是扁平英文字符串**（组件里 `t("New persona")` 用英文原句当键）。语言包 `web/locales/{en,zh}/app.json`，2 空格缩进扁平 JSON。缺键回显原始键（如 `personas.count.suffix`）。补键后必须重建（restart deeptutor 自动 rebuild）。
- Personas（学习空间人格预设）**不是代码硬编码**：`data/user/workspace/personas/<name>/PERSONA.md`，YAML frontmatter `name`+`description`（UI 显示用）+ Markdown body（注入 system prompt）。改 description 中文**即时生效不用重建**；`name` 有 `^[a-z0-9][a-z0-9-]{0,63}$` slug 校验必须 ASCII。
- 重建验证法：`grep -rl "中文串" web/.next-deeptutor --include="*.js"` 有命中 = 重建吃到了改动。

## Turn 运行时 / ask_user / 孤儿清扫（2026-09-03 实测）

- **WS E2E 测试**：`ws://127.0.0.1:8001/ws`，**入站帧必须带 `protocol_version: "2.0"`**（出站服务端自动补，漏了回 protocol_error）；python `websockets` 包已装 .venv（node ws 库会握手挂起，别用）。
- **自动化测试会污染会话列表**：不带 session_id 的 start_turn 会新建会话（且每次连接可能是新 store 作用域，标题还会被 LLM 自动起好，看起来像真人聊天）。**测完必须清理**：按首条消息内容匹配找出测试会话 → 经老大确认后删除。查会话用 `SELECT id,title,updated_at FROM sessions ORDER BY updated_at DESC` + 各会话首条 user 消息签名。
- **ask_user 链路**：模型调 ask_user → turn 转 `waiting_input`（reply_queue 在**内存**）→ 前端 `submit_user_reply` WS 命令唤醒。**等待期 tool_result 事件不落库**（turn_events 0 条）→ 反问卡片只有刷新重放才见。服务重启=等待 turn 变孤儿（DB 状态不动）。
- **孤儿 turn = 会话永久卡死的根因**：重启后 DB 还挂 running/waiting_input，前端+看门狗全信 DB → 永远显示运行中。修复三件套（全部已 commit）：①request_preparer 撞租约且 active turn 是 waiting_input → 文本按 submit_user_reply 走 reply 队列唤醒（打字即答复）；②启动孤儿清扫（turn_runtime.get_turn_runtime_manager 首建实例时把 list_nonterminal_turns 全部 transition 成 cancelled，按 store 作用域自愈）；③前端看门狗（ChatStateAdapter 20s 轮询 `GET /api/sessions/{id}/active-turn`，activeTurnId 不在列表 → STREAM_END）。
- **WS 断开 ≠ 取消**：unified_ws finally 只停订阅，turn 服务端继续跑。"取消"只可能来自前端停止按钮（cancel_turn WS 命令）。
- **智能体（subagent）选择**：聊天可选 = 有 `type:subagent` KB 指针（POST `/api/subagents/connections`，name+agent_kind+cwd），**「我的智能体」页检测到 ≠ 已连接**。选中后 turn 锁定 consult_subagent 工具：主模型当主持人转问真实 CLI（跑在 cwd），答完自己总结回复；不选=纯主模型。
- **能力菜单（CapMenuItem）**：label/description 都走 `t()`；能力=静态 `CHAT_CAPABILITIES`（presentation.tsx）+ 后端 manifests 合并（`mergeCapabilityPresentations` 对未知能力露 manifest 英文原文）→ 后端动态注册的能力必须补静态条目+locale 键，否则露英文 id。
- **会话标题语言**：title_service 按 ui_language 切 zh/en 提示词；executor 读 payload.language 缺省曾是 "en" → 已 patch 回退读 `get_ui_settings().language`。标题只在 "New conversation" 哨兵态生成一次。

## 语音链路（2026-09-02/03 血泪）

- **判据：附件文件名决定"哪条链路在生效"**——`speech.mp3` = 模型自己调 tts_speak 工具；`voice-reply*.mp3` = 后端兜底。二者互斥互补（模型发了就跳过兜底，没发兜底补一个），**同一条回复只允许一个音频**（否则界面出两个横幅）。
- **后端兜底落盘必须用 tool 同款路径**：`_run_dir(None,"tts")` → `media_gen/media/tts_<hex>/` + `_write_media()`。曾把文件写到 `media_gen/tts/` → `collect_public_artifacts` 扫不到 → 附件被静默丢弃（磁盘上留孤儿 mp3、消息里 0 引用，表现就是"说发了其实没发"）。**改完必须验证到"消息上真有附件"，不能只看文件生成了。**
- **⚠️ 附件必须带 `generated: True` 才会被渲染**：前端 `mergeGeneratedFiles()`（web/components/common/InlineFileCard.tsx）只渲染 `attachments.filter(a => a.generated)`。后端自己往消息挂的附件（语音兜底等）漏了这个标记 → 文件生成了、URL 能下载、附件也在消息里，但**界面上一个横幅都画不出来**。历史数据要 SQL 回补该字段。
- **验证渲染的替代法**（浏览器起不来时）：用真实数据复刻前端过滤逻辑跑一遍——`GET /api/sessions` → 逐会话 `GET /api/sessions/{id}` → 对 assistant 消息跑 `attachments.filter(a => a.generated && a.mime_type.startsWith('audio/') && a.url)`，非空即证明会渲染。比口头"修好了"可靠。
- **新增 TTS/语音引擎后必须用"内容指纹"验证真路由**（mime 从 audio/mpeg 变 audio/wav 才说明真到了新引擎）——HTTP 200+有音频不等于走对了引擎（踩过：分支判断放在默认引擎之后，静默落回 MeloTTS 女声）。
- TTS 网关（:18793）model → edge/local/xiaomi/wangwang/voiceclone/voicedesign/audio8；**edge 对非法音色名（如 OpenAI 的 alloy）会挂起不回数据**（30s 超时）→ 网关做 Neural 命名白名单回退。edge 走 Clash 代理（服务 env `EDGE_PROXY=http://127.0.0.1:7897`）更稳。
- STT：浏览器录音是 **webm/opus**，sherpa-onnx 只吃 WAV → 18790 加 ffmpeg 预转 16k 单声道（否则"录音没反应"）。
- 语音横幅：`ChatMessageList` 的 VoiceBanner（宽度随秒数伸缩、transcript 内嵌+复制、全局互斥 `pauseOtherAudio` 覆盖喇叭 `new Audio()` 与横幅 `<audio>`）。
- **人格机制**：`GET /api/personas` 列出 workspace/personas 下所有目录名；人格创建=建目录+写 PERSONA.md（frontmatter name/description + 正文）。全局默认人格=前端 ChatStateAdapter `personaSelection` 初始值（local patch 已设「暴躁老青鱼」）；课程级 `course.default_persona` 优先于全局；会话内切换存 session.preferences。**英文人格复活根因=`seed_presets()` 启动补种（deeptutor/services/setup/init.py）——已 local patch 禁用**。
- **会话标题语言**：`title_service.py` 按 `ui_language` 切 zh/en 提示词；executor 读 `payload.language` 缺省曾为 "en"（前端常缺字段 → 中文界面出英文标题）——已 local patch 回退读 `get_ui_settings().language`。标题只在 "New conversation" 哨兵态生成一次，已有标题不重算。
