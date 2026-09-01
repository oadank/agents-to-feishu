/**
 * DSH Provider 直测：不连飞书，直接验证 ACP 会话能否 spawn + 对话 + /new 重置。
 * 运行：npx tsx scripts/test-dsh.mts "你的问题"
 */
import { createDshProvider } from '../src/providers/dsh.js';

const question = process.argv[2] || '你好，请用一句话自我介绍';

const provider = createDshProvider();
console.log('=== prepare ===');
await provider.prepare();
console.log('prepare OK');

console.log(`\n=== streamChat(fresh): ${question} ===`);
let text = '';
let usage = null;
for await (const ev of provider.streamChat({
  text: question,
  sessionKey: 'test-session-1',
  freshSession: true,
  systemPrompt: '你是 DSH，通过飞书桥接的 AI 助手。请用中文简洁回答。',
})) {
  if (ev.type === 'text') { text += ev.text; process.stdout.write(ev.text); }
  if (ev.type === 'usage') usage = ev.usage;
  if (ev.type === 'error') console.error('\n[ERROR]', ev.message);
  if (ev.type === 'tool') console.log(`\n[TOOL] ${ev.tool} ${ev.status}`);
}
console.log(`\n\n=== 第一轮结束，文本 ${text.length} 字, usage=${JSON.stringify(usage)} ===`);

console.log('\n=== /new resetSession ===');
await provider.resetSession();
console.log('reset OK');

console.log('\n=== streamChat(again, 验证真正空白会话) ===');
let text2 = '';
for await (const ev of provider.streamChat({
  text: '刚才我说了什么？直接回答"新会话"或"旧会话"',
  sessionKey: 'test-session-2',
  freshSession: true,
})) {
  if (ev.type === 'text') { text2 += ev.text; process.stdout.write(ev.text); }
  if (ev.type === 'error') console.error('\n[ERROR]', ev.message);
}
console.log(`\n=== 第二轮结束（若是"新会话"说明 /new 真正清空了上下文）===`);

await provider.dispose();
console.log('\n✅ DSH provider 直测完成');
