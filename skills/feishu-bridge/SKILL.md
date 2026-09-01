# 技能：飞书桥接运维

当你需要处理 agents-to-feishu 的场景（消息不通、卡片不刷新、服务状态）时使用本技能。

## 常见问题速查

| 现象 | 原因 | 解法 |
|---|---|---|
| 飞书消息没回复 | agent 服务未运行 / ACP 卡死 | 检查 nssm 服务状态：`nssm status <agent短名>`；看日志 `logs/service-out.log` |
| 卡片一直"处理中" | ACP 流式事件未送达 / 网络 | 检查 config-center 的 `/api/agents/<id>/status` 返回，确认 ACP session 状态 |
| 插队卡不弹 | engine.isBusy 判断未触发 | 验证消息队列：同 chat 多条消息应串行排队 |
| 模型不回复 | provider key 失效 / 网关不可达 | 用 config-center 网页「看图配置」相邻的模型测试，或直接调 `/api/agents/<id>/apply` 重启 |

## 标准排查步骤

1. `nssm status <agent短名>` —— 服务是否 RUNNING（服务名 = agent 短名，如 gemini/dsh/claude）
2. 查日志：`C:\D\opt\agents-to-feishu\logs\` 下 agent 对应日志
3. 确认模型可用：config-center 网页 13600 → 对应 agent → 应用/重启
4. 若改过模型/provider：apply（重新生成配置 + 重启）