"""openakita venv 补丁一键应用（2026-09-01）.

覆盖 venv site-packages 里 openakita 官方包的 4 处手术，新机器装完 openakita 跑一次即可：

  1. tools/web_search/providers/anysearch.py   — 新增 anysearch 搜索源（MCP tools/call）
  2. tools/web_search/registry.py              — 注册 anysearch（auto_detect_order=12）
  3. config.py                                 — 加 anysearch_api_key / trust_proxy_fakeip 字段
  4. utils/url_safety.py                       — trust_proxy_fakeip=true 时放行 Clash fake-ip
                                                 （198.18.0.0/15 + fdfe:dcba:9876::/48），
                                                 其余 private/loopback/metadata 照拦

用法：
  python apply.py                          # 默认 venv=C:/D/opt/openakita/venv
  python apply.py --venv <venv路径>
  python apply.py --env <workspace/.env>   # 顺带补 .env 里缺的两个变量（不含 key 本身）

幂等：已打过的补丁自动跳过。openakita 升级会覆盖 venv → 升级后重跑本脚本，
并对照 README.md 里的锚点核对上游代码是否变了。
注意：本脚本不包含 repo 里的 openakita-acp-server.py（adapter usage drain 修复）——
那个本来就跟着 agents-to-feishu 仓库走，clone 即有。
"""

from __future__ import annotations

import argparse
import shutil
import sys
from datetime import date
from pathlib import Path

_DEFAULT_VENV = Path("C:/D/opt/openakita/venv")
_PKG = Path("Lib/site-packages/openakita")

# ── 补丁 2：registry.py 注册 anysearch ──────────────────────────────
REGISTRY_OLD = (
    "    from .providers import bocha, duckduckgo, jina, searxng, tavily  # noqa: F401"
)
REGISTRY_NEW = (
    "    from .providers import anysearch, bocha, duckduckgo, jina, searxng, tavily  # noqa: F401"
)

# ── 补丁 3：config.py 加两个 settings 字段（插在 bocha_api_key 前）──
CONFIG_ANCHOR = "    bocha_api_key: str = Field("
CONFIG_INSERT = '''    anysearch_api_key: str = Field(
        default="",
        description="Anysearch MCP 搜索 API Key（申请：https://anysearch.com；2026-09-01 自研接入）",
    )
    trust_proxy_fakeip: bool = Field(
        default=False,
        description=(
            "信任代理 fake-ip：Clash TUN fake-ip 模式下所有域名都解析到 198.18.0.0/15，"
            "开启后 SSRF 防护放行该网段（其余 private 段照拦）。仅在本机明确跑着代理时开启"
        ),
    )
'''

# ── 补丁 4：url_safety.py fake-ip 放行 ──────────────────────────────
URLSAFETY_ANCHOR = '_PROXY_INTERCEPT_NET = ipaddress.ip_network("198.18.0.0/15")'
URLSAFETY_INSERT = '''_PROXY_INTERCEPT_NET = ipaddress.ip_network("198.18.0.0/15")
# 2026-09-01 patch：Clash/mihomo fake-ip 的 IPv6 段（fd00::/8 内），DNS 轮询可能先返回 v6
_PROXY_INTERCEPT_NET_V6 = ipaddress.ip_network("fdfe:dcba:9876::/48")


def _trust_proxy_fakeip() -> bool:
    """Lazy-read settings singleton; never raises (SSRF guard must stay fail-closed)."""
    try:
        from openakita.config import settings  # noqa: PLC0415 — 延迟导入避免循环依赖
        return bool(getattr(settings, "trust_proxy_fakeip", False))
    except Exception:
        return False


def _is_proxy_intercept(addr: "ipaddress._BaseAddress") -> bool:
    if isinstance(addr, ipaddress.IPv4Address) and addr in _PROXY_INTERCEPT_NET:
        return True
    if isinstance(addr, ipaddress.IPv6Address) and addr in _PROXY_INTERCEPT_NET_V6:
        return True
    return False
'''
URLSAFETY_BLOCK_OLD = '''    if isinstance(addr, ipaddress.IPv4Address) and addr in _PROXY_INTERCEPT_NET:
        return (
            "reserved benchmark range 198.18.0.0/15, often caused by proxy/TUN/DNS "
            "interception"
        )
'''
URLSAFETY_BLOCK_NEW = '''    # 2026-09-01 patch：Clash TUN fake-ip 模式下所有域名都解析到 198.18.0.0/15（v4）
    # 或 fdfe:dcba:9876::/48（v6），显式配置 trust_proxy_fakeip=true 时放行
    # （连接由代理接管转发，非真实内网地址）；未配置时维持原防护，
    # 其余 private/loopback/metadata 段不受影响
    if _is_proxy_intercept(addr):
        if _trust_proxy_fakeip():
            return ""
        if isinstance(addr, ipaddress.IPv4Address):
            return (
                "reserved benchmark range 198.18.0.0/15, often caused by proxy/TUN/DNS "
                "interception"
            )
        return "private address"
'''

