# 技能：ComfyUI 生图/生视频运维

当涉及本机 ComfyUI（8090）生图、XDN 远程生图/生视频、Lora 机制、卡死修复时使用本技能。

## 常用姿势

- 本机 ComfyUI 控制台：`http://127.0.0.1:8090`（nssm 服务）
- 远程生图/生视频真实引擎：XDN 100.119.140.33:8000（SSH oadan）
- 生图走 `/generate`，生视频走 `/api/comfy/generate`（config-center 转发）

## 卡死修复

| 现象 | 解法 |
|---|---|
| ComfyUI 无响应 / 队列堵塞 | 重启 8090 服务（nssm restart comfyui） |
| Lora 不生效 | 确认 lora 名与实际模型文件一致，检查 args 里 lora 段 |
| 生图超时 | 查 8090 日志，确认显存/内存是否占满 |

## 铁律

- 改 ComfyUI 配置前备份；操作后立即验证产出图
- 生图 prompt 中文可直传，出图后本地查看
