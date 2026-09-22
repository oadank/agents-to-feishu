# 提交前防呆（pre-commit）

本仓库是**公开**的（`oadank/agents-to-feishu`）。这里挡的不是"技术被人学走"（那些本来就公开），
而是**一次手滑把登录凭证推上去 = 账号送人**这种真事故。

## 新克隆的机器：跑一次才启用

```bash
git config core.hooksPath .githooks
```

⚠️ **不跑这条 hook 不会生效** —— git 的 hook 默认只认 `.git/hooks/`，
别以为文件在仓库里就有防护（那是假安全感）。

## 它挡什么

| 类别 | 规则 |
|---|---|
| 文件名 | `cookies*.txt/json`、`edge-video-profile/`、`*-profile/`、`node_modules/`、`*.exe/dll/so`、登录/验证码截图 |
| 文件内容（只扫文本类） | `sessionid=`、`ttwid=`、`odin_tt=`、`passport_csrf_token`、`sid_tt/sid_guard`、私钥、GitHub token、`sk-*` |
| 体积 | 单个文件 > 5MB |

手动体检（含全部已跟踪文件，不只是暂存区）：

```bash
node scripts/preflight-secrets.mjs --all
```

## 确认无误要强行提交

```bash
git commit --no-verify
```

## 起因（2026-09-21）

老大发现这个仓库是公开的，问"那推抖音那套东西有风险吗"。
结论：技术手法无所谓（本来网上就有），**但凭证泄露是真事故** —— 于是加了这层。
两层防护：`.gitignore` 挡未跟踪文件，本 hook 挡"已经 `git add -f` 进来的"。