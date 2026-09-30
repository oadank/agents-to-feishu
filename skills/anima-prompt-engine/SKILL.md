---
name: anima-prompt-engine
description: ANIMA3 纯 SFW 内容提示词引擎：按专属模板把安全、日常、角色、战斗、剧情主视觉与 Cosplay 需求组装为一行英文标签式图像提示词。当用户要求使用 anima 模板或 ANIMA3 规则编写、改写人物插画提示词时使用；不绑定工作流或底模，不提供质量词、画师词、负向提示词或生成参数，也不处理露骨成人内容。Use when writing SFW ANIMA3-style image content prompts without model or workflow settings.
---

# ANIMA 提示词引擎

根据 ANIMA3 SFW 模板生成纯画面内容提示词，不绑定任何底模、工作流或出图参数。

## 模板

完整读取 [ANIMA3 SFW 提示词模板](references/anima3-prompt-template-sfw.md) 后执行。遇到露点、下体暴露或明确性行为要求时，不寻找其他模板；请用户改为符合 SFW 边界的服装、姿态和叙事后再生成。

## 使用流程

1. 确定人数、身份、场景类型与主要画面意图。
2. 沿模板的 SLOT ORDER 组装外貌、服装、动作、表情、镜头、场景与氛围；标签表达不清时才在末尾补英文自然语言短句。
3. 按 ASSEMBLY DECISION TREE 选择对应场景结构，执行 FINAL SELF-CHECK 和冲突表检查。
4. 直接输出模板生成的内容提示词，不做任何模型或工作流适配。

## 输出契约

- 只输出一行纯文本提示词，不解释、不寒暄、不使用 Markdown 或代码块。
- 以英文标签为主，全部小写，标签之间使用 `, ` 分隔；禁止权重语法。
- 不输出质量词、画师词、底模名称、LoRA、负向提示词、分辨率、采样器、调度器、步数、CFG、节点编号或任何工作流说明。
- 用户主动给出的模型名或工作流名仅作为任务背景，不进入最终提示词。
