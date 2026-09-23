---
name: xdn-remote-ops
description: 远程操作/诊断家里的 Windows 机器（XDN=100.119.140.33 别名 cszg，RTX3080 20G 生图生视频；shlc=100.93.226.56；同一套账号密码）。触发词：XDN、3080 那台、cszg、shlc、远程显卡、显存被占、XDN 显存、生图机器、comfyui 远程、XDN 关机/开机、XDN 卡了、XDN 是什么版本、给某台机器配百度翻译、远程改 win-desktop-helper 配置、助手配置丢了、多机部署助手、给远程机器升级桌面助手、远程助手启不来、schtasks 起不来助手、助手进程反复消失。含：paramiko SSH 连法（密码从 nssm comfyui 服务现取）、GPU/显存/Ollama/ComfyUI 一体体检、远程改 helper 配置脚本、**远程部署新版 helper（换 exe + 切 agnes 远程识图 + 拉起 + OCR 端到端验证）**、WDDM 每进程显存拿不到的绕法、XDN「开机白占 8.9GB 显存」真因、helper 「更新不覆盖 / 卸载不再删配置」的机制、**单实例互斥与 schtasks 任务的 `/IT /RL HIGHEST` 铁律**。
agent_created: true
---

# XDN 远程运维

> XDN 是一台 **Windows** 机器（不是 Linux！），跑 powershell。**RTX3080 20G**，是生图/生视频的真实推理引擎；需要开关机时由本机米家开机卡控制。
> 🔴 **没有"空闲 20 分钟自动关机"这回事**（那只是最初构想，关机定时任务从未设置过）——完整说明与实测证据在 `comfyui-ops` 的「历史坑」一节，本技能不再重述，**勿据此假设机器会自动断、抢排期**。
> **分工（2026-09-23 收编时划定，避免同一件事两处各写一份）**：本机 8090 控制服务、工作流模板、米家开机卡代码结构 → 归 `comfyui-ops`；**远程登录 / 机器体检 / 显存归因 / 远程部署 win-desktop-helper / schtasks 拉起 / 直连 `:8000` 做运维诊断** → 归本技能。
> **详细地址/密码/端口不写在这里**，按下面方法现取。

## 一、怎么连（唯一可靠姿势）

⚠️ **Bash 原生 `ssh` 非交互不能输密码** → 必须走 Python `paramiko`（系统 Python 3.12 已装）。

凭据现取（**别问我，问 nssm**）：

```bash
# XDN_HOST / XDN_USER / XDN_PASS 都存在本机 comfyui 服务的环境变量里
nssm get comfyui AppEnvironmentExtra | tr -d '\0' | grep -E '^XDN_(HOST|USER|PORT|PASS)='
```

⚠️ `nssm get` 输出是 **UTF-16LE**，必须 `tr -d '\0'`；行尾可能带 `\r`，用前先 `sed 's/\r$//'`。
⚠️ 拿到的 password 只放进程环境变量，**不要写进文件、不要 echo 出来**。

## 二、一键体检

```bash
cd ~/.workbuddy/skills/xdn-remote-ops
eval "$(nssm get comfyui AppEnvironmentExtra 2>/dev/null | tr -d '\0' | grep -E '^XDN_(HOST|USER|PASS|PORT)=' | sed 's/\r$//' | sed 's/^/export /')"
export XDN_HOST XDN_USER XDN_PASS XDN_PORT
"C:/Users/oadan/AppData/Local/Programs/Python/Python312/python.exe" probe.py
```

`probe.py` 一次跑完：开机时长 / GPU 概况 / 每进程显存 / Ollama 加载了什么 / ComfyUI 状态与队列 / helper 预热痕迹。

自定义命令：`python probe.py "nvidia-smi" "ollama ps"`

## 三、⚠️ 关键坑

1. **WDDM 模式下 `nvidia-smi` 的每进程显存全是 `N/A`**（本机就是 WDDM）。要定量必须换 Windows 性能计数器：
   ```
   Get-Counter '\GPU Process Memory(*)\Dedicated Usage'
   ```
   实例名里第 2 段是 pid，`(Get-Process -Id $pid).ProcessName` 换进程名。
