# sync-skill.ps1 —— 把中央库技能同步到各端技能池
#
# 用法：
#   powershell -File scripts\sync-skill.ps1 wechat-oa          # 同步一个
#   powershell -File scripts\sync-skill.ps1 wechat-oa -Check   # 只比对不写
#
# 为什么需要它：`~/.agents/skills` 里放的是**实体副本**，不会自动跟中央库。
# 改完中央库不跑这个，各端吃的就是旧版 —— 而且没人会报错，纯静默失效。
#
# 🔴 两条血的教训（2026-09-23 实测，别再犯）：
#   1. 别往 Xiaomi MiMo 的 `engine-config\skills\` 放东西：该客户端启动时会清掉
#      非它自己安装的外来子目录，放过 junction 的那次**顺着链接把中央库真源删空**。
#      喂 MiMo 走 `~/.agents/skills`（设置页「技能兼容路径」里的 Agents 开放标准，默认兼容，需重启应用生效）。
#   2. 共享池一律用**实体目录**，不要用 junction/symlink：池内 29 个条目全是实体目录，
#      且链接会被某些客户端的清理逻辑顺着咬穿真源。
#
# 生效范围（谁读哪个池）：
#   ~/.agents/skills  ->  DSH(dsh-web) + MiMo 桌面 + ZCode 桌面（三家共读，一份顶三份）
#   ~/.workbuddy/skills -> WorkBuddy 桌面（独立扫描目录，用 junction 挂中央库，实测读得到）
#   飞书 13 家 bot    ->  不读目录，走配置中心白名单 apply（POST /api/skills/toggle + /api/agents/<id>/apply）
#   multica 智能体    ->  不读目录，走 `multica skill import --file <zip>` 再 `agent skills add`

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$Name,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$Repo   = 'C:\D\opt\agents-to-feishu'
$Source = Join-Path $Repo "skills\$Name"
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

$dirty = $false
foreach ($p in $Pools) {
    $cur = Get-TreeHash $p.Path
    $same = ($cur -eq $srcHash)
    $state = if ($same) { '✅ 已一致' } elseif ($cur -eq 'ABSENT') { '⬜ 未接入' } else { "🔴 过期 ($cur)" }
    Write-Host "$($p.Label)`n  $($p.Path)`n  $state"

    if ($Check -or $same) { continue }
    $dirty = $true

    if ($p.Mode -eq 'copy') {
        # 实体复制：robocopy /MIR 镜像（中央库删了的文件，池里也跟着删，不留鬼）
        # 注意 /XD 排除凭据与缓存，绝不把它们带进池
        $null = & robocopy $Source $p.Path /MIR /XD '__pycache__' '.cache' /XF 'config.json' /NFL /NDL /NJH /NJS /NP
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

if (-not $dirty) {
    Write-Host "`n全部就绪，无需同步。" -ForegroundColor Green
    exit 0
}

Write-Host @"

下一步（脚本管不着的两处，自己跑）：
  1) 飞书 13 家：领班机器上
       Invoke-RestMethod -Method Post http://127.0.0.1:13600/api/skills/toggle -ContentType 'application/json' -Body '{"name":"$Name","enabled":true}'
       再逐家 POST /api/agents/<id>/apply（apply 不重启服务）
  2) multica：重打 zip 导入（旧 skill 会被同名覆盖，agent 绑定关系保留）
       Compress-Archive -Path "$Source" -DestinationPath "`$env:TEMP\$Name.zip" -Force
       multica skill import --file "`$env:TEMP\$Name.zip" --on-conflict overwrite
       multica agent skills add <agent-id> --skill-ids <id>
"@ -ForegroundColor Yellow
