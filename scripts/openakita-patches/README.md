# openakita venv 补丁包（2026-09-01）

openakita 官方包（pip 装进 venv 的 site-packages）缺的能力，用 4 处手术补上。
**新机器部署 openakita bot 后跑一次 `python apply.py` 即可**，幂等可重跑。

## 补丁内容

| # | 文件 | 改动 | 解决什么 |
|---|------|------|---------|
| 1 | `tools/web_search/providers/anysearch.py` | 新增 | openakita 搜索源没有 anysearch → 新增 provider（MCP tools/call，priority=12，有 key 即最优先） |
| 2 | `tools/web_search/registry.py` | 1 行 | 注册 anysearch 进 provider 列表 |
| 3 | `config.py` | +2 字段 | `anysearch_api_key`（搜索 key）、`trust_proxy_fakeip`（SSRF 放行开关）。注意 Settings 无 env 前缀：.env 里写裸名 `ANYSEARCH_API_KEY` / `TRUST_PROXY_FAKEIP` |
| 4 | `utils/url_safety.py` | 放行逻辑 | Clash TUN fake-ip 模式下所有域名解析到 198.18.0.0/15（v4）/ fdfe:dcba:9876::/48（v6），web_fetch 被当内网全拦 → 配置 `TRUST_PROXY_FAKEIP=1` 时只放行这两个 fake-ip 段，**其余 private/loopback/metadata 照拦** |

## 不需要补丁的部分（跟 repo 走）

- `scripts/openakita-acp-server.py`（ACP adapter）：usage drain 修复（`done` 事件后不再 break，`_finalize_session` 能执行 → 状态行 🎯🟰 有数）——这个文件本来就在 agents-to-feishu 仓库里。
- 桥接 `src/providers/openakita.ts`：spawnPromise 悬挂修复、`_meta.usage` 消费——同上。

## 升级 openakita 后

venv site-packages 会被新版本覆盖：
1. 重跑 `python apply.py`（幂等，但锚点可能对不上）
2. `apply.py` 报 `[FAIL] 锚点没找到` 时，说明上游代码变了——对照 `.bak-*` 备份和上游新代码手工重打，然后更新本目录的锚点字符串
3. 验证三连：anysearch 直测 / `is_safe_url_sync('https://openai.com')` / 飞书私信端到端

## .env 需要（workspace `~/.openakita/workspaces/default/.env`）

```
ANYSEARCH_API_KEY=as_sk_xxx     # anysearch.com 申请，每人自己的
TRUST_PROXY_FAKEIP=1            # 仅本机跑 Clash TUN fake-ip 时开
```
