---
slug: all-platform-video-extract
displayName: all-platform-video-extract
version: 2.1.0
summary: 解析 1000+ 视频平台链接，获取标题、封面、各清晰度下载直链。
license: MIT
name: all-platform-video-extract
description: 解析 1000+ 视频平台的视频链接（抖音/快手/B站/YouTube/TikTok/小红书/微博等），获取标题、封面、各清晰度下载直链。当用户提供视频分享文本或视频 URL 想提取下载链接时触发。
agent_created: true
links: GitHub https://github.com/engrecho/all-platform-video-extract

---

# all-platform-video-extract

解析视频分享文本或 URL，获取标题、封面、下载直链。支持抖音、快手、B站、YouTube、TikTok、小红书等 1000+ 平台。

## When To Use

- 用户给出视频分享文本或视频 URL，想获取视频信息（标题、封面、下载链接等）
- 用户想把视频下载到本地

不触发：youtube-dl/yt-dlp 类通用下载需求、本地视频文件处理。

## 首次加载：初始化配置

当本 Skill 首次被使用时（检测到 `~/.extract_video_config.json` 不存在），**必须**执行以下初始化流程，一次性询问三项配置：

1. 询问用户：「视频下载保存到哪个目录？默认是 `~/extract_video`，是否需要修改？」
2. 如果用户明确给出目录，使用用户指定的目录；如果用户说「不用改」「默认就行」「可以」等未明确修改的回复，使用 `~/extract_video`
3. 询问用户：「多视频同时下载时，最大并行几个？默认 3，是否需要修改？」
4. 如果用户明确给出数字，使用用户指定的值；否则使用默认值 `3`
5. 询问用户：「每个视频之间的下载间隔多少秒？默认 3 秒，是否需要修改？」
6. 如果用户明确给出数字，使用用户指定的值；否则使用默认值 `3`
7. 将最终配置写入配置文件：

```bash
cat > ~/.extract_video_config.json << 'EOF'
{
  "outputDir": "~/extract_video",
  "maxParallel": 3,
  "downloadInterval": 3
}
EOF
```

（根据用户的选择替换对应值）

8. 后续所有下载操作都从该配置文件读取配置，不再重复询问

**检测配置是否已存在：**

```bash
cat ~/.extract_video_config.json 2>/dev/null
```

如果输出有效 JSON 则跳过初始化；如果报错或文件不存在，则执行上述初始化流程。

配置文件字段说明：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `outputDir` | string | `~/extract_video` | 视频下载保存目录 |
| `maxParallel` | number | `3` | 多视频同时下载的最大并行数 |
| `downloadInterval` | number | `3` | 每个视频之间的启动间隔（秒） |

## Quick Start

```bash
# 仅解析（获取链接）
node scripts/video_extract.cjs "<视频分享文本或URL>"

# 下载到本地
node scripts/download_videos.cjs "<视频分享文本或URL>"
```

## Workflow

### Step 1: 检查配置文件

每次下载前，先检查 `~/.extract_video_config.json` 是否存在：

```bash
cat ~/.extract_video_config.json 2>/dev/null
```

- 如果不存在或无效 → 执行「首次加载：初始化配置」流程
- 如果存在 → 从中读取 `outputDir`、`maxParallel`、`downloadInterval` 作为下载配置

### Step 2: 识别输入

从用户消息中提取视频链接或分享文本。抖音/快手分享文本需整段传入，不要只提取 URL。

### Step 3: 判断行为模式

- **仅获取信息**：用户说"解析"、"看看"、"获取链接"等 → 调用 `video_extract.cjs`，呈现结果
- **下载到本地**：用户说"下载"、"保存"等 → 调用 `download_videos.cjs`

### Step 4: 执行脚本

```bash
node scripts/video_extract.cjs "<分享文本或URL>"
```

脚本超时 60 秒，解析通常 3~15 秒。

### Step 5: 处理结果

- **code=200**：解析成功，提取各清晰度下载链接
- **code=530**：公钥过期（约 5 分钟有效），重跑即可
- **超时/网络错误**：间隔几秒重试

### Step 6: 呈现结果

