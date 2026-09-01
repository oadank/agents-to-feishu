# 批量把 9 个 bot nssm 服务从 agents-to-feishu-<id> 改成 <id> 短名（claude 已单独迁移）
$ErrorActionPreference = 'Stop'
$nssm = 'C:\Windows\System32\nssm.exe'
$oldRoot = 'agents-to-feishu-'
$agents = @('codex','mimo','gemini','hermes','openakita','reasonix','openclaw','opencode') # claude 已迁移

foreach ($id in $agents) {
  $old = "$oldRoot$id"
  Write-Host "==== $old -> $id ===="

  $oldSvc = Get-Service -Name $old -ErrorAction SilentlyContinue
  if ($oldSvc) {
    # 读取旧配置
    $reg = "HKLM:\SYSTEM\CurrentControlSet\Services\$old\Parameters"
    $p = Get-ItemProperty $reg
    $app = $p.Application
    $params = $p.AppParameters
    $dir = $p.AppDirectory
    $envExtra = $p.AppEnvironmentExtra
    $stdout = $p.AppStdout
    $stderr = $p.AppStderr

    # 停旧
    if ($oldSvc.Status -ne 'Stopped') {
      & $nssm stop $old 2>&1 | Out-Null
      $t = 0
      while ((Get-Service -Name $old -ErrorAction SilentlyContinue).Status -ne 'Stopped' -and $t -lt 30) {
        Start-Sleep -Seconds 1; $t++
      }
    }
    # 删旧
    & $nssm remove $old confirm 2>&1 | Out-Null
    Write-Host "  removed old"
  }

  # 建新短名
  $newSvc = Get-Service -Name $id -ErrorAction SilentlyContinue
  if ($newSvc) { & $nssm remove $id confirm 2>&1 | Out-Null } # 防残留重名
  & $nssm install $id $app 2>&1 | Out-Null
  & $nssm set $id AppParameters $params | Out-Null
  & $nssm set $id AppDirectory $dir | Out-Null
  if ($stdout) { & $nssm set $id AppStdout $stdout | Out-Null }
  if ($stderr) { & $nssm set $id AppStderr $stderr | Out-Null }
  & $nssm set $id AppRotateFiles 1 | Out-Null
  & $nssm set $id Start SERVICE_AUTO_START | Out-Null
  # 写 AppEnvironmentExtra（MultiString）
  $regP = "HKLM:\SYSTEM\CurrentControlSet\Services\$id\Parameters"
  if (-not (Test-Path $regP)) { New-Item -Path $regP -Force | Out-Null }
  Set-ItemProperty -Path $regP -Name AppEnvironmentExtra -Value $envExtra -Type MultiString | Out-Null
  # 启动
  & $nssm start $id 2>&1 | Out-Null
  Start-Sleep -Seconds 5
  $st = (Get-Service -Name $id -ErrorAction SilentlyContinue).Status
  Write-Host "  $id => $st"
}

Write-Host ''
Write-Host '批量迁移完成。'
