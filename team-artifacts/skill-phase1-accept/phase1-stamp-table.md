# skill Phase1 活体验收戳表（2026-09-19 · 判分铁规：飞书实物回复）

**证据铁规（老大 09-19 新令）**：验收唯一硬证 = 该 bot 在飞书里真实发出的回复消息本身。本表每行 mid 均经 `lark-cli im +chat-messages-list` 实时拉取；摘录为该 mid 原文。日志/工具卡仅旁证；无飞书实物回复一律 ❌；"应有回复"式推理一律 ❌。

**skill_index 清单（验收时磁盘真相，序从 1）**  
1. all-platform-video-extract  
2. comfyui-ops  
3. feishu-bridge  
4. lark-ops  
5. memory-ops  
6. openmem-rules  
7. vision-verify  

**探针句式**：单发 `用 skill_index 查清单并背出你家第 N 个技能名`；单发等 FINAL（坑36；openakita 看门狗已放宽 900s）。

**前置**：WB 桥侧 Phase1 已落库（git: c677a87 / 965a1ed / 3441b63 / 2fb6321 / 429d29b）；读取件 commit `9d85988`；12 家 apply 后 nssm=SERVICE_RUNNING 后才发探针。  
**关联 commit**：roll 销案 `36b4759`；读取件 `9d85988`。

---

## 戳表（12 行）

### 1. claude — N=1 期望 `all-platform-video-extract` — ✅ PASS
- 飞书 mid：`om_x100b65d4d5f918a4c16b8cd09a5cfc6` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `🔧 工具执行✅ mcp__cti-builtin__skill_index — {} … 第 1 个技能 name：all-platform-video-extract。清单已从 1 条变 7 条。`
- 旁证：工具卡 skill_index ✅

### 2. codex — N=3 期望 `feishu-bridge` — ✅ PASS
- 飞书 mid：`om_x100b65d4d56af0acc4ed85c9593f3a1` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `体检·技能清单：真调 skill_index 拿清单。第 3 个技能名（原文）：feishu-bridge … 工具 skill_index（真调，ok:true）`
- 旁证：工具卡 mcpToolCall ✅

### 3. mimo — N=5 期望 `memory-ops` — ✅ PASS
- 飞书 mid：`om_x100b65d4d2cc70a4ddce793a94abc48` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `🔧 工具执行cti-builtin_skill_index — {} …（正文含 memory-ops 作为第 5 个技能名）`
- 旁证：工具卡 cti-builtin_skill_index ✅

### 4. gemini — N=2 期望 `comfyui-ops` — ✅ PASS
- 飞书 mid：`om_x100b65d4d2a430acc4a4a3c4ca4c12f` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `✅ skill_index (cti-builtin MCP Server) … 第 2 个 … comfyui-ops`
- 旁证：工具卡 skill_index ✅

### 5. hermes — N=4 期望 `lark-ops` — ✅ PASS
- 飞书 mid：`om_x100b65d4d20964a0c4b97f2d57cc6e1` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `mcp__cti_builtin__skill_index ✅ … skill_index call succeeded. There are 7 skills …（第 4 个 lark-ops）`
- 旁证：工具卡 ✅

### 6. openakita — N=6 期望 `openmem-rules` — ✅ PASS
- 飞书 mid：`om_x100b65d4d3e5e4a8c399e40d0b54952` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `清单共 7 个技能，第 6 个技能的 name（原文）：openmem-rules  
  [来源:工具] 经 call_mcp_tool(server="cti-builtin", tool_name="skill_index") 真调返回（ok=true, count=7）`
- 旁证：工具卡 call_mcp_tool ✅  
- 备注：首帧卡片截断曾误判；FINAL 同 mid 全文含技能名，按铁规 PASS

### 7. reasonix — N=1 期望 `all-platform-video-extract` — ✅ PASS
- 飞书 mid：`om_x100b65d4d34580acc1927e67ca935f6` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `use_capability … capability_id=mcp-tool:cti-builtin/skill_index ✅ …（正文含 all-platform-video-extract）`
- 旁证：工具卡 use_capability ✅

### 8. openclaw — N=3 期望 `feishu-bridge` — ✅ PASS
- 飞书 mid：`om_x100b65d4d32e3ca4dfaf4288cf688c0` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `体检·skill_index 完成 —— 调用成功（真实调用 cti-builtin__skill_index，共 7 个技能）。清单里第 3 个技能名字原文：feishu-bridge  
  （顺序：1. all-platform-video-extract → 2. comfyui-o…）`
- 旁证：工具卡 ✅

### 9. opencode — N=5 期望 `memory-ops` — ✅ PASS
- 飞书 mid：`om_x100b65d4d0f6e8a0ddc8858539018e9` @ 2026-09-19 12:04
- 飞书摘录原文：  
  `cti-builtin_skill_index … 真调 skill_index … 第 5 个技能的 name … memory-ops`
- 旁证：工具卡 ✅

### 10. dsh — N=2 期望 `comfyui-ops` — ✅ PASS
- 飞书 mid：`om_x100b65d4d06c14a0c3452856dfbd31e` @ 2026-09-19 12:04
- 飞书摘录原文（同 mid 全文实拉）：  
  `🔧 执行中✅ mcp__cti-builtin__skill_index — {} …  
  思考层：…第 2 个（按返回顺序，字母序）= comfyui-ops…`
- 旁证：skill_index / skill_read 工具卡 ✅  
- 备注：短截断曾把旁路技能名误当答案；全文含第 2 个=comfyui-ops，按铁规 PASS

### 11. deeptutor — N=4 期望 `lark-ops` — ❌ FAIL
- 飞书 mid：`om_x100b65d4d1cc4538deb91015cf036a4` @ 2026-09-19 12:05
- 飞书摘录原文：  
  `没有 skill_index。  
  我这轮的工具清单就那十一个：workspace_list、workspace_read、workspace_search、workspace_present、workspace_export、consult_subsubagent、rag、kb_files、knowledge_frontier、ask_user、tts_speak。没有 cti-builtin，没有 call_mcp_tool，也没有任何 MCP 调用入口。既然清单里没有，第 4 个技能的名字我背不出来——编一个就是害你验收。`
- 失败现场：飞书实物回复存在且拒编造；**该会话工具表无 skill_index/cti-builtin**，无法完成"背出第 N 个技能名"。不是"没回复"，是回复自证工具未注册。  
- 处置：如实 ❌；不推理、不代答。

### 12. zcode — N=7 期望 `vision-verify` — ✅ PASS
- 飞书 mid：`om_x100b65d4d1bc6cacdf99bf40d622f19` @ 2026-09-19 12:05
- 飞书摘录原文：  
  `mcp__cti-builtin__skill_index … 第 7 个 … vision-verify`
- 旁证：工具卡 ✅

---

## 汇总
- **PASS = 11 / 12**；**FAIL = 1**（deeptutor：飞书实物回复明确「没有 skill_index」）
- 禁止"应该没问题"：deeptutor 记 ❌，失败现场已摘录原文
- 红线：未碰 litellm/D5/key；未碰 render.ts（WB 施工区）
- 产物：本文件 + `phase1-stamp-table.json`
