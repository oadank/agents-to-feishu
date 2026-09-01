import { query } from '@anthropic-ai/claude-agent-sdk';
const exe = "C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
const env = {
  ANTHROPIC_BASE_URL: "https://gateway.henry-gao.com",
  ANTHROPIC_AUTH_TOKEN: "sk-hg-C0a8FwNc-kex8cPzIsAw7EAJXlFDcEX5WmaZH2WFvNI",
  ANTHROPIC_API_KEY: "sk-hg-C0a8FwNc-kex8cPzIsAw7EAJXlFDcEX5WmaZH2WFvNI",
  ANTHROPIC_PERMISSION_MODE: "bypassPermissions",
  ANTHROPIC_MODEL: "deepseek-v4-flash",
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "512000",
};
console.log("[test] spawning SDK.query with executable =", exe);
try {
  const q = query({
    prompt: '回复两字：成功',
    options: { cwd: process.cwd(), pathToClaudeCodeExecutable: exe, env },
  });
  let out = '';
  let i = 0;
  for await (const msg of q) {
    i++;
    if (i <= 12) {
      // 打印类型 + 精简内容，摸清新 SDK 事件结构
      let tag = msg && msg.type;
      let info = '';
      try { info = JSON.stringify(msg).slice(0, 400); } catch {}
      console.log(`[msg ${i}] type=${tag}\n    ${info}`);
    }
    if (msg.type === 'stream_event' && msg.event && msg.event.type === 'content_block_delta' && msg.event.delta && msg.event.delta.type === 'text_delta') {
      out += msg.event.delta.text;
    } else if (msg.text) {
      out += msg.text;
    }
    if (msg.type === 'result') break;
  }
  console.log("[test] OUTPUT:", out || '(空)');
  console.log("[test] OK: 无 EINVAL");
  process.exit(0);
} catch (e) {
  console.error("[test] FAIL:", e && e.message);
  process.exit(1);
}
