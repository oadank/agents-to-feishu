# sync-skill.ps1 —— 把中央库技能同步到各端技能池
#
# 用法：
#   powershell -File scripts\sync-skill.ps1 wechat-oa              # 同步（含 multica 重导）
#   powershell -File scripts\sync-skill.ps1 wechat-oa -Check       # 只比对不写
#   powershell -File scripts\sync-skill.ps1 wechat-oa -NoMultica   # 只同步磁盘池
#
# 为什么需要它：`~/.agents/skills` 里放的是**实体副本**、multica 里放的是**zip 快照**，
# 两者都不会自动跟中央库。改完中央库不跑这个，各端吃的就是旧版 —— 而且没人报错，纯静默失效。
#
# 🔴 两条血的教训（2026-09-23 实测，别再犯）：
#   1. 别往 Xiaomi MiMo 的 `engine-config\skills\` 放东西：该客户端启动时会清掉
#      非它自己安装的外来子目录，放过 junction 的那次**顺着链接把中央库真源删空**。
#      喂 MiMo 走 `~/.agents/skills`（设置页「技能兼容路径」里的 Agents 开放标准，默认兼容，需重启应用生效）。
#   2. 共享池一律用**实体目录**，不要用 junction/symlink：池内条目全是实体目录，
#      且链接会被某些客户端的清理逻辑顺着咬穿真源。
#
# 生效范围（谁读哪个池）：
#   ~/.agents/skills    ->  DSH(dsh-web) + MiMo 桌面 + ZCode 桌面（三家共读，一份顶三份）
#   ~/.workbuddy/skills ->  WorkBuddy 桌面（独立扫描目录，用 junction 挂中央库，实测读得到）
#   multica 智能体      ->  不读目录，吃 workspace 里的 skill 快照（本脚本自动重导）
#   飞书 13 家 bot      ->  不读目录，走配置中心白名单 + apply（**故意不自动做**，见脚本末尾）

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$Name,
    [switch]$Check,
    [switch]$NoMultica
)

$ErrorActionPreference = 'Stop'
$Repo   = 'C:\D\opt\agents-to-feishu'
$Source = Join-Path $Repo "skills\$Name"
$MConf  = Join-Path $HOME '.multica\config.json'
$Pools  = @(
    @{ Label = 'Agents共享池(DSH+MiMo+ZCode)'; Path = (Join-Path $HOME ".agents\skills\$Name"); Mode = 'copy' },
    @{ Label = 'WorkBuddy桌面';                Path = (Join-Path $HOME ".workbuddy\skills\$Name"); Mode = 'link' }
)

function Get-TreeHash([string]$root) {
    if (-not (Test-Path $root)) { return 'ABSENT' }
    # 🔴 排除口径必须与下面 robocopy 的 /XD /XF 完全一致：真源里存在被排除文件时，
    #    若两边算法不对称，脚本会报"过期"却永远同步不出结果（2026-09-23 实测出的误报缺陷）
    $files = Get-ChildItem $root -Recurse -File -EA SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\__pycache__\\|\\\.cache\\' -and
                       $_.Name -notmatch '^(config\.json|access_token\.json)$' } |
        Sort-Object FullName
    if (-not $files) { return 'EMPTY' }
    $joined = ($files | ForEach-Object { "$($_.Name)$((Get-FileHash $_.FullName -Algorithm MD5).Hash)" }) -join '|'
    (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($joined))) -Algorithm MD5).Hash
}

if (-not (Test-Path (Join-Path $Source 'SKILL.md'))) {
    throw "中央库没有这个技能或缺 SKILL.md：$Source"
}
$srcHash = Get-TreeHash $Source
Write-Host "真源 $Source" -ForegroundColor Cyan
Write-Host "  文件数 $((Get-ChildItem $Source -Recurse -File | Where-Object { $_.FullName -notmatch '__pycache__' }).Count)  哈希 $srcHash"

