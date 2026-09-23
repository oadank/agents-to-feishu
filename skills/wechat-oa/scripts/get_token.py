# -*- coding: utf-8 -*-
"""
获取并缓存微信公众号 access_token。

凭据来源（按优先级，先命中先用）：
  1. 环境变量 WECHAT_OA_APPID + WECHAT_OA_APPSECRET
  2. 环境变量 WECHAT_OA_CONFIG 指向的 json 文件
  3. ~/.wechat-oa/config.json          ← 本机真源（凭据永不进仓库）
  4. <技能目录>/config.json            ← 兼容旧放法，仓库里不放此文件

token 缓存一律落在仓外 ~/.wechat-oa/.cache/，不落技能目录（那目录在 git 仓内，
access_token 属临时凭据，绝不能被 git 看见）。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.dirname(SCRIPT_DIR)
HOME_DIR = os.path.expanduser("~")
# 仓外真源目录（凭据 + 缓存都在这一处，与 git 仓无关）
DATA_DIR = os.environ.get("WECHAT_OA_DATA_DIR") or os.path.join(HOME_DIR, ".wechat-oa")
CACHE_DIR = os.path.join(DATA_DIR, ".cache")
TOKEN_CACHE_PATH = os.path.join(CACHE_DIR, "access_token.json")

CONFIG_CANDIDATES = [
    os.environ.get("WECHAT_OA_CONFIG", ""),
    os.path.join(DATA_DIR, "config.json"),
    os.path.join(SKILL_ROOT, "config.json"),
]


def _candidate_paths():
    seen = set()
    for p in CONFIG_CANDIDATES:
        if p and p not in seen and os.path.exists(p):
            seen.add(p)
            yield p


def load_config():
    appid = os.environ.get("WECHAT_OA_APPID", "").strip()
    appsecret = os.environ.get("WECHAT_OA_APPSECRET", "").strip()
    if appid and appsecret:
        return {"appid": appid, "appsecret": appsecret, "source": "env"}

    for path in _candidate_paths():
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            continue
        if cfg.get("appid") and cfg.get("appsecret"):
            return {
                "appid": cfg["appid"],
                "appsecret": cfg["appsecret"],
                "account_name": cfg.get("account_name", ""),
                "source": path,
            }

    raise RuntimeError(
        "找不到公众号凭据：设 WECHAT_OA_APPID/WECHAT_OA_APPSECRET，"
        "或在 %s\\config.json 放 appid/appsecret" % DATA_DIR
    )


def get_access_token(force_refresh=False):
    os.makedirs(CACHE_DIR, exist_ok=True)

    if not force_refresh and os.path.exists(TOKEN_CACHE_PATH):
        try:
            with open(TOKEN_CACHE_PATH, "r", encoding="utf-8") as f:
                cache = json.load(f)
            if cache.get("expires_at", 0) > time.time() + 300:
                return cache["access_token"]
        except Exception:
            pass

    cfg = load_config()
    url = ("https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential"
           "&appid=%s&secret=%s" % (cfg["appid"], cfg["appsecret"]))

    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8") if e.fp else str(e)
        print(f"HTTP错误: {e.code} - {err}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"网络错误: {e}", file=sys.stderr)
        sys.exit(1)

    if "access_token" not in data:
        # 只报错误码，绝不回显 appsecret
        print("获取token失败: errcode=%s %s" % (data.get("errcode"), data.get("errmsg", "")),
              file=sys.stderr)
        if data.get("errcode") == 40164:
            print("  ↳ 公众号后台「设置与开发→基本配置→IP白名单」加上报错里那个 IP；"
                  "保存后等几分钟才生效（微信侧有延迟，不是没存上）", file=sys.stderr)
        sys.exit(1)

    token = data["access_token"]
    expires_in = data.get("expires_in", 7200)
    with open(TOKEN_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump({"access_token": token, "expires_at": time.time() + expires_in},
                  f, ensure_ascii=False, indent=2)
    try:
        os.chmod(TOKEN_CACHE_PATH, 0o600)
    except Exception:
        pass

    return token


if __name__ == "__main__":
    force = "--force" in sys.argv
    if "--where" in sys.argv:
        # 只报凭据来自哪，不打印任何值
        print(load_config()["source"])
        sys.exit(0)
    print(get_access_token(force_refresh=force))
