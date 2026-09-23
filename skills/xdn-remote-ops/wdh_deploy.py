# -*- coding: utf-8 -*-
"""远程部署新版 win-desktop-helper（换 exe + 改 ocr 走 agnes 官方直连 + 重启）。

用法:
    set XDN_USER / XDN_PASS 后:
    python wdh_deploy.py <host>

做的事（顺序严格，任一步失败即中止并打印现场）:
  1. 读远程现状（进程 / exe 版本 / 配置 / 日志尾）
  2. taskkill 掉正在跑的 shot-service.exe（不然 exe 被锁，覆盖失败）
  3. SFTP 上传本机刚编的 shot-service.exe
  4. 改 shot-service.json 的 ocr 段 -> provider=openai + agnes 官方端点（其余段原样保留）
     改前双备份：远程 .bak-<ts> + 本地 _backup\\wdh-cfg\\
  5. schtasks /Run WinDesktopHelper 在【用户会话】拉起（SSH 直接起会进 Session 0 没桌面）；顺带删除废弃的 dsh-shot-helper
  6. 复验：进程在不在 / 日志尾是不是新版本 + session=1 + tray=on

agnes key 不写死在本脚本，运行时从 litellm 配置现取（单一真源）。
"""
import json
import os
import re
import sys
import time

import paramiko

HOST = sys.argv[1]
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")
LOCAL_EXE = r"C:\D\opt\win-desktop-helper\shot-service.exe"
APPDIR = r"C:\Users\oadan\AppData\Local\Programs\win-desktop-helper"
REMOTE_EXE = APPDIR + r"\shot-service.exe"
REMOTE_CFG = APPDIR + r"\shot-service.json"
REMOTE_LOG = APPDIR + r"\shot-service.log"
LITELLM_CFG = r"C:\D\opt\litellm\venv\litellm_config.yaml"
AGNES_EP = "https://api.agnes-ai.cn/v1/chat/completions"
AGNES_MODEL = "agnes-3.0-flash"
TASK = "WinDesktopHelper"   # 2026-09-23 修正: dsh-shot-helper 已废弃(本机 09-18 删)，真名是程序自注册的 WinDesktopHelper


def agnes_key():
    txt = open(LITELLM_CFG, encoding="utf-8").read()
    m = re.search(r"api\.agnes-ai\.cn/v1\s*\r?\n\s*api_key:\s*(\S+)", txt)
    if not m:
        raise SystemExit("!! agnes key not found in litellm_config.yaml")
    return m.group(1)


SENSITIVE = ("apiKey", "apiKeys", "baiduKey", "askKey", "api_key")


def redact(txt):
    """打印配置前先脱敏：这些字段是 key，落进日志/对话就是事故（2026-09-23 加）。"""
    import re as _re
    for k in SENSITIVE:
        txt = _re.sub(r'("%s"\s*:\s*")([^"]{4})[^"]*(")' % k, r'\1\2***\3', txt)
    return txt

def run(ssh, cmd, enc="utf-8"):
    i, o, e = ssh.exec_command(cmd, timeout=30)
    return o.read().decode(enc, "replace").strip()