ENV_HINTS = [
    ("ANYSEARCH_API_KEY", "as_sk_xxx（anysearch.com 申请，每台机器自己的 key）"),
    ("TRUST_PROXY_FAKEIP", "1（本机跑 Clash TUN fake-ip 才开）"),
]


def patch(path: Path, fn, label: str) -> str:
    if not path.exists():
        return f"[SKIP] {label}: {path.name} 不存在（openakita 版本变了？核对锚点）"
    src = path.read_text(encoding="utf-8")
    out, note = fn(src)
    if note == "already":
        return f"[OK]  {label}: 已打过，跳过"
    if out is None:
        return f"[FAIL] {label}: 锚点没找到——上游代码变了，手工核对 {path}"
    bak = path.with_suffix(path.suffix + f".bak-{date.today():%Y%m%d}")
    if not bak.exists():
        shutil.copy2(path, bak)
    path.write_text(out, encoding="utf-8")
    return f"[OK]  {label}: 已写入（备份 {bak.name}）"


def p_registry(src: str):
    if "anysearch" in src:
        return src, "already"
    if REGISTRY_OLD not in src:
        return None, "anchor-missing"
    return src.replace(REGISTRY_OLD, REGISTRY_NEW, 1), "patched"


def p_config(src: str):
    if "anysearch_api_key" in src:
        return src, "already"
    if CONFIG_ANCHOR not in src:
        return None, "anchor-missing"
    return src.replace(CONFIG_ANCHOR, CONFIG_INSERT + CONFIG_ANCHOR, 1), "patched"


def p_urlsafety(src: str):
    if "_is_proxy_intercept" in src:
        return src, "already"
    if URLSAFETY_ANCHOR not in src or URLSAFETY_BLOCK_OLD not in src:
        return None, "anchor-missing"
    src = src.replace(URLSAFETY_ANCHOR, URLSAFETY_INSERT, 1)
    src = src.replace(URLSAFETY_BLOCK_OLD, URLSAFETY_BLOCK_NEW, 1)
    return src, "patched"


def p_anysearch(venv: Path, templates: Path) -> str:
    dst = venv / _PKG / "tools/web_search/providers/anysearch.py"
    if dst.exists():
        return "[OK]  anysearch provider: 已存在，跳过"
    src = templates / "providers/anysearch.py"
    if not src.exists():
        return "[FAIL] anysearch provider: 模板缺失（本目录 providers/anysearch.py）"
    shutil.copy2(src, dst)
    return f"[OK]  anysearch provider: 已复制"


def main() -> int:
    ap = argparse.ArgumentParser(description="openakita venv 补丁应用")
    ap.add_argument("--venv", default=str(_DEFAULT_VENV))
    ap.add_argument("--env", default="", help="workspace .env 路径，补缺失变量")
    args = ap.parse_args()

    venv = Path(args.venv)
    pkg = venv / _PKG
    if not pkg.exists():
        print(f"[FAIL] 找不到 {pkg}，确认 venv 路径")
        return 1
    templates = Path(__file__).resolve().parent

    print(f"venv: {venv}\n")
    print(p_anysearch(venv, templates))
    print(patch(pkg / "tools/web_search/registry.py", p_registry, "registry 注册 anysearch"))
    print(patch(pkg / "config.py", p_config, "config 两个新字段"))
    print(patch(pkg / "utils/url_safety.py", p_urlsafety, "url_safety fake-ip 放行"))

    if args.env:
        envp = Path(args.env)
        if envp.exists():
            text = envp.read_text(encoding="utf-8", errors="replace")
            missing = [k for k, _ in ENV_HINTS if not any(
                ln.startswith(k + "=") for ln in text.splitlines())]
            if missing:
                with envp.open("a", encoding="utf-8") as f:
                    f.write("\n# 2026-09-01 openakita-patches 追加（值请手工补全）\n")
                    for k, hint in ENV_HINTS:
                        if k in missing:
                            f.write(f"# {k}={hint}\n")
                print(f"\n.env: 已追加缺失变量注释行 {missing}（值手工填）")
            else:
                print("\n.env: 变量齐全")

    print("\n验证：cd <workspace> && python -c \"from openakita.utils.url_safety import is_safe_url_sync;"
          " print(is_safe_url_sync('https://openai.com'))\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
