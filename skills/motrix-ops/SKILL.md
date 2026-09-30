---
name: motrix-ops
description: 本机 Motrix 2.0 下载器的 AI 调用姿势（aria2 JSON-RPC 16800）：加任务/查进度/装包启动踩坑。凡要下载大文件、HTTP/BT/磁力任务、或给 bot 找"本机下载后台"时用本技能。
---

# Motrix 2.0（本机）——AI 调用手册

> 一句话：**别点界面，直接打 HTTP**。Motrix 内嵌标准 aria2 引擎，进程 `aria2c.exe` 独立监听 JSON-RPC，任何 agent 一个 POST 就能下单下载。

## 服务真源（现状速查）

- 主程序：`C:\Users\oadan\AppData\Local\Programs\Motrix\Motrix.exe`（2.0.0-beta.41 起）
- 引擎：`...\resources\extra\win32\x64\aria2c.exe --enable-rpc=true --conf-path=%APPDATA%\Motrix\aria2.conf`（**独立进程名 aria2c，扫端口别只按 Motrix.exe 找**）
- RPC 端点：`http://127.0.0.1:16800/jsonrpc`
- token：`(Get-Content $env:APPDATA\Motrix\settings.json -Raw | ConvertFrom-Json).engine.rpcSecret` —— **现取，永远不要把明文抄进任何文件/回复/仓库**
- 默认存盘目录：settings.json `.app.defaultSaveDir`（本机 = Downloads）

## 下单三招（实测可跑的原语）

```powershell
# 0) 握手（验证活着 + 拿版本）
$secret = (Get-Content $env:APPDATA\Motrix\settings.json -Raw | ConvertFrom-Json).engine.rpcSecret
$call = { param($m,$p) @{ jsonrpc='2.0'; id=1; method=$m; params=@("token:$secret")+$p } | ConvertTo-Json -Compress -Depth 5 |
  ForEach-Object { Invoke-RestMethod http://127.0.0.1:16800/jsonrpc -Method Post -Body $_ -ContentType 'application/json' } }
(& $call 'aria2.getVersion' @()).result.version   # → 1.37.0-motrix.xx

# 1) 加任务（out/dir 可选；返回 GID）
$gid = (& $call 'aria2.addUri' @(, @('https://site/file.zip')) ).result
# 带参数版：
$gid = (& $call 'aria2.addUri' @(, @('https://site/file.zip'), @{ out='file.zip'; dir="$env:USERPROFILE\Downloads\sub" })) .result

# 2) 查进度
(& $call 'aria2.tellStatus' @($gid, @('status','downloadedLength','totalLength'))).result
```

批量/其它常用 method：`aria2.tellActive / tellWaiting / pause / resume / remove / getGlobalStat`；BT/磁力直接 `addUri` 塞 magnet 链接即可（DHT 已开）。

## 🔴 四个实测坑

1. **完成后 GID 会被回收**（Motrix 用 SQLite3-Persistence 迁历史），`tellStatus` 报 `GID ... is not found` ≠ 失败——**以磁盘文件为准**，先查文件大小再下结论。
2. **改 RPC 端口/secret 要重启引擎**：Settings→Advanced→"RPC, SQLite persistence"（界面里 secret 掩码可见、可重生成）。
3. **首启有 Usage Notice 协议窗**（新装后第一次）——点 "Agree & Continue" 一次即永久记住；`UI find name=Continue` 拿 Button ref 点击。服务/无桌面会话起不来（Electron FATAL "GPU process isn't usable"），要么用户会话里起，要么加 `--disable-gpu`。
4. **静默安装姿势**：`Start-Process <setup.exe> -ArgumentList '/S' -Wait`（NSIS）；GitHub release 大包裸 curl 必截断，走 `-x http://127.0.0.1:7897` + `-C -` 多轮续传 + sha256 对官方 digest。

## 何时该用它

- 要下 **GB 级大文件 / BT / 磁力**：用 Motrix（断点续传+多连接+UI 可见），别裸 curl。
- 普通小文件一条 URL：curl/代理也行，不必劳驾。
- 产物落盘后按团队规矩：文件路径写进回报，重要成品放 `C:\D\opt\team-artifacts\<任务ID>\`。

## 验证记录（唯一口径）

2026-09-29 mimo 首装实测：静默装 EXIT=0 → RPC 握手 `1.37.0-motrix.16` → addUri 下 Q-Dir 1,083,753B 与源站 Content-Length 逐字节一致、zip 可解。装/调/下三步全绿。
