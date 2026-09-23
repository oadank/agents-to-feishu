# sync-skill.ps1 —— 中央库技能同步 / 全机技能池漂移审计
#
# 用法：
#   scripts\sync-skill.ps1 wechat-oa              同步一个技能（磁盘池 + multica 快照）
#   scripts\sync-skill.ps1 wechat-oa -Check       只比对不写
#   scripts\sync-skill.ps1 wechat-oa -NoMultica   只同步磁盘池
#   scripts\sync-skill.ps1 -Audit                 🔴 全机技能池漂移审计（纯只读，建议常跑）
#   scripts\sync-skill.ps1 wechat-oa -Heal        看修复计划（dry-run，不写盘）
#   scripts\sync-skill.ps1 wechat-oa -Heal -Force 真把各池同名副本刷成上游版本
#
# 为什么需要它：`~/.agents/skills` 是**实体副本**、multica 是**zip 快照**、`~/.claude/skills`
# 里还有别的程序自动生成的副本 —— 全都不会自动跟真源。改完中央库不跑这个，
# 各端吃的就是旧版，而且**没有任何报错**，纯静默失效。
#
# 🔴 三条血的教训（2026-09-23 实测，别再犯）：
#   1. 别往 Xiaomi MiMo 的 `engine-config\skills\` 放东西：该客户端启动时会清掉非它自己
#      安装的外来子目录，放过 junction 的那次**顺着链接把中央库真源删空**。
#      喂 MiMo 走 `~/.agents/skills`（设置页「技能兼容路径」的 Agents 开放标准，需重启生效）。
#   2. 收编慎用 junction：本机实测某些客户端会顺着链接咬穿真源，且自动生成的副本删了还会回来。
#   3. 本文件必须存成 **UTF-8 with BOM**：PS 5.1 读无 BOM 的 UTF-8 会把中文啃成乱码直接解析崩溃。
#      write / edit 工具写回会丢 BOM，改完自查前 3 字节是否 239,187,191。
#
# 谁读哪个池（实测口径）：
#   ~/.agents/skills    ->  DSH(dsh-web) + MiMo 桌面 + ZCode 桌面（三家共读，一份顶三份）
#   ~/.workbuddy/skills ->  WorkBuddy 桌面（私产扫描目录）
#   ~/.claude|.codex|.opencode|.mimocode\skills -> 各家客户端的「兼容路径」
#   中央库 git           ->  C:\D\opt\agents-to-feishu\skills（唯一该被编辑的地方）
#   multica 智能体       ->  workspace 快照（本脚本自动重导，实测 overwrite 保留 id 与绑定）
#   飞书 13 家 bot       ->  配置中心白名单 + apply（**故意不自动做**，见末尾）

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Name,
    [switch]$Check,
    [switch]$NoMultica,
    [switch]$Audit,
    [switch]$Heal,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Repo       = 'C:\D\opt\agents-to-feishu'
$RepoSkills = Join-Path $Repo 'skills'
$MConf      = Join-Path $HOME '.multica\config.json'

# 池登记表：Key = 相对 $HOME 的路径（'__repo__' 代表中央库）
$PoolRoots = [ordered]@{
    '__repo__'          = '中央库(git 真源)'
    '.agents\skills'    = '开放标准池(DSH+MiMo+ZCode 共读)'
    '.workbuddy\skills' = 'WorkBuddy 桌面'
    '.claude\skills'    = 'Claude 兼容路径'
    '.codex\skills'     = 'Codex 兼容路径'
    '.opencode\skills'  = 'OpenCode 兼容路径'
    '.mimocode\skills'  = 'MiMoCode 兼容路径'
    '.dsh\skills'       = 'DSH 私产'
}
$PoolPaths = [ordered]@{}
foreach ($k in $PoolRoots.Keys) {
    if ($k -eq '__repo__') { $PoolPaths[$k] = $RepoSkills }
    else { $PoolPaths[$k] = Join-Path $HOME $k }
}

function Get-TreeHash([string]$root) {
    if (-not $root -or -not (Test-Path $root)) { return 'ABSENT' }
    # 🔴 排除口径必须与 robocopy 的 /XD /XF 严格一致，否则真源里存在被排除文件时
    #    哈希永远对不上 -> 报"过期"却同步不出结果（2026-09-23 实测出的误报缺陷）
    # 🔴 同时排除 *.bak-*：本机实测有客户端改技能时留 SKILL.md.bak-<时间戳>，
    #    它既不是内容也不是版本，算进去会让审计满屏假漂移（2026-09-23 实测）
    $files = Get-ChildItem $root -Recurse -File -EA SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\__pycache__\\|\\\.cache\\|\\node_modules\\' -and
                       $_.Name -notmatch '^(config\.json|access_token\.json)$' -and
                       $_.Name -notmatch '\.bak([-.]|$)' } |
        Sort-Object FullName
    if (-not $files) { return 'EMPTY' }
    $joined = ($files | ForEach-Object { "$($_.Name)$((Get-FileHash $_.FullName -Algorithm MD5).Hash)" }) -join '|'
    (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($joined))) -Algorithm MD5).Hash
}

