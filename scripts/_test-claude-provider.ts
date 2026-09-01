// 直接测 claude.ts 的 ClaudeProvider.streamChat，验证改完的 provider 能出活（不经过飞书）
import { createClaudeProvider } from '../src/providers/claude.js';

async function main() {
  // 与 claude agent 运行相同的 env
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.henry-gao.com';
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-hg-C0a8FwNc-kex8cPzIsAw7EAJXlFDcEX5WmaZH2WFvNI';
  process.env.ANTHROPIC_MODEL = 'deepseek-v4-flash';
  process.env.CTI_CLAUDE_CLI_PATH = 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  process.env.CTI_DEFAULT_WORKDIR = 'C:\\D\\opt';

  const provider = createClaudeProvider();
  await provider.prepare();
  console.log('[test] provider ready:', provider.name);

  let textOutput = '';
  let events = 0;
  for await (const ev of provider.streamChat({
    text: '回复两个字：成功',
    systemPrompt: '你是测试助手，只回答最简短的。',
    sessionKey: 'test-session-1',
  })) {
    events++;
    if (ev.type === 'text') { textOutput += ev.text; console.log('[text]', ev.text); }
    else if (ev.type === 'usage') console.log('[usage]', JSON.stringify(ev.usage), 'sessionId=', ev.sessionId);
    else if (ev.type === 'error') console.log('[error]', ev.message);
    else if (ev.type === 'done') console.log('[done]');
  }
  console.log(`[test] events=${events}, textOutput=${JSON.stringify(textOutput)}`);
  console.log(textOutput.trim() ? '[test] RESULT: PASS（出字了）' : '[test] RESULT: 空输出');
  await provider.dispose();
  process.exit(0);
}

main().catch((e) => { console.error('[test] FAIL:', e); process.exit(1); });