- 下载链接必须**完整输出**，不得截断
- 多清晰度按从高到低排列
- 提醒用户链接有时效性，尽早下载

### Step 7: 下载（仅模式 B）

```bash
# 单个
node scripts/download_videos.cjs "<分享文本或URL>"

# 多个
node scripts/download_videos.cjs "<链接1>" "<链接2>" "<链接3>"

# 从文件读
node scripts/download_videos.cjs urls.txt
```

**多任务并行限制（从配置文件读取）：**
- 最大并行数：默认 3（可由用户在配置文件中修改 `maxParallel`）
- 下载间隔：默认 3 秒（可由用户在配置文件中修改 `downloadInterval`）
- 脚本自动从 `~/.extract_video_config.json` 读取这两个值

下载目录结构：`<输出根目录>/<平台>-<vid>-<标题>/`，含 video.mp4、cover、images、content.md（公众号）。

## Notes

- 链接完整性：呈现任何 URL 时必须完整输出，不得省略
- 链接时效性：下载链接通常几小时有效，解析成功后建议立即下载
- B 站下载需加 `Referer: https://www.bilibili.com` 头，脚本已自动处理
- 配置文件路径：`~/.extract_video_config.json`，记录用户选择的下载目录、最大并行数、下载间隔

---

## 本机补充（oadan 机器 · 2026-09-19 由 DSH 添加；重新下载官方包会覆盖掉此段，务必保留）

### 1. 配置已写好 → **跳过**上面「首次加载：初始化配置」的三连问

`C:\Users\oadan\.extract_video_config.json`：

```json
{ "outputDir": "C:\\D\\opt\\extract_video", "maxParallel": 3, "downloadInterval": 3 }
```

不要再问用户，直接用；要改存放目录只改这个文件。

### 2. 已修的两个原包缺陷（Windows 专属）

| 位置 | 原问题 | 现状 |
|---|---|---|
| `download_videos.cjs` 顶部 `NODE_BIN` | 用 Linux 的 `which node` 找解释器，本机它返回一个系统认不出的路径 → 子进程起不来（ENOENT），**自动下载 100% 崩** | 改成问 Node 自己"你在哪"（`process.execPath`），仍可用环境变量 `GV_NODE` 覆盖 |
| `download_videos.cjs` `dirName()` | 目录名里 `host`/`vid` 直接来自对方接口且未过滤，理论上能往输出目录之外写文件 | 加了字符白名单 `safeToken()` |

原版备份：`%TEMP%\download_videos.cjs.orig`。**若重装官方包，这两处会退回坏状态，必须重打。**

### 3. 本机是「双引擎」，按场景选

| 引擎 | 入口 | 本质 | 什么时候用 |
|---|---|---|---|
| **远端（本 skill）** | `node scripts/video_extract.cjs` | 逆向调用在线站 `greenvideo.cc`，解析逻辑在**对方服务器上** | 抖音/快手**分享口令**长文本、小红书这类难搞链接；本地引擎失败时当备胎 |
| **本地（yt-dlp）** | `C:\D\opt\tools\yt-dlp\yt-dlp.exe` | 解析逻辑**全在你机器上**，不经过任何中转站。实测 v2026.08.19，内置 **1752** 个站点 | B站/YouTube/TikTok/微博等常规链接首选；不想让陌生服务器看见你的链接时用 |

🔴 **2026-09-19 实测分工（同一条抖音链接两边跑）**：
- 抖音分享口令（`v.douyin.com` 短链）→ **远端 skill 一次成功**：8.2 秒拿到 720p 带声成片（ffprobe 实测 h264 1280×720 + aac，288 秒）。**抖音、快手一律走远端。**
- 同一链接给本地 yt-dlp → 短链跳转正常，但取详情常报 **"Fresh cookies are needed"**：这是**抖音风控随机抽奖**，不是"缺登录态"——2026-09-21 实测带完整 Cookie 也只有约 2/3 成功率，`--cookies-from-browser` 读出来的 cookie 一样随机。**本地引擎别用来碰抖音（除非只想赌运气），正式产出走③浏览器抓流。**
- 分享文本**整段传给远端脚本**（前面那些 `1.07 QkC:/` 噪声字符它会自己挑出链接），别自己截 URL。

