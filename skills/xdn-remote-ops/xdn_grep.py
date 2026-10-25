"""XDN 远程关键词扫描 —— 查某台机器上还有谁在引用旧地址/旧端口。

用法：
    python xdn_grep.py 18796
    python xdn_grep.py "100\.108\.133\.82" "18796"

凭据来自环境变量 XDN_HOST / XDN_USER / XDN_PASS（取法见 SKILL.md 第一节）。
扫描范围：~/.dsh、~/.workbuddy、C:\\D\\opt、D:\\opt（存在才扫），
只看 .yml/.yaml/.json/.js/.mjs/.ts/.ps1/.env，跳过 node_modules / .git / 日志。
"""
import base64
import os
import sys

import paramiko

PORT = int(os.environ.get("XDN_PORT", "22") or 22)
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")


def build_ps(patterns):
    alts = "|".join(patterns)
    return r"""
$ProgressPreference='SilentlyContinue'
$roots = @()
$roots += (Join-Path $env:USERPROFILE '.dsh')
$roots += (Join-Path $env:USERPROFILE '.workbuddy')
if (Test-Path 'C:\D\opt') { $roots += 'C:\D\opt' }
if (Test-Path 'D:\opt') { $roots += 'D:\opt' }
$pattern = '__PATTERN__'
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  Write-Output ('### SCAN ' + $r)
  Get-ChildItem $r -Recurse -File -ErrorAction SilentlyContinue -Include *.yml,*.yaml,*.json,*.js,*.mjs,*.ts,*.ps1,*.env |
    Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\|\\logs?\\' -and $_.Length -lt 2MB } |
    Select-String -Pattern $pattern -ErrorAction SilentlyContinue |
    Select-Object -First 40 |
    ForEach-Object { Write-Output ($_.Path + ' :: ' + $_.Line.Trim()) }
}
Write-Output '### END'
""".replace("__PATTERN__", alts)


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python xdn_grep.py <正则1> [正则2 ...]")
    host = os.environ.get("XDN_HOST", "")
    if not (host and USER and PASS):
        sys.exit("缺少 XDN_HOST / XDN_USER / XDN_PASS（见 SKILL.md 第一节）")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=PORT, username=USER, password=PASS, timeout=20)
    b64 = base64.b64encode(build_ps(sys.argv[1:]).encode("utf-16-le")).decode("ascii")
    _, out, err = c.exec_command(f"powershell -NoProfile -EncodedCommand {b64}", timeout=180)
    print(out.read().decode("utf-8", "replace"))
    e = err.read().decode("gbk", "replace").strip()
    if e:
        print("STDERR:", e[:500])
    c.close()


if __name__ == "__main__":
    main()
