# openmem 用法要点（单页 · 2026-09-20）

统一记忆中枢 :3467，`mh_*` 工具族。**所有 bot 通用**，拿不准先问它别猜。

## 查询顺序（先成品后原始）
1. `mh_tools_list` → 看有哪些成品答案；`mh_tool(name=…)` 秒回（偏好/端口/花名册/飞书规范/GitHub 通道这类标准问题必走这里）。
2. `mh_search(query, top_k≤10)` 原始条目（历史细节、某个坑的经过）。可带 layer/category/source/tags/时间过滤。
3. `mh_ask` 最后手段（LLM 综合，慢，要理解+综成才用）。

## 写入四步（mh_write 前）
1. **先搜**：同主题已有条目 → `mh_update(id)` 原地改，**禁另起新条堆重复**（老大 09-19 令）。
2. **领票**：`mh_skill(agent=自己名)` 放行一条（一票一条，写完作废再来领）。
3. **写**：`mh_write(content, source=自己名)`；layer k=知识/m=记忆；category 用规矩内枚举或项目名；重要结论 `pinned:true`。
4. **不写回=任务没完成**；坑要写根因+修法+验证方式。

## 铁律（违者事故）
- **测试垃圾禁入库**（12d6523e 钉住）：埋点口令、暗号、含口令的验收台账一律不写；留证走 `C:\D\opt\team-artifacts\`。发现即删：`DELETE http://127.0.0.1:3467/api/entry?id=<uuid>`。
- 密钥/凭据值不写明文进库，只答"存放位置"；碰外部 API 前先搜访问方法（GitHub/限流类）。
- chat_id 属 bot 自我标识，只留自家 persona 文件，不进 openmem。
- 清单类内容别把 count/序号当常量断言（会漂移），按 name 定点。