本地引擎命令模板（**该目录不在 PATH，必须写全路径**；ffmpeg 已在 PATH，能合并高清晰度）：

> 🔵 **存放目录已被配置文件钉死**：`C:\D\opt\tools\yt-dlp\yt-dlp.conf`（与 exe 同目录，自动加载）里写了 `--paths C:/D/opt/extract_video`。所以**不管在哪个目录跑、加不加 `-o`，视频都落到 `C:\D\opt\extract_video\`**，不用再操心路径。

```powershell
# 只看信息不下载
& 'C:\D\opt\tools\yt-dlp\yt-dlp.exe' -J "<URL>"

# 直接下载（路径由 yt-dlp.conf 决定，不用写 -o）
& 'C:\D\opt\tools\yt-dlp\yt-dlp.exe' "<URL>"

# 引擎自更新（平台防护签名会变，解析失效先跑这个）
& 'C:\D\opt\tools\yt-dlp\yt-dlp.exe' -U
# 直连不通时先设代理再跑： $env:HTTPS_PROXY='http://127.0.0.1:7897'
```

⚠️ **改 `yt-dlp.conf` 前必读，两个本机实测坑**：
1. **只能用正斜杠**。配置文件里反斜杠是转义符，写成 `C:\D\opt\...` 会被啃成 `C:Dopt...`，路径当场作废（实测 `[debug] Portable config` 里可见）。
2. **只能纯 ASCII**。exe 按系统编码（中文 Windows = cp936/GBK）读该文件，写中文注释会直接解析失败、程序以退出码 2 罢工。

---

## 🔴🔴 2026-09-19 追加实测：抖音有**第三条路**，上面那句"抖音一律走远端"要打补丁

| 路线 | 抖音 | 实测结论 |
|---|---|---|
| ① 远端 skill（greenvideo.cc） | ✅ 8.2 秒出片 720p 带声 | 能用；代价=链接明文过别人服务器，且依赖对方不挂 |
| ② 本地 yt-dlp 直解 | ⚠️ **不可依赖，别进流水线**（2026-09-21 复核，归因已更正） | 不是"必然 403"：带完整 Cookie 实测 **9 成 4 败（约 2/3 成功率）**，是**抖音随机风控**抽奖，不是签名必然算不出。yt-dlp 源码 `DouyinIE` 只调 1 个接口（`aweme/v1/web/aweme/detail/`），旁边自带 `# TODO: Run verification challenge code to generate signature cookies`——**官方自己也没实现挑战码**，"Fresh cookies are needed" 是它的兜底文案。成功时出 **6 档**（h264/h265 各档 + 水印下载档），最高 **1280×720**。详见文末「2026-09-21 yt-dlp 复核实测」节 |
| ③ **浏览器当解析器 + 本地抓流** | ✅ **成功出片** | `node sniff_download.mjs "<视频URL>"`：让已登录的专用 Edge 自己去播（签名它算好了），CDP 监听网络响应抓到真实媒体地址，本地下载，DASH 分离的音视频用 ffmpeg 合流。实测 h264 1024×576 + aac / 288 秒 |

