"""XDN 远程修 dsh-input-tools 的 wb-shim 地址（https 改造后的调用方迁移）。

用法：
    python xdn_fix_balance.py            # 预览（dry-run）
    python xdn_fix_balance.py --apply    # 真改（先备份 .bak-<ts>）

改什么：D:\\opt\\dsh-input-tools 源码 + 各 profile node_modules 里的实体副本，
把 http://100.108.133.82:18796（明文，2026-10-22 加 tailscale serve 后只收 TLS，调用必 400）
换成 https://lecoo.tailb5f10f.ts.net:18796（公信证书，Node fetch 原生信任）。

凭据来自环境变量 XDN_HOST / XDN_USER / XDN_PASS（取法见 SKILL.md 第一节）。
"""
import base64
import os
import sys

import paramiko

PORT = int(os.environ.get("XDN_PORT", "22") or 22)
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")

OLD = "http://100.108.133.82:18796"
NEW = "https://lecoo.tailb5f10f.ts.net:18796"

PS_TMPL = r"""
$ProgressPreference='SilentlyContinue'
$old = '__OLD__'
$new = '__NEW__'
$apply = __APPLY__
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$targets = @()
$src = 'D:\opt\dsh-input-tools\lib\balance.js'
if (Test-Path $src) { $targets += $src }
$pd = Join-Path $env:USERPROFILE '.dsh\profiles'
if (Test-Path $pd) {
  Get-ChildItem $pd -Directory | ForEach-Object {
    $p = Join-Path $_.FullName 'node_modules\@oadank\dsh-input-tools\lib\balance.js'
    if (Test-Path $p) { $targets += $p }
  }
}
foreach ($t in $targets) {
  $raw = [System.IO.File]::ReadAllText($t)
  $cnt = ([regex]::Matches($raw, [regex]::Escape($old))).Count
  Write-Output ('HIT ' + $cnt + ' | ' + $t)
  if ($cnt -gt 0 -and $apply) {
    Copy-Item $t ($t + '.bak-' + $stamp) -Force
    $raw2 = $raw.Replace($old, $new)
    [System.IO.File]::WriteAllText($t, $raw2, (New-Object System.Text.UTF8Encoding($false)))
    $chk = [System.IO.File]::ReadAllText($t)
    Write-Output ('  -> replaced, remaining=' + ([regex]::Matches($chk, [regex]::Escape($old))).Count)
  }
}
Write-Output '=== 改后 WB_SHIM_URL 行 ==='
foreach ($t in $targets) {
  Get-Content $t | Select-String -Pattern 'WB_SHIM_URL' | ForEach-Object { Write-Output ($t + ' :: ' + $_.Line.Trim()) }
}
Write-Output '=== DONE ==='
"""


def main():
    apply = "--apply" in sys.argv
    host = os.environ.get("XDN_HOST", "")
    if not (host and USER and PASS):
        sys.exit("缺少 XDN_HOST / XDN_USER / XDN_PASS（见 SKILL.md 第一节）")
    ps = PS_TMPL.replace("__OLD__", OLD).replace("__NEW__", NEW).replace(
        "__APPLY__", "$true" if apply else "$false"
    )
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=PORT, username=USER, password=PASS, timeout=20)
    b64 = base64.b64encode(ps.encode("utf-16-le")).decode("ascii")
    _, out, err = c.exec_command(f"powershell -NoProfile -EncodedCommand {b64}", timeout=120)
    print(out.read().decode("utf-8", "replace"))
    e = err.read().decode("gbk", "replace").strip()
    if e:
        print("STDERR:", e[:500])
    c.close()


if __name__ == "__main__":
    main()