# ── 1. 磁盘池 ────────────────────────────────────────────────
$dirty = $false
foreach ($p in $Pools) {
    $cur = Get-TreeHash $p.Path
    $same = ($cur -eq $srcHash)
    $state = if ($same) { '✅ 已一致' } elseif ($cur -eq 'ABSENT') { '⬜ 未接入' } else { "🔴 过期 ($cur)" }
    Write-Host "$($p.Label)`n  $($p.Path)`n  $state"

    if ($Check -or $same) { continue }
    $dirty = $true

    if ($p.Mode -eq 'copy') {
        # 实体镜像：robocopy /MIR（中央库删了的文件池里也跟着删，不留鬼文件）
        # /XD /XF 排除凭据与缓存，绝不带进池
        $null = & robocopy $Source $p.Path /MIR /XD '__pycache__' '.cache' /XF 'config.json' 'access_token.json' /NFL /NDL /NJH /NJS /NP
        if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }
        $global:LASTEXITCODE = 0
    }
    else {
        # WorkBuddy 端用 junction 直指真源：改一次即生效，无需同步
        if (Test-Path $p.Path) { (Get-Item $p.Path -Force).Delete() }
        New-Item -ItemType Junction -Path $p.Path -Target $Source | Out-Null
    }
    $new = Get-TreeHash $p.Path
    if ($new -eq $srcHash) { Write-Host "  -> 同步后一致 ✅" -ForegroundColor Green }
    else { Write-Host "  -> 🔴 同步后仍不一致 ($new)" -ForegroundColor Red }
}
if ($dirty) { Write-Host "`n磁盘池同步完成。" -ForegroundColor Green }
else { Write-Host "`n磁盘池本来就一致。" -ForegroundColor Green }

# ── 2. multica 快照 ─────────────────────────────────────────
# 🔴 必须在"磁盘池已一致"的分支之外无条件跑：快照与目录是两套东西，
#    目录一致不代表 multica 是新版（上一版在这里 exit 掉，是个真 bug）。
# 实测 2026-09-23：`import --on-conflict overwrite` **保留同一 skill id、智能体绑定自动沿用**
# （改前改后 id 均为 c8762361…，两个 agent 的 skills list 都还挂着），故安全幂等。
if (-not $Check -and -not $NoMultica) {
    Write-Host "`n--- multica 快照重导 ---" -ForegroundColor Cyan
    if (-not (Get-Command multica -EA SilentlyContinue)) {
        Write-Host "  ⚠️ PATH 里没有 multica CLI，跳过" -ForegroundColor Yellow
    }
    elseif (-not (Test-Path $MConf)) {
        Write-Host "  ⚠️ 找不到 $MConf（未登录过桌面端？），跳过" -ForegroundColor Yellow
    }
    else {
        $cf    = Get-Content $MConf -Raw | ConvertFrom-Json
        $mArgs = @('--server-url', $cf.server_url, '--profile', 'desktop-api.multica.ai', '--workspace-id', $cf.workspace_id)
        $oldId = $null
        try {
            $oldId = ((& multica skill list --output json @mArgs 2>&1 | Out-String) | ConvertFrom-Json |
                      Where-Object { $_.name -eq $Name }).id
        } catch { }

        $zip = Join-Path $env:TEMP "$Name.skill.zip"
        Remove-Item $zip -EA SilentlyContinue
        Compress-Archive -Path $Source -DestinationPath $zip -CompressionLevel Optimal
        $imp = (& multica skill import --file $zip --on-conflict overwrite --output json @mArgs 2>&1 | Out-String)
        Remove-Item $zip -Force -EA SilentlyContinue

        $newId = $null
        try { $newId = (($imp | ConvertFrom-Json).skill.id) } catch { }
        if (-not $newId) {
            Write-Host "  🔴 导入失败：$($imp.Substring(0, [Math]::Min(300, $imp.Length)))" -ForegroundColor Red
        }
        elseif ($oldId -and $oldId -ne $newId) {
            # 万一哪天 overwrite 改成换 id 了，绑定会静默失效，必须当场叫出来
            Write-Host "  🔴 id 变了（$oldId -> $newId）：旧绑定已废，逐家重挂：" -ForegroundColor Red
            Write-Host "       multica agent skills add <agent-id> --skill-ids $newId" -ForegroundColor Yellow
        }
        elseif ($oldId) {
            Write-Host "  ✅ 已更新，id 未变（$newId），智能体绑定自动沿用" -ForegroundColor Green
        }
        else {
            Write-Host "  ⬜ 首次导入，id=$newId，需手工挂载：" -ForegroundColor Yellow
            Write-Host "       multica agent skills add <agent-id> --skill-ids $newId" -ForegroundColor Yellow
        }
    }
}

# ── 3. 故意不自动做的那一处 ──────────────────────────────────
Write-Host @"

剩一处脚本**故意**不自动做（影响 13 家在跑的服务，得有人盯着）：
  飞书 bot：入白名单 + 逐家 apply（apply 不重启服务，实测无扰动）
    Invoke-RestMethod -Method Post http://127.0.0.1:13600/api/skills/toggle -ContentType 'application/json' -Body '{"name":"$Name","enabled":true}'
    再对每家 POST /api/agents/<id>/apply
"@ -ForegroundColor Yellow