**第三条路的配套（本机已全部跑通，都在 `C:\D\opt\tools\yt-dlp\`）**：

- 专用 Edge：**必须开在 session 1 用户桌面**（用 win-desktop-helper 的 `app_run` 启动）。session 0 的隐形实例会导致抖音二维码加载失败（实测服务端只会发出纯色灰块）。参数 `--remote-debugging-port=9401 --user-data-dir=...\edge-video-profile`，端口记在 `cdp.port`
- `cdp_tool.mjs`：`state`/`click`/`clickxy`/`type`/`drag`(滑块)/`key`/`shot`/`waitlogin` —— 真鼠标真键盘事件，不是改 DOM 糊弄
- `qr_server.mjs`：本机 `http://127.0.0.1:8899/` 二维码**每 10 秒自动刷新**，终结"人工接力跑不赢 2~3 分钟时效"的死循环；自动等登录→导 Cookie→**调 `sniff_download.mjs` 抓流下载**（🔴 2026-09-21 起改的：原来走 `yt-dlp --cookies` 直解只有约 2/3 成功率，已换掉）。🔴 想保住进行中的短信/二次验证流程必须带 `SKIP_OPEN=1`，否则它会导航把流程冲掉
- 抖音短信登录后常见**「新设备二次验证」**（手机刷脸 / 原设备扫码）：**刷脸任何工具都过不去**，选「使用原设备扫码」，用手机端已登录的抖音来扫
- 表单填写坑：手机号会被显示成 `150 3593 4590`（3-4-4 加空格），**校验必须 `-replace '\D',''` 只比数字**，否则会把成功当失败
- 🔒 凭证：`cookies.txt` 与 `edge-video-profile` 已 `icacls /inheritance:r` 锁成仅 `LECOO\oadan` 可访问，**禁止同步/上传/入库**（`cookies.txt` 2026-09-21 起仅供留档/碰运气 —— 抓流下载不依赖它，只有 yt-dlp 直解才要）
- 已知瑕疵：抓流拿到的是浏览器当时选择的码率（本次 576p < 远端 720p）。要高画质先在播放器里切清晰度再抓
- 产物：`C:\D\opt\extract_video\`；同一条视频别两边都跑一遍，白占空间（远端 `douyin-<vid>-<标题>\`，本地 `local-sniff-*.mp4` + 两个合流前的中间文件）

🔴 **"离线"的真实含义只能是"不依赖第三方中转服务器"**：yt-dlp 仍需联网去平台取视频；不存在把在线站功能破解成本地永久可用的东西——解析逻辑在服务端，客户端拿到的只是加密信封，拆烂信封也变不出发动机。
🔴 **隐私**：走远端 skill 时，你要下的链接会明文经过 `greenvideo.cc`。敏感内容一律走本地引擎。

## 🔴 2026-09-19 输出目录变更 + 高质量流水线（现行口径）

**输出目录从 `C:\D\opt\extract_video\` 迁到 `C:\Users\oadan\Videos\VideoExtract\<视频标题>\`**（`C:\D\opt` 是程序与临时产物区，媒体该进用户媒体库）。已同步改的三处，漏一处就会两边分叉：
1. `C:\Users\oadan\.extract_video_config.json` 的 `outputDir`（远端解析引擎的下载脚本读它）
2. `C:\D\opt\tools\yt-dlp\yt-dlp.conf` 的 `--paths`（必须纯 ASCII + 正斜杠，中文会被 GBK 解码搞坏 —— 目录名因此用英文）
3. `sniff_download.mjs` 的 `OUT_ROOT`

**一条命令出三件套**：`node C:\D\opt\tools\yt-dlp\video_kb.mjs "<视频URL>" [子目录名]`
→ `video.mp4`（最高清晰度）+ `audio.m4a`（单独音频，喂转写）+ `transcript.飞书妙记.md`（逐字稿+关键词+AI总结）+ `info.json`（源链接/分辨率/时长/妙记链接）

**清晰度怎么选才对（血泪）**：不能只看网络响应里最大的那路（播放器只拉它当时选的，实测 576p）。真清单在页面 SSR 的 `window._ROUTER_DATA` 里，递归挖 width/height/bit_rate + play_addr.uri_list。**但那个清单混着推荐流几百条别人的视频**——第一次试跑就按"像素最高"下错成一条 26 秒 4K 竖屏，把正主覆盖了。所以必须双保险：
- 用 `<video>.duration` 当锚点，清单里时长对不上的直接踢掉
- 下载完再 ffprobe 复核真实时长，对不上就删除换下一路，最多试 12 路
修好后实测 576p → **1920x1080**（注意：抖音 1080p 这档给的是 **HEVC/h265**，Windows/Edge/PotPlayer 没问题，但要喂剪映或老设备可能吃力，需要兼容就退回 h264 那档）

**转写引擎定论（同一条 4分52秒视频实测对比）**（🔴 2026-09-21 作废——妙记烧老大配额，且"本地丢内容"根因已由 VAD 分段方案治好，现行口径看文末「VAD 转写定论」节，本段只当历史保留）：飞书妙记完胜——带标点、说话人、毫秒时间戳，技术词准确（`UTF-8 BOM`/`ANSI`/`glob`/`daily_batch`）；本机 SenseVoice 无标点且听成「u t f 八磅」「n c」「go」「一个会画」，**入库等于灌错字，降级为断网兜底**。lark-minutes 技能自己也明文写着"本地音视频转纪要优先走妙记，不要用 ffmpeg/whisper 本地转写"。
走妙记需要的 scope：`minutes:minutes.basic:read`（user 身份，设备码授权**一次性**，用过再开同一链接会报"请求不合法"，别被这个骗回去重新找人授权——用 `lark-cli auth status --json --verify` 看 `ready` 即已生效）。
另注：`minutes +detail` 会把逐字稿落在 **cwd 下的 `minutes\<token>\transcript.txt`**（只认相对路径），cwd 挑错就会在项目根目录长出一堆野文件。

### 2026-09-19 晚些时候补：清晰度判据再修三处（都是实跑翻出来的）

1. **时长容差不能卡死 1.6 秒**。同一条视频的不同转码档，容器时长会差几秒（实测播放锚点 340.38s，同片 1080p 探出 343.40s）。硬卡 1.6s 会**把正主的 1080p 全部误杀**，只剩播放器那一档 576p。现改为 `max(5s, 3%×时长)`；真·下错片（差几十上百秒）照样拦得住。
2. **"分辨率优先"必须按像素排，不能按字节排**。HEVC 高效，1080p 的 HEVC（7.7MB）比 720p 的 H.264（29.4MB）**字节更小**，按体积排会把高分辨率挤到后面。默认排序：像素 → 体积 → 码率。要 H.264 优先设 `PREFER_H264=1`。
3. **URL 路径里的 hvc1/avc1 标记能识别编码器，但不可靠**（实测把一路 HEVC 标成了 H.264）。所以"只列清单"时当参考，**最终一律以下载后 ffprobe 实测为准**——脚本里已这么做。
4. 打印分辨率要直接给 `宽x高`，别再用 `sqrt(像素)` 编个"某某p级"糊弄自己（曾把 1080p 显示成 1440p级）。
5. 实测产出：`两年大模型经验-被一个RAG混合检索问题干崩溃了` → **1920x1080 HEVC + 340.4s + audio.m4a + 飞书逐字稿**，一次跑通。

### 读抖音收藏/喜欢/主页清单（知识库入口）

`node C:\D\opt\tools\yt-dlp\douyin_collect.mjs <url> [滚动次数] [标签名]`
例：`node douyin_collect.mjs "https://www.douyin.com/user/self" 8 收藏`
→ 点标签后地址变成 `?showTab=favorite_collection`，脚本用 CDP 真实点击 + 滚动加载 + 抽 `a[href*="/video/"]`，输出 id/标题/链接清单。收藏与喜欢同理（标签名传 `喜欢`）。
⚠️ 抖音网页"作品/喜欢/收藏"三个 tab 都在 `user/self` 下，**不点就只读到默认的"作品"**（我第一次就读错了）。
⚠️ 收藏里老视频（一两年前的）预取地址签名普遍过期 → 批量时必须每条真开一次页面让抖音现场算签名，约 20 秒/条，并且限速、别上量（用的是本人登录态，风控代价是账号）。

## 🔴 2026-09-21 VAD 转写定论：长音频本地转写必须分段，禁止 :18790 整段吞（现行口径）

老大嫌本地 ASR 不准，根因查实：**SenseVoice 整段吞 >2 分钟音频会丢约四成内容**（583 秒视频只出 1992 字、英文工具名全灭、结尾整段消失）——不是听错，是没转。VAD 分段后 3708 字（+86%）、语音覆盖 98.3%、MoneyPrinterTurbo/MediaCrawler/Remotion/HyperFrames 等专名全捞回。

**一条命令出精修终稿**（目录含 audio.m4a 即可，跳过下载）：
```powershell
node C:\D\opt\asr-service\vad-transcribe.mjs "<视频目录>" "<标题(给精修当上下文)>"
# 精修默认 QW3.8F（litellm :4000），POLISH_MODEL 可换引擎。DV4F 已实测**不可用**：
# 3708 字精修灌成 37625 字复读水稿（2026-09-21），别再拿 ⚡ 提示词钮的 DV4F 战绩套这条链。
```
→ `transcript.本地ASR.md`（VAD raw → 大模型标点恢复+专名纠错）+ `.raw.txt` + `.vad分段.txt`（带时间戳）+ info.json 回填。全链实测约 3 分钟（转写仅 ~35 秒，RTF 0.04；精修 ~100 秒/块 ×4 块）。

**已验证事实（都是踩过才写的，别重新试错）**：
- silero VAD 模型：`C:\D\opt\sherpa-onnx\models\silero_vad.onnx`。**v5 就 629KB，别按"≥1MB 才像话"判死活**。缺了下载：`cmd /c gh release download asr-models -R k2-fsa/sherpa-onnx -p silero_vad.onnx -D <目录> --clobber`（gh 自写文件零转码；snakers4 仓库 contents/files 路径 404 不存在；裸 curl github 会被 dsh-api-gate 拦）。
- 分段参数用**默认 max-speech-duration=20s**：实测调 8s+阈值0.45 不涨专名反而把词切烂（`sscaleki`、`时0间成本`）。想当然调短=负优化。
- VAD 治"丢内容"，**不治英文专名**（MoneyPrinterTurbo 照样听成 many pretty trouble）→ 专名靠精修纠回。精修 prompt 带全片主题+专有名词表，铁律"不确定就保留原文别猜"。
- sherpa 二进制中文输出必须 **cmd 重定向落盘再按 UTF-8 读**，PowerShell 管道会吃字/加 BOM。
- 精修走 litellm :4000 **QW3.8F**（老大令：别烧 GwV4F 额度；DV4F 长文精修已实测翻车不可用）。⚠️ Node fetch/undici 有 300s headersTimeout 硬顶不可配，长请求会被掐死（UND_ERR_HEADERS_TIMEOUT）→ asr-polish 已改 node:http + 900s + 3 重试。
- 精修可单用：`ASR_RAW=<含{"text":...}的json路径> node C:\D\opt\asr-service\asr-polish.mjs <视频目录> <标题>`；`POLISH_OUT=xxx.md` 改输出名（试跑不覆盖正稿）。**别信 wrapper 打印的"终稿"文件名以外的一切中间输出。**
- 输出质量残留预期：`blackbo`/`HTTS` 一类冷门专名仍可能保原样（不猜是纪律不是偷懒）；模型偶发敬语"您"混入，交付前通读一眼。

**同日两条管线修复**：① `video_kb.mjs` 的 stripAds 在无标点 raw 稿上会把**全文当"一句广告"整删**（一词命中全文陪葬，实测逐字稿被掏空），已加 ">120 字巨块免疫" 守卫（备份 `%TEMP%\video_kb.mjs.bak-20260921`）；② nssm `asr` 服务 09/18 起跑的是旧代码（spawnSync 30s 超时），长音频必 ETIMEDOUT —— `nssm restart asr` 已加载 15min 版；该服务今后只当短语音兜底，**长音频一律走 vad-transcribe**。

## 🔴 2026-09-21 yt-dlp 复核实测（抖音归因更正 + 可吸收清单）

**结论先行**：yt-dlp 自带的抖音解析器是**半成品，不可依赖**；但它的工程设施值得吸收。完整研究细节见 openmem 条目 `11b50c2f`。

**实测（本机 nightly 2026.09.16，同一条抖音链接）**：

| 喂什么 | 结果 |
|---|---|
| 什么都不喂／只喂匿名 cookie（16 项：ttwid/s_v_web_id/__ac_nonce…）／喂全部**非登录** cookie（40 项） | **全失败** |
| 完整 `cookies.txt`（66 项含登录态） | ⚠️ **9 成 4 败（约 2/3）**；成功时出 **6 档**，最高 1280×720 |
| 完整 cookie + `--impersonate chrome` | **无稳定增益**（2/4，对照 3/4） |
| `--cookies-from-browser "edge:C:\D\opt\tools\yt-dlp\edge-video-profile"` | **能读**（102 条；Edge 开着也能读，yt-dlp 会复制 DB 绕锁）→ 旧说法"Windows 下永远失败"**作废**；但抖音照样随机 |

**为什么不能靠它**：`DouyinIE._real_extract` 只调 1 个接口（`aweme/v1/web/aweme/detail/`），旁边有 `# TODO: Run verification challenge code to generate signature cookies` —— **官方自己没实现抖音挑战码**，"Fresh cookies are needed" 只是兜底文案。所以**抖音继续走③浏览器抓流**。

