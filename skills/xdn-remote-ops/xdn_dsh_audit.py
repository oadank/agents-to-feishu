"""XDN 远程 dsh 配置审计 —— 一次查清 MCP transport 合法性与 wb-shim 地址迁移情况。

用法：
    python xdn_dsh_audit.py [host]

凭据来自环境变量 XDN_HOST / XDN_USER / XDN_PASS（取法见 SKILL.md 第一节）。

查什么：
  1. ~/.dsh/cordis.patch.yml 里 MCP 条目的 transport（dsh 只认 stdio / streamable-http，写 http 会静默不激活）
  2. ~/.dsh/profiles/*/cordis.patch.yml 里的 baseURL（https 改造后旧明文 IP 全 400）
  3. ~/.dsh/mcp-servers.json 的 transport
  4. ~/.workbuddy/models.json 的 url / name
  5. ~/.dsh 下所有 yml/json 里残留的 100.108.133.82:18796 明文地址
"""
import base64
import os
import sys

import paramiko

HOST = os.environ.get("XDN_HOST", "")
PORT = int(os.environ.get("XDN_PORT", "22") or 22)
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")

PS = r"""
$ProgressPreference='SilentlyContinue'
$d = Join-Path $env:USERPROFILE '.dsh'
Write-Output ('=== HOME=' + $env:USERPROFILE + ' DSH_EXISTS=' + (Test-Path $d) + ' ===')
Write-Output '=== .dsh 顶层（目录 + yml/json） ==='
Get-ChildItem $d -ErrorAction SilentlyContinue |
  Where-Object { $_.PSIsContainer -or $_.Name -match '\.(ya?ml|json)$' } |
  ForEach-Object { Write-Output (($(if($_.PSIsContainer){'DIR '}else{'FILE'})) + ' ' + $_.Name) }
Write-Output '=== profiles 子目录 -> 内含配置文件 ==='
$pd = Join-Path $d 'profiles'
if (Test-Path $pd) {
  Get-ChildItem $pd -Directory | ForEach-Object {
    $files = Get-ChildItem $_.FullName -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(ya?ml|json)$' } | ForEach-Object { $_.Name }
    Write-Output ('PROFILE ' + $_.Name + ' -> ' + ($files -join ', '))
  }
}
Write-Output '=== ROOT cordis.patch.yml (transport/url) ==='
$f = Join-Path $d 'cordis.patch.yml'
if (Test-Path $f) { Get-Content $f | Select-String -Pattern 'transport|url:|serverName' | ForEach-Object { $_.Line.Trim() } } else { Write-Output '(none)' }
Write-Output '=== PROFILES baseURL / transport ==='
$pd = Join-Path $d 'profiles'
if (Test-Path $pd) {
  Get-ChildItem $pd -Directory | ForEach-Object {
    $p = Join-Path $_.FullName 'cordis.patch.yml'
    if (Test-Path $p) {
      $hits = Get-Content $p | Select-String -Pattern 'transport:|baseURL:'
      if ($hits) { Write-Output ('PROFILE ' + $_.Name); $hits | ForEach-Object { Write-Output ('  ' + $_.Line.Trim()) } }
    }
  }
} else { Write-Output '(no profiles dir)' }
Write-Output '=== mcp-servers.json ==='
$m = Join-Path $d 'mcp-servers.json'
if (Test-Path $m) { (Get-Content $m -Raw | ConvertFrom-Json).servers | ForEach-Object { Write-Output ($_.serverName + ' | ' + $_.transport + ' | ' + $_.url) } } else { Write-Output '(none)' }
Write-Output '=== workbuddy models.json ==='
$w = Join-Path $env:USERPROFILE '.workbuddy\models.json'
if (Test-Path $w) { (Get-Content $w -Raw | ConvertFrom-Json) | ForEach-Object { Write-Output ($_.id + ' | ' + $_.name + ' | ' + $_.url) } } else { Write-Output '(none)' }
Write-Output '=== 残留旧明文 100.108.133.82:18796 ==='
Get-ChildItem $d -Recurse -Include *.yml,*.json -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'node_modules' } |
  Select-String -Pattern '100\.108\.133\.82:18796' |
  ForEach-Object { Write-Output ($_.Path + ' :: ' + $_.Line.Trim()) }
Write-Output '=== END ==='
"""


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else HOST
    if not (host and USER and PASS):
        sys.exit("缺少 XDN_HOST / XDN_USER / XDN_PASS（见 SKILL.md 第一节）")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=PORT, username=USER, password=PASS, timeout=20)
    b64 = base64.b64encode(PS.encode("utf-16-le")).decode("ascii")
    _, out, err = c.exec_command(f"powershell -NoProfile -EncodedCommand {b64}", timeout=120)
    print(out.read().decode("gbk", "replace"))
    e = err.read().decode("gbk", "replace").strip()
    if e:
        print("STDERR:", e[:500])
    c.close()


if __name__ == "__main__":
    main()
