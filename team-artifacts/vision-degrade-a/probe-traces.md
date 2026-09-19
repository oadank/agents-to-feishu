# 视觉探针实调痕迹（2026-09-19 09:31-09:32）

判分口径：有痕=✅（实调痕迹）；OCR 复述 CTI-PROBE-2026 为辅助证据。

## mimo（visionCapable=true，已注入降级令）
- 探针回复 mid: om_x100b65ea1106986cc152d3557fff149 @2026-09-19 09:31
- 工具痕迹（飞书工具卡）:
  - visionqa_look {}
  - cti-builtin_look_image {}
  - visionqa_look {"image_path":"...probe-ocr.png","task":"text"}
  - cti-builtin_look_image {"image_path":"...probe-ocr.png","task":"text"}
  - ✅ tool ×2 同上参数
- 正文复述：**图中文字（复述）：** CTI-PROBE-2026
- 脚本判定：❌ 复述不符（判定器误杀——正文含反引号 CTI-PROBE-2026，与 CAPABILITY-MATRIX v2 误杀同型）
- 人工判定：✅ 有痕 + 复述正确
- 行为符合降级令：OCR=逐字提取，look_image/visionqa 作为兜底被真调；未因降级令禁用工具

## claude（visionCapable=false，未注入降级令）
- 探针回复 mid: om_x100b65ea2c7f5ca0de2f4572e885ac6 @2026-09-19 09:32
- 工具痕迹（飞书工具卡）:
  - ✅ Bash（拷贝到 screenshot 目录，ocr_image 路径限制）
  - ✅ mcp__win-desktop-helper__ocr_image {"path":"...probe-ocr-claude.png"}
  - ✅ mcp__visionqa__look {"image_path":"...probe-ocr.png","task":"text"}
- 思考层：「两路一致得到 CTI-PROBE-2026」
- 脚本判定：✅ native·复述正确
- 人工判定：✅ 有痕 + 复述正确
- 行为符合 false 口径：不注入降级令，现有 look_image/visionqa 工具行为不变，模型仍可实调

## 注入产物 diff 摘要
- mimo CTI_SYSTEM_PROMPT_GLOBAL LEN=10510 HAS_DEGRADE=True
- claude CTI_SYSTEM_PROMPT_GLOBAL LEN=10443 HAS_DEGRADE=False
- 关键差异后缀 = 降级令原文（见 injection-diff.md）

## 验收红线遵守
- 未碰 litellm / D5 / key / engine 看图实现（look.ts / registry.ts / engine.ts 零改动）
- 仅 apply + 重启 mimo、claude 两家；config-center 因代码热更重启一次
- 无新证据不跑全表复测
