<#
.SYNOPSIS
  为 agents-to-feishu 的 10 个 agent 创建/更新各自的 nssm 服务。
  每个服务：agents-to-feishu-<id>，跑 tsx src/index.ts，注入 CTI_BOT=<id> + 完整 PATH。
  名字沿用 PM2 的 agent 名（claude/codex/mimo/gemini/hermes/openakita/reasonix/openclaw/opencode/dsh）。

.PARAMETER OnlyAgent
  只部署指定 agent（如 -OnlyAgent opencode）。默认全部。
.PARAMETER DryRun
  只打印要执行的命令，不真正创建/修改服务。
.PARAMETER Start
  创建后启动服务。默认只创建不启动（便于逐个验证）。
.PARAMETER PathOverride
  指定 PATH 覆盖值（不传则自动从系统+用户注册表合并）。
#>
param(
  [string]$OnlyAgent = '',
  [switch]$DryRun,
  [switch]$Start,
  [string]$PathOverride = '',
  # 2026-09-01 setup 向导参数化：新机器路径不同时用这两个参数覆盖
  [string]$RepoDir = 'C:\D\opt\agents-to-feishu',   # agents-to-feishu 仓库位置
  [string]$UserHome = 'C:\Users\oadan',             # 部署用户的 home（CTI_USER_HOME）
  # config-center（:13600）也注册成 nssm 服务——裸进程挂了全体 bot 失联（dsh fatal 坑）
  [switch]$IncludeConfigCenter,
  [int]$ConfigCenterPort = 13600
)

$ErrorActionPreference = 'Stop'
$nssm   = 'C:\Windows\System32\nssm.exe'
if (-not (Test-Path $nssm)) { $nssm = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source }
if (-not $nssm -or -not (Test-Path $nssm)) { Write-Host '[ERR] 找不到 nssm.exe——先安装 nssm 并加入 PATH'; exit 1 }
$dir    = $RepoDir
$node   = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) { Write-Host '[ERR] 找不到 node.exe'; exit 1 }
$tsx    = "$dir\node_modules\tsx\dist\cli.mjs"
$index  = "$dir\src\index.ts"
$svcRegBase = 'HKLM:\SYSTEM\CurrentControlSet\Services'

$agents = @('claude','codex','mimo','gemini','hermes','openakita','reasonix','openclaw','opencode','dsh')

# ── config-center 服务（可选，-IncludeConfigCenter 开启）──
function Deploy-ConfigCenter {
  $svc = 'config-center'
  $svcReg = "$svcRegBase\$svc"
  $exists = Get-Service -Name $svc -ErrorAction SilentlyContinue
  Write-Host "── $svc ($(if($exists){'更新'}else{'新建'})) :$ConfigCenterPort ──"
  if ($DryRun) {
    Write-Host "  nssm install $svc $node"
    Write-Host "  nssm set $svc AppParameters `"$tsx $dir\src\config-center\index.ts --port $ConfigCenterPort`""
    Write-Host "  nssm set $svc AppDirectory `"$dir`""
    Write-Host "  CTI_HOME=$UserHome\.agents-to-feishu / CTI_USER_HOME=$UserHome / PATH=<$($usePath.Length) chars>"
    return
  }
  if (-not $exists) {
    & $nssm install $svc $node 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "  [ERR] install 失败"; return }
  }
  & $nssm set $svc AppParameters "$tsx $dir\src\config-center\index.ts --port $ConfigCenterPort" | Out-Null
  & $nssm set $svc AppDirectory "$dir" | Out-Null
  & $nssm set $svc AppStdout "$dir\logs\config-center-out.log" | Out-Null
  & $nssm set $svc AppStderr "$dir\logs\config-center-err.log" | Out-Null
  & $nssm set $svc AppRotateFiles 1 | Out-Null
  & $nssm set $svc Start SERVICE_AUTO_START | Out-Null
  $envArr = @(
    "CTI_HOME=$UserHome\.agents-to-feishu",
    "CTI_USER_HOME=$UserHome",
    "PATH=$usePath"
  )
  $svcRegParams = "$svcReg\$svc\Parameters"
  if (-not (Test-Path $svcRegParams)) { New-Item -Path $svcRegParams -Force | Out-Null }
  Set-ItemProperty -Path $svcRegParams -Name AppEnvironmentExtra -Value $envArr -Type MultiString | Out-Null
  Write-Host "  ok: :$ConfigCenterPort PATH=$($usePath.Length)chars"
  if ($Start) { & $nssm start $svc 2>&1 | Out-Null; Write-Host "  started" }
}

