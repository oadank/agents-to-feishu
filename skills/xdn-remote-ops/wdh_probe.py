# -*- coding: utf-8 -*-
"""win-desktop-helper 远程体检（只读）。用法: python wdh_probe.py <host> [user] [pass] [port]"""
import os, sys, base64
import paramiko


def run(cli, ps, timeout=90):
    b64 = base64.b64encode(("$ProgressPreference='SilentlyContinue';\n" + ps).encode("utf-16-le")).decode()
    i, o, e = cli.exec_command(f'powershell -NoProfile -EncodedCommand {b64}', timeout=timeout)
    return o.read().decode("utf-8", "replace") + e.read().decode("utf-8", "replace")


PROBE = r"""
$app = Join-Path $env:LOCALAPPDATA 'Programs\win-desktop-helper'
Write-Output "### 进程"
Get-Process shot-service -ErrorAction SilentlyContinue |
  ForEach-Object { "pid={0} path={1} start={2}" -f $_.Id, $_.Path, $_.StartTime }
Write-Output "### app 目录 = $app"
if (Test-Path $app) {
  Get-ChildItem $app | ForEach-Object { "{0,-30} {1,10} {2}" -f $_.Name, $_.Length, $_.LastWriteTime }
  $exe = Join-Path $app 'shot-service.exe'
  if (Test-Path $exe) { "FileVersion = " + (Get-Item $exe).VersionInfo.FileVersion }
} else { "APP DIR NOT FOUND" }
Write-Output "### shot-service.json"
$cfg = Join-Path $app 'shot-service.json'
if (Test-Path $cfg) { "mtime=" + (Get-Item $cfg).LastWriteTime; Get-Content $cfg -Raw -Encoding UTF8 } else { "CFG NOT FOUND" }
Write-Output "### 全盘其它副本"
Get-ChildItem 'C:\Users' -Recurse -Depth 7 -Filter 'shot-service.json' -ErrorAction SilentlyContinue |
  ForEach-Object { "{0} | {1}B | {2}" -f $_.FullName, $_.Length, $_.LastWriteTime }
Write-Output "### 日志尾部（更新/预热/错误）"
$log = Join-Path $app 'shot-service.log'
if (Test-Path $log) {
  "log size = " + (Get-Item $log).Length
  Select-String -Path $log -Pattern 'update|warmup|ver=|VERSION|err' -ErrorAction SilentlyContinue |
    Select-Object -Last 20 | ForEach-Object { $_.Line }
}
Write-Output "### HKCU Run 里的 shot-service"
(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).'shot-service'
Write-Output "### Ollama / 11435 在位情况"
try { (Invoke-WebRequest 'http://127.0.0.1:11434/api/version' -TimeoutSec 3 -UseBasicParsing).Content } catch { "ollama: " + $_.Exception.Message }
try { (Invoke-WebRequest 'http://127.0.0.1:11435/v1/models' -TimeoutSec 3 -UseBasicParsing).Content } catch { "bge: " + $_.Exception.Message }
Write-Output "### hostname"
hostname
"""


def main():
    host = sys.argv[1]
    user = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("XDN_USER", "")
    pw = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("XDN_PASS", "")
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 22
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username=user, password=pw, timeout=20)
    print(run(c, PROBE))
    c.close()


if __name__ == "__main__":
    main()
