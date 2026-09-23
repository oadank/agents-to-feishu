"""XDN 远程体检 —— 一次拿全：开机时长 / GPU / 每进程显存 / Ollama / ComfyUI / helper 预热痕迹。

用法：
    python probe.py                            # 默认体检
    python probe.py "nvidia-smi" "ollama ps"   # 自定义命令（可给多条）

凭据来自环境变量 XDN_HOST / XDN_USER / XDN_PASS / XDN_PORT（取法见 SKILL.md）。
"""
import base64
import os
import sys

import paramiko

HOST = os.environ.get("XDN_HOST", "")
PORT = int(os.environ.get("XDN_PORT", "22") or 22)
USER = os.environ.get("XDN_USER", "")
PASS = os.environ.get("XDN_PASS", "")

if not (HOST and USER and PASS):
    sys.exit("缺少 XDN_HOST / XDN_USER / XDN_PASS 环境变量（见 SKILL.md 第一节）")

WIN_HELPER = r"C:\Users\oadan\AppData\Local\Programs\win-desktop-helper"
OLLAMA_LOG = r"%LOCALAPPDATA%\Ollama\server.log"


def ps(script):
    """把 PowerShell 脚本编码成 EncodedCommand。

    ⚠️ SSH 走的是 cmd.exe，嵌套引号会被拆烂（`$_` 报 not recognized）。
    -EncodedCommand 用 UTF-16LE + base64，完全不经过 cmd 的引号解析 —— 唯一可靠姿势。
    ⚠️ 开头必须压掉 ProgressPreference，否则每条命令的 stderr 都会回一坨 CLIXML 噪音。
    """
    script = "$ProgressPreference='SilentlyContinue'; " + script
    b64 = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return f"powershell -NoProfile -EncodedCommand {b64}"


DEFAULT_CMDS = [
    ("开机时长(分钟)",
     ps("""[Math]::Round(((Get-Date)-(Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalMinutes,1)""")),

    ("GPU 概况",
     "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,driver_version --format=csv"),

    ("GPU 上的 compute 进程",
     "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv"),

    ("每进程显存(性能计数器 —— WDDM 下 nvidia-smi 全 N/A，只能靠这个)",
     ps(r"""Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty CounterSamples |
  Where-Object { $_.CookedValue -gt 50MB } |
  Sort-Object CookedValue -Descending | Select-Object -First 12 |
  ForEach-Object {
    $id = ($_.InstanceName -split '_')[1]
    $pn = (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName
    Write-Output ("{0,-8} {1,-28} {2,8} MB" -f $id, $pn, [math]::Round($_.CookedValue/1MB,0))
  }""")),

    ("Ollama 当前加载了什么",
     "ollama ps"),

    ("Ollama 加载记录(含调用方 IP；127.0.0.1=本机自启，其他=远程调用)",
     ps(r"""Select-String -Path "$env:LOCALAPPDATA\Ollama\server.log" -Pattern 'POST|keep_alive' -ErrorAction SilentlyContinue |
  Select-Object -Last 6 | ForEach-Object { $_.Line }""")),

    ("ComfyUI 状态",
     ps("""(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/system_stats -TimeoutSec 6).Content""")),

    ("ComfyUI 队列",
     ps("""(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/queue -TimeoutSec 6).Content""")),

    ("shot-service 预热痕迹(win-desktop-helper)",
     ps('Select-String -Path "' + WIN_HELPER + '\\shot-service.log" -Pattern "warmup" -ErrorAction SilentlyContinue | Select-Object -Last 4 | ForEach-Object { $_.Line }')),

    ("shot-service 主进程启动时间",
     ps("""Get-Process shot-service -ErrorAction SilentlyContinue | Select-Object Id,StartTime | Format-Table -AutoSize | Out-String""")),
]


def main():
    extra = sys.argv[1:]
    cmds = [("自定义: " + c, c) for c in extra] if extra else DEFAULT_CMDS

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=PORT, username=USER, password=PASS, timeout=20)
    try:
        for name, cmd in cmds:
            print("=" * 18, name)
            try:
                _, out, err = cli.exec_command(cmd, timeout=60)
                text = out.read().decode("utf-8", "replace").strip()
                errtext = err.read().decode("utf-8", "replace").strip()
                print(text or "(empty)")
                if errtext:
                    print("[stderr]", errtext[:300])
            except Exception as e:
                print("[FAIL]", type(e).__name__, e)
    finally:
        cli.close()


if __name__ == "__main__":
    main()
