# -*- coding: utf-8 -*-
"""
删除微信公众号草稿（draft/delete）。

用法：
    python delete_draft.py <media_id> [<media_id> ...] --yes

🔴 没有 --yes 一律拒绝执行 —— 删的是账号里的真东西，不许被顺手误触。
    只删草稿，本脚本不涉及任何"发布"接口。
"""
import json
import sys
import os
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from get_token import get_access_token

DELETE_API = "https://api.weixin.qq.com/cgi-bin/draft/delete?access_token={token}"


def delete_draft(token, media_id):
    payload = json.dumps({"media_id": media_id}).encode("utf-8")
    req = urllib.request.Request(
        DELETE_API.format(token=token),
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8") if e.fp else str(e)
        return {"errcode": e.code, "errmsg": err}
    except Exception as e:
        return {"errcode": -1, "errmsg": "%s: %s" % (type(e).__name__, e)}


def main():
    args = [a for a in sys.argv[1:] if a != "--yes"]
    confirmed = "--yes" in sys.argv[1:]

    if not args:
        print("用法: python delete_draft.py <media_id> [<media_id> ...] --yes", file=sys.stderr)
        sys.exit(2)
    if not confirmed:
        print("拒绝执行：删除草稿是不可逆动作，必须显式加 --yes 确认。\n"
              "待删 media_id: %s" % ", ".join(args), file=sys.stderr)
        sys.exit(2)

    token = get_access_token()
    failed = 0
    for mid in args:
        result = delete_draft(token, mid)
        if result.get("errcode", 0) == 0:
            print("已删除: %s" % mid)
        else:
            failed += 1
            print("删除失败: %s -> errcode=%s %s"
                  % (mid, result.get("errcode"), result.get("errmsg")), file=sys.stderr)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