2. **Ollama 的环境变量不在 powershell 里**（它是桌面 App 启的），只在 **llama-server 自己的进程命令行** 和 `%LOCALAPPDATA%\Ollama\server.log` 的 `msg="server config" env="map[...]"` 那行里能看到（`OLLAMA_KEEP_ALIVE` / `OLLAMA_CONTEXT_LENGTH` / `OLLAMA_MODELS` 全在这行）。查运行参数就 `Get-CimInstance Win32_Process | ? {$_.CommandLine -match 'ollama'}`。
3. **Ollama 日志在 `C:\Users\oadan\AppData\Local\Ollama\server.log`**，含 `[GIN] ... POST "/api/generate"` 记录（**带客户端 IP**，可判断是本机还是远程调用者）。
4. Ollama 在 XDN 上**不是 Windows 服务**，是启动文件夹里的 `Ollama.lnk`；`Get-CimInstance Win32_Service` 里查不到。

## 四、🔴 已知问题：刚开机就白占 ~8.9GB 显存（2026-09-12 定位）

**现象**：XDN 开机几分钟，`nvidia-smi` 就显示 ~10.4G / 20.5G 被占，`ollama ps` 显示 `qwen3-vl:4b-instruct 7.9GB 100% GPU ... until +52min`。

**真因（不是 bug，是设计）**：XDN 的 `HKCU\Run` 里有 **`shot-service`（win-desktop-helper）** 自启；它启动时会调 `OcrWarmup()`（`shot-service.cs` 里，带图预热），并写死 **`keep_alive: "60m"`**（`shot-ocr.cs`）。目的是让「第一次划词 OCR 不冷启动超时」。预热用的模型就是 `qwen3-vl:4b-instruct`。

**证据三连**：
- `shot-service.log` → `ocr warmup done (带图, 模型常驻 60m)`
- `%LOCALAPPDATA%\Ollama\server.log` → `[GIN] ... 127.0.0.1 | POST "/api/generate"`
- `ollama ps` 的 UNTIL = warmup 时间 + 60 分钟

**处置**：
```bash
# 立刻放掉（无人使用时安全；下次 OCR 会按需重载，约 20s 冷启动）
ollama stop qwen3-vl:4b-instruct      # 实测 10437MiB → 1509MiB
```
XDN 基线 ≈ **1.5GB**（桌面 + dwm/explorer/Edge/抖音/飞书/Doubao + Sunshine + 空闲的 ComfyUI python），超过这个数的多半就是模型加载。

**根治（三选一，要动 XDN 的软件目录/代码，动手前先报备老大）**：
① 从 XDN 的 `HKCU\Run` 去掉 `shot-service`（XDN 不做划词 OCR 就选这个，最省事、零改代码）；
② 改 `shot-ocr.cs` 的 `keep_alive`（但会让「间隔久了再划词」重新冷启动 —— 那正是它当初改成 60m 的原因）；
③ 给 warmup 加开关/在 XDN 上跳过预热。

⚠️ **副作用提醒**：这 8.9GB 是从物理显存实扣的，生视频（MiniMax H3 那套）本来就吃显存，被占着就是少 8.9GB 可用量。

## 四·五、远程改 win-desktop-helper 配置（XDN / shlc / 任何装了 helper 的机器）

同一个 `XDN_USER`/`XDN_PASS` 在 XDN、**shlc（100.93.226.56）** 上都通用（都是 `oadan` 账号）。

```bash
cd ~/.workbuddy/skills/xdn-remote-ops
eval "$(nssm get comfyui AppEnvironmentExtra 2>/dev/null | tr -d '\0' | grep -E '^XDN_(USER|PASS)=' | sed 's/\r$//' | sed 's/^/export /')"

python wdh_probe.py <host>                 # 体检：进程/版本/配置全文/日志/有没有 Ollama
python wdh_sftp_set.py <host> <id> <key>   # 只改百度三行（文本替换，保留原格式）
python wdh_deploy.py <host>                # 🚀 一键升级：传新 exe + ocr 切 agnes 直连 + 修任务 + 拉起 + 复验
python wdh_restart.py <host>               # 只重启（kill 全部 -> schtasks /Run -> 等单实例落 Session 1）
python wdh_verify_ocr.py <host>            # 端到端验 OCR：本机截图 -> 127.0.0.1:18800/ocr -> 回读识别文字
```

