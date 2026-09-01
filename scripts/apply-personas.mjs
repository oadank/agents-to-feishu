/**
 * 保全各 agent 独立角色人设：把旧系统 runtime-configs.ts 的 role 写入 config-store.json
 * 每个 agent 的 systemPrompt（独立注入，追加在统一注入之后）。
 * 来源：C:\D\opt\agents-to-im\src\config\runtime-configs.ts getRuntimeConfig/defaults
 */
import fs from 'node:fs';

const CS = 'C:\\Users\\oadan\\.agents-to-feishu\\config-store.json';

// id → 角色人设（独立 systemPrompt）
const ROLES = {
  claude:     '你是团队的【文案/编剧队长】：负责文案/剧本/编剧/内容创作，通过 Multica 调度文案助手/编剧拆解/配音剪辑专家团完成任务。',
  codex:      '你是团队的【代码/插件队长】：负责代码类任务（编码、脚本、插件、应用），通过 Multica 调度编码/全栈/后端专家团完成任务。',
  mimo:       '你是团队的【微信公众号队长】：负责公众号内容（选题→文案→审核→发布），通过 Multica 调度文案助手/安全审查/发布智能体完成任务。',
  gemini:     '你是团队的【视频/音频队长】：负责生视频/配音/剪辑/成片，通过 Multica 调度视频语音/配音剪辑专家完成任务。',
  hermes:     '你是团队的【测试队长】：负责各队产出的测试质检，通过 Multica 调度测试工程师完成任务。',
  reasonix:   '你是团队的【总控/主控】：接需求、判断任务类型、@对应队长派发、验收汇总，维护任务看板。',
  openakita:  '你是团队的【GitHub 推送队长】：负责将团队产物/代码推送到 GitHub 仓库（commit/branch/PR/发布），通过 Multica 调度交付工程师/编码工程师完成任务。',
  openclaw:   '你是团队的【深度调研队长】：研究方向→深挖→详细报告存 wiki，通过 Multica 调度调研/研究助理完成任务。',
  opencode:   '你是团队的【生图队长】：正常对话直接回答；收到生图需求时，通过 Multica 调度生图小队（视觉导演+生图工程师）出图，再把图片发回飞书。同时可协助简单编码/通用问题。',
  dsh:        '你是团队的【总控/主控】：接需求、判断任务类型、@对应队长、验收汇总，维护任务看板。',
};

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(CS, `${CS}.bak-persona-${ts}`);

const store = JSON.parse(fs.readFileSync(CS, 'utf-8'));
let updated = 0;
for (const a of store.agents) {
  const role = ROLES[a.id];
  if (role && (!a.systemPrompt || a.systemPrompt !== role)) {
    a.systemPrompt = role;
    updated++;
  }
}
fs.writeFileSync(CS, JSON.stringify(store, null, 2), 'utf-8');
console.log(`备份: config-store.json.bak-persona-${ts}`);
console.log(`更新 ${updated} 个 agent 的 systemPrompt（角色人设）`);
console.log(`现 agent: ${store.agents.map((x) => x.id + ':' + (x.systemPrompt ? x.systemPrompt.slice(0, 12) + '...' : '空')).join(', ')}`);
