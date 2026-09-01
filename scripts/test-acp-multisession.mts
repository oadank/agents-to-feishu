/**
 * 验证 DSH ACP 是否支持「单进程多 session」：
 * 1. 同一个 ACP 进程里 session/new 两次，能否拿到两个不同 sessionId
 * 2. 两个 session 的上下文是否互相隔离
 * 3. 进程是否保持存活（不杀进程）
 *
 * 这决定 /new 是"复用进程开新会话"还是"必须杀进程重开"。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const harness = 'C:\\D\\opt\\deepseek-harness\\deepseek-harness';
const config = 'C:\\Users\\oadan\\.dsh\\dsh-bot\\cordis.yml';
const command = process.execPath;
const args = ['--import', 'tsx/esm', 'packages/examples/acp-demo/src/bin.ts', '--config', config];

// 剥离 DSH_* 环境变量（防宿主会话锁冲突）
const clean: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('DSH_')) continue;
  clean[k] = v;
}
clean.DEEPSEEK_API_KEY = fs.existsSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'))
  ? (fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/)?.[1] ?? '')
  : '';
clean.DSH_PERMISSION_MODE = 'danger-full-access';

const child = spawn(command, args, { cwd: harness, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: clean });

let lineBuf = '';
let nextId = 100;
const pending = new Map<number, (msg: any) => void>();

function send(msg: unknown): void {
  child.stdin!.write(JSON.stringify(msg) + '\n');
}

function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, (msg) => { pending.delete(id); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

child.stdout!.on('data', (chunk: Buffer) => {
  lineBuf += chunk.toString();
  const lines = lineBuf.split('\n');
  lineBuf = lines.pop() || '';
  for (const raw of lines) {
    const t = raw.trim();
    if (!t.startsWith('{')) continue;
    try {
      const msg = JSON.parse(t);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
      }
      if (msg.method === 'session/request_permission') {
        const allow = msg.params?.options?.find((o: any) => /allow/i.test(o.optionId))?.optionId || 'allow-once';
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow } } });
      }
    } catch {}
  }
});

child.stderr.on('data', (c: Buffer) => console.log('[stderr]', c.toString().trim().slice(0, 200)));

// 流程
console.log('=== 1. initialize ===');
const init = await request('initialize', { protocolVersion: 1, capabilities: {}, clientInfo: { name: 'multi-session-test', version: '1.0' } });
console.log('init result keys:', Object.keys(init.result || {}));

console.log('\n=== 2. session/new #1 (cwd=C:\\D\\opt) ===');
const s1 = await request('session/new', { cwd: 'C:\\D\\opt', mcpServers: [] });
const sid1 = s1.result?.sessionId;
console.log('sessionId #1:', sid1);

console.log('\n=== 3. session/new #2 (cwd=C:\\D\\opt\\agents-to-feishu) ===');
const s2 = await request('session/new', { cwd: 'C:\\D\\opt\\agents-to-feishu', mcpServers: [] });
const sid2 = s2.result?.sessionId;
console.log('sessionId #2:', sid2);
console.log('两个 sessionId 不同?', sid1 !== sid2, '| 进程仍存活?', child.exitCode === null);

console.log('\n=== 4. 在 session#1 发消息 ===');
const p1 = await request('session/prompt', { sessionId: sid1, prompt: [{ type: 'text', text: '你好，用一句话回答：1+1等于几' }] });
console.log('prompt#1 result is_error:', p1.result?.is_error);

// 等一下让流式输出完成
await new Promise((r) => setTimeout(r, 3000));

console.log('\n=== 5. 在 session#2 发消息（验证隔离） ===');
const p2 = await request('session/prompt', { sessionId: sid2, prompt: [{ type: 'text', text: '这是我这个会话的第一句话。请问：我们刚才在另一个会话聊了什么？直接答"不知道"或描述' }] });
console.log('prompt#2 result is_error:', p2.result?.is_error);

await new Promise((r) => setTimeout(r, 5000));

console.log('\n=== 6. 进程状态 ===');
console.log('进程还活着?', child.exitCode === null, 'pid=', child.pid);

child.kill('SIGTERM');
console.log('\n✅ 测试完成');
