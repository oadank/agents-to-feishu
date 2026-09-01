// 验证新版 SDK 0.3.250 的常驻会话：query({prompt:AsyncIterable}) 多轮 + 工具/思考事件
import { query } from '@anthropic-ai/claude-agent-sdk';

// 可 push 的 async iterable：作为 query 的常驻 prompt 流
class PushQueue {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(item) {
    if (this.waiters.length) { this.waiters.shift()({ item }); }
    else this.items.push(item);
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.done) return Promise.resolve({ done: true });
        return new Promise((res) => this.waiters.push(({ item }) => res({ value: item, done: false })));
      },
      return: () => { this.done = true; return Promise.resolve({ done: true }); },
    };
  }
}

const env = {
  ANTHROPIC_BASE_URL: "https://gateway.henry-gao.com",
  ANTHROPIC_AUTH_TOKEN: "sk-hg-C0a8FwNc-kex8cPzIsAw7EAJXlFDcEX5WmaZH2WFvNI",
  ANTHROPIC_API_KEY: "sk-hg-C0a8FwNc-kex8cPzIsAw7EAJXlFDcEX5WmaZH2WFvNI",
  ANTHROPIC_PERMISSION_MODE: "bypassPermissions",
  ANTHROPIC_MODEL: "deepseek-v4-flash",
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "512000",
};

const exe = "C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
const queue = new PushQueue();
const q = query({
  prompt: queue, // AsyncIterable -> 常驻多轮
  options: {
    cwd: process.cwd(),
    pathToClaudeCodeExecutable: exe,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env,
    allowedTools: ['Bash'], // 放行 Bash 测试工具事件
  },
});

let round = 0;
(async () => {
  queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '回复两字：成功' }] }, parent_tool_use_id: null, shouldQuery: true });
  round++;
  // 第二轮：触发工具（让 claude 调 Bash 计算 1+1）
  setTimeout(() => {
    if (round < 3) {
      round++;
      queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '用 Bash 工具计算 1+1 等于几，只回数字' }] }, parent_tool_use_id: null, shouldQuery: true });
    }
  }, 25000);

  for await (const msg of q) {
    const tag = msg && msg.type;
    if (tag === 'assistant') {
      const content = (msg as any).message?.content || [];
      for (const b of content) {
        if (b?.type === 'text') console.log('[assistant][text]', JSON.stringify(b.text));
        else if (b?.type === 'thinking') console.log('[assistant][thinking]', JSON.stringify((b.thinking||'').slice(0,80)));
        else if (b?.type === 'tool_use') console.log('[assistant][tool_use]', b.name, JSON.stringify(b.input).slice(0,80));
        else console.log('[assistant][block]', b?.type);
      }
    } else if (tag === 'result') {
      console.log('[result]', 'subtype=' + (msg as any).subtype, 'stop=' + (msg as any).stop_reason);
    } else if (tag === 'system') {
      // 忽略系统消息
    } else {
      console.log('[msg]', tag);
    }
  }
  console.log('[test] query 流结束');
  process.exit(0);
})().catch((e) => { console.error('[test] FAIL', e); process.exit(1); });
