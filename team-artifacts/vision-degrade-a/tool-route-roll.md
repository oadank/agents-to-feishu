# 工具路权令同车交付 + 12 家滚动 apply（2026-09-19）

## 注入文案（与 visionCapable 共用 buildAgentGlobalInject）
生图/看图/反推一律优先内建底座（generate_image/look_image/reverse_prompt）；comfy/vision MCP 旧通道仅作备胎禁止首选（旧通道有临时文件被清导致自动发图落空的前科，禁止把首选让给它）。

## 合成顺序
store 统一注入 → 视觉降级令（model.visionCapable=true/缺省）→ 工具路权令（全员无条件）

## 配置红线
config-store MCP 池 comfy/vision **未摘**（仍勾选/仍在数组），仅 prompt 层降权。

## 12 家 apply（单发间隔 ~8s + 每家验活）
| agent | nssm | toolRoute | visionDegrade | len | 结果 |
|---|---|---|---|---|---|
| claude | SERVICE_RUNNING | True | false（claude-model 手切） | 10565 | PASS |
| codex | SERVICE_RUNNING | True | true | 10632 | PASS |
| mimo | SERVICE_RUNNING | True | true | 10632 | PASS |
| gemini | SERVICE_RUNNING | True | true | 10632 | PASS |
| hermes | SERVICE_RUNNING | True | true | 10632 | PASS |
| openakita | SERVICE_RUNNING | True | true | 10632 | PASS |
| reasonix | SERVICE_RUNNING | True | true | 10632 | PASS |
| openclaw | SERVICE_RUNNING | True | true | 10632 | PASS |
| opencode | SERVICE_RUNNING | True | true | 10632 | PASS |
| dsh | SERVICE_RUNNING | True | true | 10632 | PASS |
| deeptutor | SERVICE_RUNNING | True | true | 10632 | PASS |
| zcode | SERVICE_RUNNING | True | true | 10632 | PASS |

- PASS=12/12
- dsh persona.md 同步含 toolRoute + visionDegrade
- 未做全表能力复测（红线：无新证据禁全表）

## 代码
render.ts：`TOOL_ROUTE_PROMPT` / `withToolRouteInject` / `buildAgentGlobalInject`（config.env + persona.md 共用）
