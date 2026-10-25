"""XDN 远程验证 wb-shim(18796) 连通性与插件副本一致性。

用法：
    python xdn_verify_shim.py

查：
  1. XDN 上 token 文件是否存在（balance.js 默认 C:\\D\\opt\\wb-shim\\token.txt）
  2. 从 XDN 用 PowerShell 请求 https://lecoo.tailb5f10f.ts.net:18796/v1/models（带 token / 不带）
  3. 各 profile 插件副本里还有没有残留旧明文地址

凭据来自环境变量 XDN_HOST / XDN_USER / XDN_PASS（取法见 SKILL.md 第一节）。
"""
import base64
import os
import sys

import paramiko

PORT = int(os.environ.get("XDN_PORT", "22") or 22)
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")

PS = r"""
$ProgressPreference='SilentlyContinue'
$tokFile = 'C:\D\opt\wb-shim\token.txt'
Write-Output ('=== token 文件存在? ' + (Test-Path $tokFile))
$tok = ''
if (Test-Path $tokFile) { $tok = (Get-Content $tokFile -Raw).Trim() }
Write-Output ('token 长度=' + $tok.Length)
$u = 'https://lecoo.tailb5f10f.ts.net:18796/v1/models'
try {
  if ($tok) {
    $r = Invoke-WebRequest -Uri $u -Headers @{ Authorization = 'Bearer ' + $tok } -TimeoutSec 12 -UseBasicParsing
    Write-Output ('带 token -> ' + [int]$r.StatusCode + ' bytes=' + $r.Content.Length)
  } else {
    $r = Invoke-WebRequest -Uri $u -TimeoutSec 12 -UseBasicParsing
    Write-Output ('无 token -> ' + [int]$r.StatusCode)
  }
} catch {
  Write-Output ('请求失败: ' + $_.Exception.Message)
}
Write-Output '=== 各 profile 插件副本残留旧地址 ==='
$pd = Join-Path $env:USERPROFILE '.dsh\profiles'
Get-ChildItem $pd -Directory | ForEach-Object {
  $p = Join-Path $_.FullName 'node_modules\@oadank\dsh-input-tools\lib\balance.js'
  if (Test-Path $p) {
    $c = [System.IO.File]::ReadAllText($p)
    $old = ([regex]::Matches($c, [regex]::Escape('100.108.133.82:18796'))).Count
    $new = ([regex]::Matches($c, [regex]::Escape('lecoo.tailb5f10f.ts.net:18796'))).Count
    Write-Output ($_.Name + ' :: old=' + $old + ' new=' + $new + ' ver=' + ((Select-String -Path $p -Pattern 'WB_SHIM_URL =' | Select-Object -First 1).Line))
  }
}
Write-Output '=== END ==='
"""


def main():
    host = os.environ.get("XDN_HOST", "")
    if not (host and USER and PASS):
        sys.exit("缺少 XDN_HOST / XDN_USER / XDN_PASS（见 SKILL.md 第一节）")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=PORT, username=USER, password=PASS, timeout=20)
    b64 = base64.b64encode(PS.encode("utf-16-le")).decode("ascii")
    _, out, err = c.exec_command(f"powershell -NoProfile -EncodedCommand {b64}", timeout=120)
    print(out.read().decode("utf-8", "replace"))
    e = err.read().decode("gbk", "replace").strip()
    if e:
        print("STDERR:", e[:500])
    c.close()


if __name__ == "__main__":
    main()
