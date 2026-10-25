"""XDN 远程 dsh 配置原件 dump —— 排查"哪里写了什么"用，不做判断。

用法：
    python xdn_dsh_dump.py [host] [相对路径...]

不给路径时 dump 这几份：
    .dsh/cordis.patch.yml
    .dsh/profiles/*/cordis.patch.yml
    .dsh/mcp-servers.json
    .workbuddy/models.json

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
$home_ = $env:USERPROFILE
$files = @()
$files += (Join-Path $home_ '.dsh\cordis.patch.yml')
$pd = Join-Path $home_ '.dsh\profiles'
if (Test-Path $pd) { Get-ChildItem $pd -Directory | ForEach-Object { $p = Join-Path $_.FullName 'cordis.patch.yml'; if (Test-Path $p) { $files += $p } } }
$files += (Join-Path $home_ '.dsh\mcp-servers.json')
$files += (Join-Path $home_ '.workbuddy\models.json')
if (Test-Path $pd) { Get-ChildItem $pd -Directory | ForEach-Object { $p = Join-Path $_.FullName 'package.json'; if (Test-Path $p) { $files += $p } } }
foreach ($f in $files) {
  Write-Output ('##### ' + $f)
  if (Test-Path $f) {
    Write-Output ('SIZE=' + (Get-Item $f).Length + ' MTIME=' + (Get-Item $f).LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
    Get-Content $f -TotalCount 200 | ForEach-Object { Write-Output $_ }
  } else { Write-Output '(NOT FOUND)' }
  Write-Output ''
}
Write-Output '##### 插件副本（junction?）'
if (Test-Path $pd) {
  Get-ChildItem $pd -Directory | ForEach-Object {
    $nd = Join-Path $_.FullName 'node_modules\@oadank'
    if (Test-Path $nd) {
      Get-ChildItem $nd -Force | ForEach-Object {
        $t = $_.Target
        Write-Output ($_.Name + ' [' + $_.LinkType + '] -> ' + ($t -join ','))
      }
    }
  }
}
"""


def main():
    host = os.environ.get("XDN_HOST", "")
    if len(sys.argv) > 1:
        host = sys.argv[1]
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