**值得吸收的（按值排序）**：
1. **插件化**（`yt_dlp_plugins/extractor/*.py`，`--plugin-dirs`）：把③抓流封成 extractor，白捡它的下载管线（分片/并发/断点续传/限速/合流/去重/输出模板）
2. **JS 挑战解法形态**（EJS / JSC Provider）：外部求解脚本 + JS 运行时（deno/node/quickjs）+ 可插拔 provider —— 真要正面解 `a_bogus` 就照这个骨架做（Node 跑抖音 webmssdk.js，不开浏览器）
3. **`--cookies-from-browser`**：可替代 `qr_server.mjs` 里手工导 `cookies.txt` 的脆逻辑
4. **格式偏好排序**：它按 url_key 解编码/分辨率，**水印档 −2、API 来源 −1、自研 h266（bytevc2）标 UNPLAYABLE 且 −100**，并给媒体域注入 `sid_tt`（分片下载必需）→ 我们的抓流选择逻辑缺这几条
5. **测试基建**：每个 extractor 强制 `_TESTS`（URL + md5 + 预期报错）；我们那堆 mjs **零测试**
6. **`--impersonate`（curl_cffi）**：本机支持 Chrome/Edge/Safari 多目标；抖音上无效，留给别处裸请求备用

## 🔴 2026-09-21 新能力：yt-dlp 插件（抖音解析换成抓流后端）