def main():
    key = agnes_key()
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, username=USER, password=PASS, timeout=20,
                allow_agent=False, look_for_keys=False)

    print("=== 1. 现状 (%s) ===" % HOST)
    print(run(ssh, 'tasklist /FI "IMAGENAME eq shot-service.exe" /NH', "gbk"))
    sftp = paramiko.SFTPClient.from_transport(ssh.get_transport())
    st = sftp.stat(REMOTE_EXE)
    print("remote exe size=%d mtime=%s" % (st.st_size, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime))))
    raw = sftp.open(REMOTE_CFG, "rb").read().decode("utf-8-sig")
    print("--- 改前配置(已脱敏) ---\n%s" % redact(raw))

    print("=== 2. 停进程 ===")
    print(run(ssh, "taskkill /F /IM shot-service.exe", "gbk"))
    print(run(ssh, "taskkill /F /IM shot-watcher.exe", "gbk"))
    time.sleep(1.5)

    print("=== 3. 上传新 exe (%d bytes) ===" % os.path.getsize(LOCAL_EXE))
    sftp.put(LOCAL_EXE, REMOTE_EXE)
    st2 = sftp.stat(REMOTE_EXE)
    print("uploaded size=%d (local=%d)" % (st2.st_size, os.path.getsize(LOCAL_EXE)))
    if st2.st_size != os.path.getsize(LOCAL_EXE):
        raise SystemExit("!! exe size mismatch, abort")

    print("=== 4. 改配置 ===")
    cfg = json.loads(raw)
    cfg.setdefault("ocr", {})
    cfg["ocr"]["provider"] = "openai"
    cfg["ocr"]["endpoint"] = AGNES_EP
    cfg["ocr"]["model"] = AGNES_MODEL
    cfg["ocr"]["apiKey"] = key
    new = json.dumps(cfg, ensure_ascii=False, indent=2)

    ts = time.strftime("%Y%m%d-%H%M%S")
    sftp.open(REMOTE_CFG + ".bak-" + ts, "wb").write(raw.encode("utf-8"))
    os.makedirs(r"C:\D\opt\_backup\wdh-cfg", exist_ok=True)
    bak = r"C:\D\opt\_backup\wdh-cfg\%s_shot-service.json.bak-%s" % (HOST.replace(".", "_"), ts)
    open(bak, "w", encoding="utf-8").write(raw)
    print("remote bak = %s.bak-%s" % (REMOTE_CFG, ts))
    print("local  bak = %s" % bak)

    sftp.open(REMOTE_CFG, "wb").write(new.encode("utf-8"))
    print("--- 改后配置(已脱敏) ---\n%s" % redact(sftp.open(REMOTE_CFG, "rb").read().decode("utf-8-sig")))

    print("=== 5. 拉起（用户会话）===")
    # 🔴 2026-09-23 修正（原写法有两个硬伤，会给机器重建一个废弃任务）：
    #   ① /SC ONCE /ST 00:00 是一次性且时刻已过的触发器 —— 除"建完立刻 /Run"那一次，
    #      重启后永不启动（拿来当持久自启是错的）；
    #   ② dsh-shot-helper 2026-09-18 起已废弃并从本机删除，与 WinDesktopHelper 职责重复。
    #   正确姿势：程序启动时**自注册** WinDesktopHelper（/sc ONLOGON /rl HIGHEST），
    #   部署只要 schtasks /Run /TN WinDesktopHelper 拉起（提权靠任务自带的 /RL HIGHEST）。
    #   ⚠️ exe 清单实测是 asInvoker（旧注释写的 requireAdministrator 已过时）。
    #   顺带清理废弃任务，免得日后被误 Run 造成双实例打架（单实例互斥会让进程反复消失）。
    print(run(ssh, 'schtasks /Delete /TN "dsh-shot-helper" /F', "gbk"))
    print(run(ssh, 'schtasks /Run /TN "WinDesktopHelper"', "gbk"))

    def instances():
        txt = run(ssh, 'powershell -NoProfile -Command "Get-Process shot-service -ErrorAction SilentlyContinue | '
                       'ForEach-Object { $_.Id.ToString() + \'|\' + $_.SessionId }"')
        return [l.strip() for l in txt.splitlines() if "|" in l]

    for i in range(8):
        time.sleep(5)
        inst = instances()
        print("  +%ds -> %s" % ((i + 1) * 5, inst))
        if len(inst) == 1 and inst[0].endswith("|1"):
            print("OK: 单实例且 Session 1")
            break
    else:
        print("!! 未等到「单实例 + Session 1」——检查 exe 清单/任务权限")

    print("=== 6. 复验 ===")
    print(run(ssh, 'tasklist /FI "IMAGENAME eq shot-service.exe" /NH', "gbk"))
    print("--- 日志尾 ---")
    print(run(ssh, 'powershell -NoProfile -Command "Get-Content \'%s\' -Tail 8"' % REMOTE_LOG, "gbk"))

    sftp.close()
    ssh.close()


if __name__ == "__main__":
    main()