# ── 构建完整 PATH（系统 + 用户 注册表合并 + 关键 CLI 目录兜底）──
function Get-MergedPath {
  $parts = New-Object System.Collections.Generic.List[string]
  try {
    $sysPath = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path -ErrorAction SilentlyContinue).Path
    if ($sysPath) { $sysPath -split ';' | Where-Object { $_ } | ForEach-Object { $parts.Add($_) } }
  } catch {}
  try {
    $userPath = (Get-ItemProperty -Path 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
    if ($userPath) { $userPath -split ';' | Where-Object { $_ } | ForEach-Object { $parts.Add($_) } }
  } catch {}
  # 关键 CLI 目录兜底（npm/venv/CLI 位置；与用户 home 相关的条目全部用 $UserHome 拼接）
  $extra = @(
    'C:\WINDOWS\system32','C:\WINDOWS','C:\WINDOWS\System32\Wbem',
    'C:\WINDOWS\System32\WindowsPowerShell\v1.0','C:\Program Files\nodejs',
    "$UserHome\AppData\Roaming\npm",'C:\Program Files\Git\bin',
    'C:\Program Files\Git\usr\bin','C:\Program Files\Git\cmd','C:\Program Files\PowerShell\7',
    'C:\Program Files\GitHub CLI',
    "$UserHome\AppData\Local\Programs\Reasonix"
  )
  # 引擎 venv 类目录存在才加（openakita/hermes/ollama 属可选引擎）
  $venvCandidates = @(
    'C:\D\opt\openakita\venv\Scripts',
    "$UserHome\AppData\Local\hermes\hermes-agent\venv\Scripts",
    'C:\D\opt\ollama'
  )
  foreach ($v in $venvCandidates) { if (Test-Path $v) { $extra += $v } }
  foreach ($e in $extra) { $parts.Add($e) }
  $seen = @{}
  $result = @()
  foreach ($p in $parts) {
    $k = $p.TrimEnd('\').ToLower()
    if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $result += $p }
  }
  return ($result -join ';')
}

Write-Host ''
$usePath = if ($PathOverride) { $PathOverride } else { Get-MergedPath }

if ($IncludeConfigCenter) { Deploy-ConfigCenter }

foreach ($id in $agents) {
  if ($OnlyAgent -and $id -ne $OnlyAgent) { continue }
  $svc = $id
  $svcReg = "$svcRegBase\$svc"

  $exists = Get-Service -Name $svc -ErrorAction SilentlyContinue
  Write-Host "── $svc ($(if($exists){'更新'}else{'新建'})) ──"

  if ($DryRun) {
    Write-Host "  nssm install $svc $node"
    Write-Host "  nssm set $svc AppParameters `"$tsx $index`""
    Write-Host "  nssm set $svc AppDirectory `"$dir`""
    Write-Host "  nssm set $svc AppEnvironmentExtra (MultiString):"
    Write-Host "    CTI_BOT=$id"
    Write-Host "    PATH=<$($usePath.Length) chars>"
    # stdout/stderr 日志
    Write-Host "  nssm set $svc AppStdout `"$dir\logs\$id-out.log`""
    Write-Host "  nssm set $svc AppStderr `"$dir\logs\$id-err.log`""
    continue
  }

  # ── 创建或更新服务 ──
  if (-not $exists) {
    & $nssm install $svc $node 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "  [ERR] install 失败"; continue }
  }
  & $nssm set $svc AppParameters "$tsx $index" | Out-Null
  & $nssm set $svc AppDirectory "$dir" | Out-Null
  & $nssm set $svc AppStdout "$dir\logs\$id-out.log" | Out-Null
  & $nssm set $svc AppStderr "$dir\logs\$id-err.log" | Out-Null
  & $nssm set $svc AppRotateFiles 1 | Out-Null
  & $nssm set $svc Start SERVICE_AUTO_START | Out-Null

  # 关键：AppEnvironmentExtra 用注册表 MultiString 写入（nssm set 多行会截断）
  # 位置必须是 <svc>\Parameters\AppEnvironmentExtra（nssm 读这里）
  # LocalSystem 服务读不到 oadan 的 ~/.agents-to-feishu，必须显式注入 CTI_HOME/CTI_USER_HOME
  $envArr = @(
    "CTI_BOT=$id",
    "CTI_HOME=$UserHome\.agents-to-feishu",
    "CTI_USER_HOME=$UserHome",
    "PATH=$usePath"
  )
  $svcRegParams = "$svcRegBase\$svc\Parameters"
  if (-not (Test-Path $svcRegParams)) { New-Item -Path $svcRegParams -Force | Out-Null }
  Set-ItemProperty -Path $svcRegParams -Name AppEnvironmentExtra -Value $envArr -Type MultiString | Out-Null

  Write-Host "  ok: CTI_BOT=$id PATH=$($usePath.Length)chars"

  if ($Start) {
    & $nssm start $svc 2>&1 | Out-Null
    Write-Host "  started"
  }
}

Write-Host ''
Write-Host '完成。'
if (-not $DryRun) {
  Write-Host '提示：Windows 下 nssm 服务账户默认 LocalSystem，USERPROFILE 可能指向 systemprofile；'
  Write-Host '若 provider/CLI 需要读取 oadan 配置，需用 nssm set <svc> ObjectName 指定账户。'
}
