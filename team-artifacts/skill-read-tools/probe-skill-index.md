# cti-builtin skill 读取件验收（2026-09-19 · 判分 v2）

## 实现
- 新建 `src/tools/skills.ts`：`skill_index` / `skill_read`
- `mcp-stdio.ts` EXPOSE 增加两工具（stdio MCP：openakita/dsh 等）
- `claude-tools.ts` 进程内 server 并入 `buildSkillTools()`（claude 同步暴露）
- **未碰** render.ts / look.ts / registry 生图看图实现

## 行为
| 工具 | 行为 |
|---|---|
| skill_index | 返回 JSON：{ok,count,roots,skills:[{name,description,dir_path}]} |
| skill_read(name) | SKILL.md 全文；精确/大小写/唯一子串模糊；多命中或查无→报错+候选列表，**禁止编造** |

扫描根：项目 `skills/` + env `CTI_SKILLS_DIRS`（workbuddy 铺目录可挂）

## 三家 skill_index 真调痕迹（有痕=✅）
| agent | 探针 mid | 工具痕迹 | 结果 |
|---|---|---|---|
| claude | om_x100b65eba2eb0ca0c2f364403a93ffb | ✅ mcp__cti-builtin__skill_index — {} | name 列表 `feishu-bridge`（count=1） |
| openakita | om_x100b65eba26554a8c21f4a165528eb7 | ✅ call_mcp_tool(server=cti-builtin, tool_name=skill_index) | 明文回报 name 列表 feishu-bridge，root=项目 skills/ |
| dsh | om_x100b65eba39fc0a0c3337e034e7e326 | ✅ mcp__cti-builtin__skill_index — {} | count=1，name=`feishu-bridge` |

## 单元验证
- listSkills 含 feishu-bridge，shape={name,description,dir_path}
- skill_read 返回全文；查无 `no-such-skill-xyz` → 「查无技能…禁止编造」
- 模糊 `feishu` 唯一命中

## apply 范围
仅 claude / openakita / dsh 单发重启验活（SERVICE_RUNNING）；未全表复测