**一句话**：抖音现在也能走 yt-dlp —— 下载/合流/断点续传/格式选择交给它，解析用我们的浏览器抓流。插件在 `C:\D\opt\tools\yt-dlp\plugins\douyin-browser\`（类 `DouyinBrowserIE`，`IE_NAME=douyin:browser`）。

```powershell
# 前置：专用 Edge 开在 9401 且已登录（见上方「第三条路」）
& 'C:\D\opt\tools\yt-dlp\yt-dlp.exe' --plugin-dirs 'C:\D\opt\tools\yt-dlp\plugins' "<抖音URL>"
```
实测 2026-09-21：`v.douyin.com/w2CD2pVwgws` → **1920x1080 hevc + aac / 288.17s / 5.53MB**，自动合流，一条命令出片。

**踩过的坑（全是实测）**：
- 插件目录结构必须是 `<插件根>/<项目名>/yt_dlp_plugins/extractor/*.py`，**少一层目录就静默不加载**（第一次就栽在这）
- `--list-extractors` **不列插件类** —— 别拿它判成败；要看 `-v` 日志里的 `[debug] Extractor Plugins:` 行
- 打包版 `yt-dlp.exe` **支持** Python 插件，不用装 pip 版
- 插件 extractor **优先于**内置 `DouyinIE`（同一 URL 被插件抢走）
- 格式 dict **必须带 `ext`**（视频 mp4 / 音频 m4a）：否则 yt-dlp 推成 `unknown_video`，ffmpeg 合流报 `Postprocessing: Error opening output files: Invalid argument`
- **音轨常常只存在于 CDP 网络响应里**（实测某次清单 34 路里音频 **0** 路），JSON 已补网络音频兜底；不补就会出现 `Downloading 1 format(s)` ＝ 下成纯视频**没声音**
- 解析后端 = `sniff_download.mjs` 的 `RESOLVE_JSON=1` 模式（吐一行 `__RESOLVE_JSON__{...}`）；**将来若上「Node 补环境跑 webmssdk 算签名」，只需改插件的 `_resolve_via_sniff`**，命令与下游用法一行都不用动
