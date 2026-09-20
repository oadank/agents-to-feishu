# reasonix 模型配置说明（单页 · 2026-09-20，全部行号取自现值 config.toml 20559B）

配置文件：`%APPDATA%\reasonix\config.toml`（= `C:\Users\oadan\AppData\Roaming\reasonix\`）。改前必备份、改后需滚 reasonix 桥才吃新配置；**未经拍板不擅动**（WB 票2 案已定此红线）。

## 现行关键行
| 行 | 键 | 现值 | 含义 |
|---|---|---|---|
| 7 | `default_model` | `"litellm/QW3.8F"` | 主模型走本机 LiteLLM 网关的 QW3.8F（换模型只动 provider/model 前缀） |
| 9 | `credentials_store` | `"auto"` | 各家 API key 不在本文件，存全局 `.env`（同目录） |
| 33 | `provider_access` | `["aliyun-tp","deepseek","litellm"]` | 桌面端设置页可见的三家供应商 |
| 62 | 启动环境摘要 | `enabled=true` | 每轮注入稳定环境摘要进 prompt |
| 75-85 | recovery/planner/vision/subagent_model | **全部注释=未启用** | 双模型协作、图片转述、子代理换脑都没开 |
| 93+ | `[[providers]]` | deepseek 官方直连 base_url | 备用供应商段 |

## 沙箱（exit 126 / 10s 超时案关联）
- 权限文件：`windows-sandbox-capabilities-v1\*.json`；`allow_write` 曾配 `C:\D\opt` 整盘（59845+ 条目），ACL 传播跑不进 10s 检查窗口 → bash exit 126 + 沙箱超时。09-19 WB 收窄 + 09-20 dsh 修复后 status=active，10s 现象消失。
- 教训：**给沙箱的写权限要窄目录**，宽盘根 = 检查超时，不是引擎硬编码预算（09-19 旧结论已作废）。

## 备份谱系
同目录 `config.toml.bak-*` 是历次事故现场（wb-126fix / dsh-sandboxfix / dropmcp / openmem 等），**留档不删**；想回滚照文件名日期挑。
