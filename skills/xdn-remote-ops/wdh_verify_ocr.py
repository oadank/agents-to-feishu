# -*- coding: utf-8 -*-
"""端到端验证远程 helper 的 OCR：截图 -> 用 /ocr 识别 -> 回读结果（全程在机器本地走 127.0.0.1:18800）。"""
import os
import sys
import time

import paramiko

HOST = sys.argv[1]
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, 22, username=USER, password=PASS, timeout=20,
            allow_agent=False, look_for_keys=False)
sftp = paramiko.SFTPClient.from_transport(ssh.get_transport())

REMOTE_PS = r"C:\Users\oadan\AppData\Local\Temp\wdh_ocr_verify.ps1"
REMOTE_OUT = r"C:\Users\oadan\AppData\Local\Temp\wdh_ocr_verify.txt"

ps = r"""
$ErrorActionPreference = 'Stop'
$s = Invoke-RestMethod -Uri 'http://127.0.0.1:18800/shot?region=all'
$p = $s.file
if (-not $p) { $p = $s.path }
"shot -> $p" | Out-File -Encoding utf8 'C:\Users\oadan\AppData\Local\Temp\wdh_ocr_verify.txt'
$u = 'http://127.0.0.1:18800/ocr?path=' + [uri]::EscapeDataString($p) + '&wait=90000'
$t0 = Get-Date
$o = Invoke-RestMethod -Uri $u
$ms = [int]((Get-Date) - $t0).TotalMilliseconds
"elapsed=${ms}ms ok=$($o.ok) chars=$($o.chars) err=$($o.error)" |
    Out-File -Encoding utf8 -Append 'C:\Users\oadan\AppData\Local\Temp\wdh_ocr_verify.txt'
$o.text | Out-File -Encoding utf8 -Append 'C:\Users\oadan\AppData\Local\Temp\wdh_ocr_verify.txt'
"""
sftp.open(REMOTE_PS, "wb").write(ps.encode("utf-8"))
i, o, e = ssh.exec_command('powershell -NoProfile -ExecutionPolicy Bypass -File "%s"' % REMOTE_PS, timeout=180)
print("stdout:", o.read().decode("gbk", "replace")[:300])
print("stderr:", e.read().decode("gbk", "replace")[:300])
time.sleep(1)
print("=== %s OCR 结果 ===" % HOST)
print(sftp.open(REMOTE_OUT, "rb").read().decode("utf-8-sig"))
sftp.close()
ssh.close()
