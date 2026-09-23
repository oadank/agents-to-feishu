# -*- coding: utf-8 -*-
"""SFTP 精确改远程 win-desktop-helper 配置（文本替换，保留原格式；改前本地+远程双备份）"""
import os, sys, io, time
import paramiko

HOST = sys.argv[1]
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")
APPID = sys.argv[2]
KEY = sys.argv[3]

REMOTE = r"C:\Users\oadan\AppData\Local\Programs\win-desktop-helper\shot-service.json"

t = paramiko.Transport((HOST, 22))
t.connect(username=USER, password=PASS)
sftp = paramiko.SFTPClient.from_transport(t)

raw = sftp.open(REMOTE, "rb").read().decode("utf-8-sig")

print("=== BEFORE ===")
print(raw)

ops = [
    ('"provider": "local"', '"provider": "baidu"'),
    ('"baiduAppId": ""', '"baiduAppId": "%s"' % APPID),
    ('"baiduKey": ""', '"baiduKey": "%s"' % KEY),
]

new = raw
for a, b in ops:
    n = new.count(a)
    if n == 0:
        print("!! MISS: %s" % a)
    new = new.replace(a, b)
    print("   replaced %d x  %s" % (n, a[:40]))

# 备份（远程 + 本地）
ts = time.strftime("%Y%m%d-%H%M%S")
sftp.open(REMOTE + ".bak-" + ts, "wb").write(raw.encode("utf-8"))
os.makedirs(r"C:\D\opt\_backup\wdh-cfg", exist_ok=True)
bakname = r"C:\D\opt\_backup\wdh-cfg\%s_shot-service.json.bak-%s" % (HOST.replace(".", "_"), ts)
io.open(bakname, "w", encoding="utf-8").write(raw)
print("remote backup = %s.bak-%s" % (REMOTE, ts))
print("local  backup = %s" % bakname)

sftp.open(REMOTE, "wb").write(new.encode("utf-8"))
print("=== AFTER ===")
print(sftp.open(REMOTE, "rb").read().decode("utf-8-sig"))
sftp.close(); t.close()