function Get-PoolMap {
    # 返回 @{ 技能名 = @{ 池Key = TreeHash } }
    $map = @{}
    foreach ($k in $PoolPaths.Keys) {
        $root = $PoolPaths[$k]
        if (-not (Test-Path $root)) { continue }
        foreach ($d in (Get-ChildItem $root -Directory -EA SilentlyContinue)) {
            if ($d.Name -like '.*' -or $d.Name -eq 'node_modules') { continue }
            if (-not $map.ContainsKey($d.Name)) { $map[$d.Name] = @{} }
            $map[$d.Name][$k] = Get-TreeHash $d.FullName
        }
    }
    return $map
}

# ═════════════════ 模式一：全机漂移审计（只读） ═════════════════
if ($Audit) {
    Write-Host "`n════ 全机技能池漂移审计（只读，不改任何东西） ════" -ForegroundColor Cyan
    foreach ($k in $PoolPaths.Keys) {
        $root = $PoolPaths[$k]
        if (Test-Path $root) {
            $n = @(Get-ChildItem $root -Directory -EA SilentlyContinue |
                   Where-Object { $_.Name -notlike '.*' -and $_.Name -ne 'node_modules' }).Count
        } else { $n = '目录不存在' }
        Write-Host ("  {0,-18} {1,-30} {2}" -f $k, $PoolRoots[$k], $n)
    }
    $map = Get-PoolMap
    Write-Host "  ---- 技能名去重共 $(@($map.Keys).Count) 个 ----"

    $multi = @($map.GetEnumerator() | Where-Object { $_.Value.Count -gt 1 } | Sort-Object Name)
    Write-Host "`n── 跨池同名 $($multi.Count) 组 ──" -ForegroundColor Cyan
    $drift = 0
    foreach ($e in $multi) {
        $uniq = @($e.Value.Values | Select-Object -Unique)
        if ($uniq.Count -eq 1) {
            Write-Host ("  [OK]   {0,-30} {1} 处一致" -f $e.Name, $e.Value.Count) -ForegroundColor DarkGray
            continue
        }
        $drift++
        Write-Host ("  [DRIFT] {0}  散在 {1} 处、{2} 个不同版本" -f $e.Name, $e.Value.Count, $uniq.Count) -ForegroundColor Red
        # 该认谁：中央库 > .agents > 其余取内容 mtime 最新
        $prefer = $null
        if ($e.Value.ContainsKey('__repo__')) { $prefer = '__repo__' }
        elseif ($e.Value.ContainsKey('.agents\skills')) { $prefer = '.agents\skills' }
        else {
            $best = [datetime]::MinValue
            foreach ($p in $e.Value.Keys) {
                $dir = Join-Path $PoolPaths[$p] $e.Name
                $t = @(Get-ChildItem $dir -Recurse -File -EA SilentlyContinue |
                       Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
                if ($t -and $t -gt $best) { $best = $t; $prefer = $p }
            }
        }
        foreach ($p in ($e.Value.Keys | Sort-Object)) {
            $h = $e.Value[$p]
            $short = if ($h.Length -ge 8) { $h.Substring(0, 8) } else { $h }
            $mark = if ($p -eq $prefer) { '  <- 建议以此为准' } else { '' }
            Write-Host ("           {0,-20} {1}{2}" -f $p, $short, $mark)
        }
    }
    if ($drift -eq 0) { Write-Host "`n  无漂移。" -ForegroundColor Green }
    else {
        Write-Host "`n  共 $drift 组漂移，逐个处理：" -ForegroundColor Yellow
        Write-Host '    sync-skill.ps1 <技能名> -Heal        先看计划（不写盘）'
        Write-Host '    sync-skill.ps1 <技能名> -Heal -Force 再真刷平'
    }
    Write-Host "`n  注：.claude 等池的副本可能由别的客户端自动生成，刷平后仍会被改写 —— 审计要定期跑。`n"
    exit 0
}

if (-not $Name) { throw '给个技能名，或用 -Audit 做全池审计' }
$SkillInRepo = Join-Path $RepoSkills $Name
if (-not (Test-Path (Join-Path $SkillInRepo 'SKILL.md'))) {
    throw "中央库没有这个技能或缺 SKILL.md：$SkillInRepo"
}
$srcHash = Get-TreeHash $SkillInRepo

# ═════════════════ 模式二：-Heal 把各池副本刷成中央库版 ═════════════════
if ($Heal) {
    Write-Host "`n════ 把各池 '$Name' 副本刷成中央库版 ════" -ForegroundColor Cyan
    Write-Host ("  ★中央库  {0}  （基准，不动）" -f $srcHash.Substring(0, 8))
    $map = Get-PoolMap
    if (-not $map.ContainsKey($Name)) { Write-Host '  没有任何池含此技能'; exit 0 }
    function Get-FileList([string]$dir) {
        if (-not (Test-Path $dir)) { return @() }
        @(Get-ChildItem $dir -Recurse -File -EA SilentlyContinue |
          Where-Object { $_.FullName -notmatch '\\__pycache__\\|\\\.cache\\|\\node_modules\\' -and
                         $_.Name -notmatch '\.bak([-.]|$)' } |
          ForEach-Object { $_.FullName.Substring($dir.Length + 1) })
    }
    $srcFiles = Get-FileList $SkillInRepo
    $risky = 0
    $todo = @()
    foreach ($p in ($map[$Name].Keys | Sort-Object)) {
        if ($p -eq '__repo__') { continue }
        $target = Join-Path $PoolPaths[$p] $Name
        if ($map[$Name][$p] -eq $srcHash) {
            Write-Host ("  [OK]   {0,-20} 已一致" -f $p) -ForegroundColor DarkGray
            continue
        }
        # 🔴 目标独有的文件（中央库没有的）= 别人在这池里加过的东西。
        #    用 /MIR 会当场删掉它们 —— 2026-09-23 实测本机正是这种情况
        #    （all-platform 的 scripts\*.cjs 只在 .dsh 有、中央库反而缺）。故默认只补不删。
        $only = @(Compare-Object $srcFiles (Get-FileList $target) |
                  Where-Object { $_.SideIndicator -eq '=>' } | ForEach-Object { $_.InputObject })
        $missing = @(Compare-Object $srcFiles (Get-FileList $target) |
                     Where-Object { $_.SideIndicator -eq '<=' } | ForEach-Object { $_.InputObject })
        $kind = "补齐 $($missing.Count) 个缺失文件（/E，保留目标独有 $($only.Count) 个）"
        if (@(Get-Item $target -Force).Attributes -match 'ReparsePoint') { $kind = '重建 junction 指回中央库' }
        Write-Host ("  [DIFF] {0,-20} -> {1}" -f $p, $kind) -ForegroundColor Yellow
        if ($only.Count -gt 0) {
            $risky++
            Write-Host "         ⚠ 该池独有（不会被删，但中央库该收编它们）：" -ForegroundColor DarkYellow
            $only | Select-Object -First 6 | ForEach-Object { Write-Host "            + $_" -ForegroundColor DarkYellow }
            if ($only.Count -gt 6) { Write-Host "            ... 另 $($only.Count - 6) 个" -ForegroundColor DarkYellow }
        }
        $todo += @{ Pool = $p; Path = $target; Kind = $kind }
    }
    if (-not $Force) {
        Write-Host "`n  dry-run：$($todo.Count) 处待刷，其中 $risky 处含目标独有文件（只补不删）。" -ForegroundColor Yellow
        if ($risky -gt 0) { Write-Host '  这些"目标独有"文件很可能是别人绕过中央库直接加进池的 —— 建议把它们反向并入中央库后再统一分发，别让它们只活在一份副本里。' -ForegroundColor Yellow }
        Write-Host '  确认后加 -Force 执行。' -ForegroundColor Yellow
        exit 0
    }
    foreach ($t in $todo) {
        if ($t.Kind -like '*junction*') {
            (Get-Item $t.Path -Force).Delete()
            New-Item -ItemType Junction -Path $t.Path -Target $SkillInRepo | Out-Null
        }
        else {
            # /E 只增不删：把中央库缺的文件补进去，绝不动目标独有的东西
            $null = & robocopy $SkillInRepo $t.Path /E /XD '__pycache__' '.cache' 'node_modules' /XF 'config.json' 'access_token.json' /NFL /NDL /NJH /NJS /NP
            if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 $($t.Path) 码 $LASTEXITCODE" }
            $global:LASTEXITCODE = 0
        }
        $now = Get-TreeHash $t.Path
        if ($now -eq $srcHash) { Write-Host ("  ✅ 已对齐 {0}" -f $t.Pool) -ForegroundColor Green }
        else { Write-Host ("  ⚠ {0} 已补齐但仍有差异（含目标独有文件属正常）: {1}" -f $t.Pool, $now) -ForegroundColor Yellow }
    }
    exit 0
}

# ═════════════════ 模式三：常规同步（磁盘池 + multica 快照） ═════════════════
Write-Host "真源 $SkillInRepo" -ForegroundColor Cyan
Write-Host "  文件数 $(@(Get-ChildItem $SkillInRepo -Recurse -File | Where-Object { $_.FullName -notmatch '__pycache__' }).Count)  哈希 $srcHash"

$Pools = @(
    @{ Label = 'Agents共享池(DSH+MiMo+ZCode)'; Path = (Join-Path $HOME ".agents\skills\$Name"); Mode = 'copy' },
    @{ Label = 'WorkBuddy桌面';                Path = (Join-Path $HOME ".workbuddy\skills\$Name"); Mode = 'link' }
)
$dirty = $false
foreach ($p in $Pools) {
    $cur = Get-TreeHash $p.Path
    $same = ($cur -eq $srcHash)
    $state = if ($same) { '[OK] 已一致' } elseif ($cur -eq 'ABSENT') { '[--] 未接入' } else { "[DRIFT] 过期 ($cur)" }
    Write-Host "$($p.Label)`n  $($p.Path)`n  $state"
    if ($Check -or $same) { continue }
    $dirty = $true
    if ($p.Mode -eq 'copy') {
        $null = & robocopy $SkillInRepo $p.Path /MIR /XD '__pycache__' '.cache' 'node_modules' /XF 'config.json' 'access_token.json' /NFL /NDL /NJH /NJS /NP
        if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }
        $global:LASTEXITCODE = 0
    }
    else {
        if (Test-Path $p.Path) { (Get-Item $p.Path -Force).Delete() }
        New-Item -ItemType Junction -Path $p.Path -Target $SkillInRepo | Out-Null
    }
    $new = Get-TreeHash $p.Path
    if ($new -eq $srcHash) { Write-Host '  -> 同步后一致 [OK]' -ForegroundColor Green }
    else { Write-Host "  -> [DRIFT] 同步后仍不一致 ($new)" -ForegroundColor Red }
}
if ($dirty) { Write-Host "`n磁盘池同步完成。" -ForegroundColor Green }
else { Write-Host "`n磁盘池本来就一致。" -ForegroundColor Green }

