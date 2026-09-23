---
name: wechat-oa
description: 微信公众号两件事——①读任意公众号文章正文（伪装微信 UA 绕反爬风控）②把内容写进公众号草稿箱（建/列/删草稿、传封面图）。用户丢来 mp.weixin.qq.com 链接要看内容，或说"把这篇发到公众号草稿箱"时用。🔴 只进草稿箱，严禁发布。
---

# 微信公众号（wechat-oa）

真源：`C:\D\opt\agents-to-feishu\skills\wechat-oa\`（本目录，git 跟踪）。
账号：智能体agents研究社。Python 3.12，脚本只用标准库（`make_cover.py` 额外要 Pillow）。

## 先跑这个（两条命令看清环境死活）

```powershell
$env:PYTHONIOENCODING='utf-8'
$S='C:\D\opt\agents-to-feishu\skills\wechat-oa\scripts'
python $S\get_token.py --where          # 凭据从哪读的（不打印任何值）
python $S\list_drafts.py                # 能列出草稿 = 发布链全通
```

---

## 一、读文章（不需要凭据、不需要 token，谁都能跑）

```powershell
$env:PYTHONIOENCODING='utf-8'
python C:\D\opt\agents-to-feishu\skills\wechat-oa\scripts\read_article.py "<文章URL>" --format markdown
```

🔴 **编码坑**：PowerShell 里不设 `PYTHONIOENCODING=utf-8` 直接跑会 GBK 乱码；或 `| Out-File -Encoding utf8` 落文件再读。

### 「看不了」有三种，判别口诀

| 页面现象 | 是什么 | 办得了吗 |
|---|---|---|
| 「环境异常，完成验证后即可继续访问」/ 302 到 `wappoc_appmsgcaptcha` | **反爬风控** | 办得了：换微信 UA（本脚本已做）或走真浏览器 |
| 「兑换合集后可阅读剩余 XX%」 | **作者自己开的微信豆付费合集** | 办不了：服务端只下发免费部分，抓也没用 |
| 页面只有「参数错误」，无 `js_content` 无 `msg_title` | **链接本身死了**（被删/抄错/截断） | 办不了：找用户要新链接，别当风控瞎折腾 |

### 兜底通道：本机专用 Edge（真浏览器，任何文章都能读到它给的那部分）

```powershell
cd C:\D\opt\tools\yt-dlp
node cdp_tool.mjs nav "<文章URL>"                                  # 导航必须用这个，/json/new 裸开标签会停在 about:blank
$env:CDP_TARGET_URL='weixin'
node cdp_eval.mjs "return document.title + '|' + document.body.innerText"
node park_page.mjs                                                 # 🔴 干完必须收页面
```

🔴 **铁律**：借浏览器干活的脚本，成功/失败/超时都得把页面 park 回 `about:blank`。留着会自己播视频的页面 = 吵到主人，他会手动关窗口，下次任务直接废。

---

## 二、写进草稿箱（需要凭据 + IP 白名单）

```powershell
python $S\make_cover.py --title "标题" --subtitle "副标题" --output cover.jpg   # 没现成封面就生成一张
python $S\create_draft.py --title "标题" --content "<p>正文HTML或纯文本</p>" --author "作者" --digest "摘要" --thumb-image cover.jpg
python $S\list_drafts.py                     # 回读确认（打印 media_id）
python $S\delete_draft.py <media_id> --yes   # 删草稿必须显式 --yes，否则拒绝执行
python $S\upload_thumb.py <图片路径>          # 单独传封面图，返回永久素材 media_id
```

🔴 **坑：建草稿必须带封面**（实测 2026-09-23）。不传 `--thumb-image` → `thumb_media_id` 成空串 → 微信直接拒 `errcode=40007 invalid media_id`，报错字面完全看不出跟封面有关。脚本现在会在缺封面时提前点破。

`create_draft.py` 支持纯文本（自动按段落包 `<p>`）或自带 HTML。

### 🔴 安全红线（违反=闯祸）

1. **只准进草稿箱，严禁真发布。** 本技能所有脚本只碰 `draft/*` 接口，**没有也不需要** `freepublish/submit`。谁都不许自己加发布接口或手搓 curl 调它——发不发是主人在公众号后台亲手点的事。
2. **凭据不进仓库、不进聊天、不进记忆、不进人设。** appid/appsecret 的真源在 `C:\Users\oadan\.wechat-oa\config.json`（git 仓外）。脚本读取顺序：环境变量 `WECHAT_OA_APPID`+`WECHAT_OA_APPSECRET` → `WECHAT_OA_CONFIG` 指定文件 → `~/.wechat-oa/config.json` → 技能目录内 config.json（仓库里不放）。access_token 缓存也落仓外 `~/.wechat-oa/.cache/`，**别改回落技能目录**（那目录被 git 跟踪）。
3. 删草稿是不可逆动作，`delete_draft.py` 强制要 `--yes`；拿不到确切 media_id 就别删。

### 🔴 坑：errcode 40164 = IP 白名单

`获取token失败: invalid ip <IP> ... not in whitelist`

- 去公众号后台「设置与开发 → 基本配置 → IP白名单」，加上**报错里那个 IP**（不是 `ipify` 之类探测出来的 IP——本机走 Clash，不同域名分流到不同出口，微信 API 走直连，所以要看微信自己报的那个）。
- **保存后有延迟**，等几分钟再试。刚存就报 not in whitelist 不代表没存上，别急着改 IP 值。
- 家宽 IP 会变，变了这链就死，复发时按本条处理。

---

## 三、验证口径（改完脚本必须自己跑一遍）

- 读链：拿一条**活的**公众号链接跑 `read_article.py`，能出 `# 标题` + 正文段落才算通。
- 发布链：`list_drafts.py` 出「草稿总数: N」= token/白名单/接口三关全通。
- 建→查→删闭环：建一条标题带「测试-可删」的草稿 → `list_drafts.py` 亲眼读到它和它的 media_id → `delete_draft.py <id> --yes` 删掉 → 再 list 确认回到原数。

🔴 判过没过要**亲眼读输出全文**，不许用"有没有报错/行数对不对"代替阅读。
