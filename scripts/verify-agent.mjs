/**
 * 验证迁移后的 agent（opencode）在 config.<id>.env 配置下能真实对话。
 * 证明：model 贯通可行 + 迁移后的 agent 真正可用。
 */
import fs from 'node:fs';
// 加载 config.opencode.env 到 process.env（模拟服务读取）
const envText = fs.readFileSync('C:\\Users\\oadan\\.agents-to-feishu\\config.opencode.env', 'utf-8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
}

const { createOpencodeProvider } = await import('../src/providers/opencode.js');
const p = createOpencodeProvider();
console.log('== prepare =='); await p.prepare();
console.log('== streamChat (迁移配置下) ==');
const gen = p.streamChat({
  text: '只回复四个字：你好',
  systemPrompt: process.env.CTI_BOT_OPENCODE_SYSTEM_PROMPT || '',
  sessionKey: 'migrate-verify',
  freshSession: true,
});
for await (const ev of gen) {
  if (ev.type === 'text') console.log('[TEXT]', ev.text);
  else if (ev.type === 'thinking') console.log('[THINK]', ev.text.slice(0, 60));
  else if (ev.type === 'error') console.log('[ERROR]', ev.message);
  else if (ev.type === 'done') console.log('[DONE]');
}
await p.dispose();
console.log('== done ==');