# multica：快照与磁盘池无关，必须无条件重导（旧版在此 exit 是真 bug）
# 实测 2026-09-23：overwrite 保留 skill id、智能体绑定自动沿用 -> 安全幂等
if (-not $Check -and -not $NoMultica) {
    Write-Host "`n--- multica 快照重导 ---" -ForegroundColor Cyan
    if (-not (Get-Command multica -EA SilentlyContinue)) { Write-Host '  [WARN] PATH 里没有 multica CLI，跳过' -ForegroundColor Yellow }
    elseif (-not (Test-Path $MConf)) { Write-Host "  [WARN] 找不到 $MConf，跳过" -ForegroundColor Yellow }
    else {
        $cf = Get-Content $MConf -Raw | ConvertFrom-Json
        $mArgs = @('--server-url', $cf.server_url, '--profile', 'desktop-api.multica.ai', '--workspace-id', $cf.workspace_id)
        $oldId = $null
        try { $oldId = ((& multica skill list --output json @mArgs 2>&1 | Out-String) | ConvertFrom-Json | Where-Object { $_.name -eq $Name }).id } catch { }
        $zip = Join-Path $env:TEMP "$Name.skill.zip"
        Remove-Item $zip -EA SilentlyContinue
        Compress-Archive -Path $SkillInRepo -DestinationPath $zip -CompressionLevel Optimal
        $imp = (& multica skill import --file $zip --on-conflict overwrite --output json @mArgs 2>&1 | Out-String)
        Remove-Item $zip -Force -EA SilentlyContinue
        $newId = $null
        try { $newId = (($imp | ConvertFrom-Json).skill.id) } catch { }
        if (-not $newId) { Write-Host "  [FAIL] 导入失败：$($imp.Substring(0, [Math]::Min(300, $imp.Length)))" -ForegroundColor Red }
        elseif ($oldId -and $oldId -ne $newId) { Write-Host "  [!] id 变了（$oldId -> $newId）：旧绑定已废，逐家重挂 multica agent skills add <agent-id> --skill-ids $newId" -ForegroundColor Red }
        elseif ($oldId) { Write-Host "  [OK] 已更新，id 未变（$newId），智能体绑定自动沿用" -ForegroundColor Green }
        else { Write-Host "  [--] 首次导入 id=$newId，需手工挂载 agent skills add <agent-id> --skill-ids $newId" -ForegroundColor Yellow }
    }
}

Write-Host @"

剩一处脚本**故意**不自动做（影响 13 家在跑的服务，得有人盯着）：
  飞书 bot：入白名单 + 逐家 apply（apply 不重启服务，实测无扰动）
    Invoke-RestMethod -Method Post http://127.0.0.1:13600/api/skills/toggle -ContentType 'application/json' -Body '{"name":"$Name","enabled":true}'
    再对每家 POST /api/agents/<id>/apply
"@ -ForegroundColor Yellow
