---
name: comfyui-ops
description: 本机 ComfyUI 稳定服务（8090）与 XDN 远程生图/生视频：架构、卡死修复、lora 机制、运维姿势（自 dsh-ops 私产收编 2026-09-19，中央唯一版）
---

# ComfyUI 稳定服务（8090）

## 架构
- **本机控制服务** `C:\D\opt\comfyui\`（server.py，nssm 服务 `comfyui`，http://127.0.0.1:8090）——本地代理 + 调度 XDN 远程 ComfyUI
- **远程 XDN** `http://100.119.140.33:8000`（真实生成引擎，Tailscale 网内；XDN 关机时本机服务触发米家开机卡开机）
- 文件：server.py（HTTP+前端）/ config.py（配置，敏感值走环境变量 XDN_PASS/LITELLM_API_KEY）/ xdn_client.py（SSH 监视）/ power.py（米家开机卡）/ template_engine.py（工作流模板）/ templates/（13 个工作流）

## 页面刷新卡死（2026-08-13 已根治，勿重复排查）
- 根因链：米家 adapter（C:\D\opt\miot-mcp\adapter\mijia_adapter.py）同步云 API 无超时 → power.py 用 asyncio.run 包它，同步阻塞占死事件循环 → /queue、/resources 的 xdn_is_offline() 并发各自建连无锁 → 前端 Promise.race 假超时不取消连接 → 浏览器连接池（6 上限）占满 → 刷新没反应
- 修复：power.py 用 `asyncio.to_thread` + `asyncio.wait_for` 15s 真超时 + `_MIJIA_LOCK` 建连互斥 + 失败冷却 10s；server.py `xdn_is_offline()` 加 `_XDN_OFFLINE_LOCK`；前端 `fetchJSON()` 用 AbortController 真取消
- 症状识别：单测接口秒回但刷新死 = 并发轮询堵连接池，不是服务挂了

## LoRA 机制（2026-08-14 改为只读展示）
- **生图/生视频始终用模板内置 lora**（templates/*.json 里写死，如 Z-IMAGE = `Z-image\dejpeg_v3.safetensors` @ 0.38），前端选择框已改为只读信息展示（imgLoraInfo span），不可选
- 想换 lora 只能改模板文件（LoraLoaderModelOnly 节点 widgets_values = [名称, 强度]）
- 模板列表接口 `/templates` 带 `lora` 字段（解析自 LoraLoader/LoraStack 节点）

## 运维
- 重启：`nssm restart comfyui`；日志：`C:\D\opt\comfyui\logs\comfyui-service.out.log` / `.err.log`（GBK 编码，乱码是显示问题）
- 备份：改动前 `Copy-Item *.py *.bak-<时间戳>`
- 环境变量（nssm AppEnvironmentExtra）：`XDN_PASS`（XDN SSH 密码）、`LITELLM_API_KEY`（反推提示词用）
- XDN 状态：`tailscale status` 查节点 cszg（100.119.140.33），offline 表示关机/断网；米家开机卡走 power.py

## 历史坑
- bitsandbytes 管道死锁（Windows 上 `pip list | grep` 卡死 import）：改环境/重启前先确认不是这个
- ❌ **「XDN 空闲 20 分钟自动关机」是假消息**（2026-09-14 老大确认：那只是最初计划，从未真正设置过，XDN 上无此机制）。**勿再按"会被自动关机"来排期或防中断**；实测 XDN 上只有 `ComfyUI Watchdog`（Ready）等计划任务，没有关机任务。XDN 真关机只发生在手动/断电/断网。
