// zcode provider 冒烟测试：模拟配置中心 env → streamChat 一轮 → 打印事件
process.env.CTI_BOT = 'zcode';
process.env.CTI_BOT_ZCODE_MODEL = 'Arkglm5.3';
process.env.CTI_BOT_ZCODE_BASE_URL = 'http://localhost:4000';
process.env.CTI_BOT_ZCODE_API_KEY = 'sk-200418';
process.env.CTI_BOT_ZCODE_CONTEXT_WINDOW = '1000000';
process.env.CTI_USER_HOME = process.env.USERPROFILE || 'C:\\Users\\oadan';

import os from 'node:os';
const { createZcodeProvider } = await import('../src/providers/zcode.js');

const provider = createZcodeProvider();
console.log('== prepare');
await provider.prepare();

console.log('== streamChat（第 1 轮，含人设注入）');
const t0 = Date.now();
for await (const ev of provider.streamChat({
  text: '只回复四个字：穿透成功',
  systemPrompt: '你是测试机器人，回复务必简短。',
  sessionKey: 'smoke:p2p:test1',
})) {
  const tag = ev.type === 'usage' ? `usage in=${ev.usage.inputTokens} out=${ev.usage.outputTokens} cache=${ev.usage.cacheReadTokens}`
    : ev.type === 'tool' ? `tool ${ev.tool} ${ev.status}`
    : ev.type === 'text' ? `text(${ev.text.length})` : ev.type;
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s]`, tag, ev.type === 'text' ? ev.text.slice(0, 60) : ev.type === 'error' ? ev.message : '');
}
console.log(`== 第 1 轮结束，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log('== streamChat（第 2 轮，验证会话连续性——应记得上一轮）');
const t1 = Date.now();
for await (const ev of provider.streamChat({
  text: '我上一条消息让你回复的四个字是什么？',
  sessionKey: 'smoke:p2p:test1',
})) {
  const tag = ev.type === 'text' ? `text(${ev.text.length})` : ev.type;
  console.log(`  [${((Date.now() - t1) / 1000).toFixed(1)}s]`, tag, ev.type === 'text' ? ev.text.slice(0, 80) : ev.type === 'error' ? ev.message : ev.type === 'usage' ? `in=${ev.usage.inputTokens} out=${ev.usage.outputTokens}` : '');
}
console.log(`== 第 2 轮结束，耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);

await provider.dispose();
console.log('== SMOKE OK');
process.exit(0);
