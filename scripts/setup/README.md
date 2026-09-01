# 新机器部署 agents-to-feishu（小白版）

目标：clone 下来 → 跑向导 → 填几个 key → 10 个 bot 在飞书跑起来。

> **最省事的用法**：把本文件整个发给你的 AI（Claude/Codex 等），说「按这个文档帮我部署」，让它自己跑命令、自己排错。人只需要准备好：网络能访问 GitHub / npm / 飞书开放平台，以及下面提到的几个 key。

## 0. 前置（装一次）

1. **Node.js ≥ 20**：https://nodejs.org 装 LTS 版
2. **Git**：https://git-scm.com
3. **nssm**：https://nssm.cc/download，把 `nssm.exe` 放进 `C:\Windows\System32`
4. 拉代码并装依赖：
   ```
   git clone https://github.com/oadank/agents-to-feishu C:\D\opt\agents-to-feishu
   cd C:\D\opt\agents-to-feishu
   npm install
   ```

## 1. 引擎（bot 用谁装谁）

跑检查看缺什么：
```
node scripts\setup.mjs --check
```
缺的引擎按提示装（claude/codex/gemini/opencode/mimo/openclaw 都是 `npm i -g xxx`；hermes/reasonix/openakita/dsh 见各自 hint）。**没装的引擎对应 bot 先不用，不影响其他 bot 跑。**

## 2. 跑向导

```
node scripts\setup.mjs
```
它会依次：
1. 检查环境
2. 检测 10 个引擎 CLI
3. 问你要 key（GW_API_KEY 必须，其他可选；填好的会跳过）
4. 问你要 10 个飞书应用的 appId/appSecret（去 https://open.feishu.cn 建应用、开机器人能力、给消息读写权限；嫌一个个填慢就先写个 json 再 `--apps apps.json` 导入）
5. 生成 `~\.agents-to-feishu\config-store.json`（人设/模型/MCP 全带好了）
6. 渲染每个 bot 的 `config.<bot>.env`
7. 注册 nssm 服务（默认不启动）

非交互一条龙（推荐）：
```
node scripts\setup.mjs --yes --creds creds.json --apps apps.json
```
`creds.json` 格式：`{"GW_API_KEY":"...", "DEEPSEEK_API_KEY":"...", "GITHUB_TOKEN":"..."}`
`apps.json` 格式：`{"claude":{"appId":"cli_xxx","appSecret":"xxx"}, ...}`

## 3. 启动 + 验证

```
nssm start config-center   # 配置中心 :13600（没有这个服务就先 scripts\deploy-agents.ps1 -Start）
curl http://127.0.0.1:13600/health
for %b in (claude codex) do nssm start %b
node scripts\feishu-verify.mjs claude "gh api user --jq .login"
```
每 bot 验证三件套（gh 自证 / 搜索 / 状态行）：发 `gh api user --jq .login` 看回 `oadank`（换成你自己的 token 后是你的号）。

## 4. 特殊引擎补丁

- **openakita**：装完 pip 包后必须跑 `python scripts\openakita-patches\apply.py`（anysearch 搜索源 + Clash fake-ip 放行，见该目录 README）
- **codex**：`~\.codex\config.toml` 里配 anysearch MCP（streamable_http + Bearer key）
- **reasonix**：人设文案别写「。**只读查询**（…）」这种开头——会被它的约束引擎误判成禁变更（详见技能 agents-to-feishu-dev #13）

## 5. 常见问题

| 症状 | 看哪 | 多半是 |
|---|---|---|
| bot 不回消息 | `logs\<bot>-err.log` | 飞书 appId/secret 错、服务没起 |
| 「initialize timeout」反复 | 同上 | 引擎 CLI 没装/没登录；重启 `nssm restart <bot>`（悬挂已修复会自愈） |
| gh 说不在 PATH | 服务日志 | 新装的 CLI 要重启服务（PATH 快照）|
| 状态行 🎯🟰 空 | `~\.dsh\<bot>-bot\stats\` | 引擎不报 usage（reasonix 闭源无解，其余已修）|
| 路径不在 C:\D\opt | — | `setup.mjs --home <你的home>`；deploy-agents.ps1 已支持 `-RepoDir -UserHome` |

## 6. 注意事项（AI 部署前必读的坑，全是踩过的）

**环境类（新机器最容易翻车）：**

1. **用户级环境变量污染**：如果机器上设过 `ANTHROPIC_BASE_URL`（比如装过 LiteLLM 代理），它会漏进所有 bot 服务进程，把 claude bot 的请求打到错误网关。部署前 `echo %ANTHROPIC_BASE_URL%`（PowerShell：`$env:ANTHROPIC_BASE_URL`）检查，有就删掉或确认指向正确网关。
2. **nssm 服务账号**：服务默认 LocalSystem，它的 `USERPROFILE` 指向 `systemprofile`，读不到你用户目录下的配置。bot 的关键路径（CTI_HOME/CTI_USER_HOME）脚本已显式注入，但如果某引擎 CLI 需要读用户目录（如 `~/.codex`），把服务改成你的账号：`nssm set <bot> ObjectName .\你的用户名 密码` 后重启服务。
3. **PATH 快照**：nssm 注册时把当前 PATH 写死进服务。**新装引擎 CLI 后必须 `nssm restart <bot>`**，否则服务找不到新命令。
4. **git 仓库 = 禁区**：任何服务/CLI 子进程不要在 git 仓库目录里跑（会话无桌面时 git 会永久卡死）。向导已把 bot 工作目录设为 `<home>\agent-work`，别改成仓库路径。
5. **PowerShell 脚本编码**：本仓库的 .ps1 带 UTF-8 BOM，不要用会丢 BOM 的编辑器另存，否则中文注释会让 PowerShell 5.1 语法报错。

**运行类（部署后遇到再看）：**

6. **nssm 快速循环重启会残留僵尸进程**：服务反复崩溃重启后，可能有旧的 tsx/node 子进程没死透、抢飞书消息。排查：`wmic process where "name='node.exe'" get processid,commandline`，发现多余的杀掉再 `nssm restart`。
7. **飞书 @ 限流**：连续 @ bot 测试要间隔 ≥28 秒，太快会被飞书静默吞掉消息（不报错、就是不回）。
8. **openakita 升级/重装后补丁会丢**：补丁打在 venv 的 site-packages 里，`pip install --upgrade openakita` 后必须重跑 `python scripts\openakita-patches\apply.py`。
9. **win-desktop-helper MCP**：模板里带的桌面助手 MCP 指向私有路径，新机器上没有会静默跳过（不影响其他功能），不需要就去 config-center UI（:13600）删掉。
10. **searxng 兜底源**：部分 bot 配了自建 searxng 聚合搜索做兜底，那是作者私有服务（100.110.110.12），新机器上不可用是正常的——主搜索走 anysearch，不需要 searxng；要兜底就在 config-center UI 里改 MCP 配置。
