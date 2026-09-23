# -*- coding: utf-8 -*-
"""远程重启 win-desktop-helper，并确保【恰好一个实例、跑在用户会话 Session 1】。

为什么需要它：SSH 里直接起 exe 会落到 Session 0（没桌面、没托盘、抓不到屏）。
唯一可靠姿势 = schtasks /Run 那个 /it 交互式任务；但首次 /Run 有时还没生效，
所以这里 kill 干净 -> /Run -> 轮询等它出现在 Session 1 -> 报最终状态。

用法: set XDN_USER/XDN_PASS 后 python wdh_restart.py <host>
"""
import os
import sys
import time

import paramiko

HOST = sys.argv[1]
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")
APPDIR = r"C:\Users\oadan\AppData\Local\Programs\win-desktop-helper"
TASK = "dsh-shot-helper"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, 22, username=USER, password=PASS, timeout=20,
            allow_agent=False, look_for_keys=False)


def run(cmd, enc="gbk", timeout=40):
    i, o, e = ssh.exec_command(cmd, timeout=timeout)
    return (o.read().decode(enc, "replace") + e.read().decode(enc, "replace")).strip()


def instances():
    """返回 [(pid, session, mem)]"""
    txt = run('powershell -NoProfile -Command "Get-Process shot-service -ErrorAction SilentlyContinue | '
              'ForEach-Object { $_.Id.ToString() + \'|\' + $_.SessionId }"')
    res = []
    for line in txt.splitlines():
        line = line.strip()
        if "|" in line:
            pid, sess = line.split("|", 1)
            res.append((pid.strip(), sess.strip()))
    return res


print("=== kill 全部实例 ===")
print(run("taskkill /F /IM shot-service.exe"))
time.sleep(2)
print("剩余:", instances())

print("=== schtasks /Run ===")
print(run('schtasks /Run /TN "%s"' % TASK))

for i in range(8):
    time.sleep(5)
    inst = instances()
    print("  +%ds -> %s" % ((i + 1) * 5, inst))
    if len(inst) == 1 and inst[0][1] == "1":
        print("OK: 单实例且 Session 1")
        break
else:
    print("!! 未等到「单实例 + Session 1」")

print("=== 日志尾 ===")
print(run('powershell -NoProfile -Command "Get-Content \'%s\\shot-service.log\' -Tail 4"' % APPDIR))
print("=== 最终 ===")
print(run('tasklist /FI "IMAGENAME eq shot-service.exe" /NH'))
ssh.close()