三个脚本都会**双备份**配置（远程 `shot-service.json.bak-<ts>` + 本地 `C:\D\opt\_backup\wdh-cfg\`）。
`wdh_deploy.py` 里的 agnes key **不写死**，运行时从 `litellm_config.yaml` 现取（单一真源）。

**配置架构（2026-09-12 摸清）**：
- 配置文件 = **exe 同目录**的 `shot-service.json`（`ConfigPath()` = `AppDomain.CurrentDomain.BaseDirectory`）。装在 `%LOCALAPPDATA%\Programs\win-desktop-helper\`。
- 🔴 **`Cfg()` 每次调用都 `File.ReadAllText` 重读文件、不缓存** ⇒ **改文件立即生效，不用重启进程**。
- UI 保存写**全 6 节**（ocr/translate/capture/clipboard/volume/pick）；`pick.token` 是**死字段**（源码从不读，不写回是正常的）。
- 🔴 **更新不会丢配置**：`setup.iss` 里 `shot-service.json` 带 `onlyifdoesntexist`，升级时已存在就不覆盖。
- ✅ **卸载不再删配置**（2026-09-12 已修）：`setup.iss` 补了 `uninsneveruninstall`。已装在旧版的机器要等下次跑新版安装包才带上这个标志。
- ⚠️ **shlc / gs 上没装 Ollama** ⇒ `ocr.provider=qwen3vl` 必然失败；这类机器只能 `openai`（agnes 直连）或百度。

## 四·六、🚨 远程拉起 helper 的三个坑（2026-09-12 全部踩完）

1. **全局单实例互斥 `Global\WinDesktopHelper`**：新实例启动时会**主动 kill 旧实例**再接管（防“忘了停旧进程、跑的还是旧代码”）。⇒ **绝不要起两次**，否则进程反复消失、日志刷 `hotkey register FAILED (all candidates busy)`。排查到这个现象先想“是不是我多起了一个”。
2. **SSH 里直接起 exe 会落 Session 0**（没托盘、抓不到屏、热键抢不到）。唯一可靠姿势 = schtasks 任务：
   ```
   schtasks /Create /TN dsh-shot-helper /TR "<exe>" /SC ONCE /ST 00:00 /IT /RL HIGHEST /RU "<user>" /F
   schtasks /Run /TN dsh-shot-helper
   ```
   然后轮询 `Get-Process shot-service | SessionId` 等它出现在 **1**。
3. 🔴 **`/RL HIGHEST` 不能省**：`shot-service.exe` 清单是 `requireAdministrator`，任务不勾“最高权限”时 `/Run` 立刻返回
   `0x800702E4` = **ERROR_ELEVATION_REQUIRED**，任务永远拉不起来（`setup.iss` 原来漏了这一项，已修）。

**判断成功**：日志尾出现 `listening on 127.0.0.1:18800` + `tray icon ready, build=...`，且**没有** hotkey FAILED；托盘提示第三段是 `session=1`。

## 五、XDN 上 ComfyUI 的几个现成接口

- `http://<XDN>:8000/system_stats` — 版本、torch 显存视图、启动参数（含 `--cache-ram` / `--cuda-malloc`）
- `http://<XDN>:8000/queue` — 队列（判断有没有在跑任务）
- `/free`（POST unload_models+free_memory）、`/interrupt` — 释放/中断
- 服务名就叫 `comfyui`（`nssm restart comfyui`），输出目录 `D:\ComfyUI\ComfyUI\output\Svc`，input `D:\ComfyUI\ComfyUI\input`，模型库 `D:\Ollama`（Ollama）/ `D:\ComfyUI\...\models`（ComfyUI）。
