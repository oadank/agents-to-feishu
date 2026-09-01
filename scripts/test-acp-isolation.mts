/**
 * 验证 DSH ACP 多会话上下文隔离（改进版：捕获 session/update 文本输出）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const harness = 'C:\\D\\opt\\deepseek-harness\\deepseek-harness';
const config = 'C:\\Users\\oadan\\.dsh\\dsh-bot\\cordis.yml';
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'packages/examples/acp-demo/src/bin.ts', '--config', config], {
  cwd: harness, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: (() => {
    const clean: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) { if (k.startsWith('DSH_')) continue; clean[k] = v; }
    clean.DSH_PERMISSION_MODE = 'danger-full-access';
    try {
      const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml');
      clean.DEEPSEEK_API_KEY = fs.readFileSync(cred, 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/)?.[1] ?? '';
    } catch {}
    return clean;
  })(),
});

let lineBuf = '';
let nextId = 100;
const pending = new Map<number, (m: any) => void>();
const streams = new Map<string, { text: string; done: boolean }>();

function send(m: unknown) { child.stdin!.write(JSON.stringify(m) + '\n'); }
function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((r) => { pending.set(id, r); send({ jsonrpc: '2.0', id, method, params }); });
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
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)!(msg); }
      if (msg.method === 'session/update' && msg.params?.update?.sessionUpdate === 'agent_message_chunk') {
        const sid = msg.params.update.sessionId ?? msg.params?.sessionId ?? '';
        const txt = msg.params.update.content?.text ?? '';
        if (!streams.has(sid)) streams.set(sid, { text: '', done: false });
        streams.get(sid)!.text += txt;
      }
      if (msg.method === 'session/request_permission') {
        const allow = msg.params?.options?.find((o: any) => /allow/i.test(o.optionId))?.optionId || 'allow-once';
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow } } });
      }
    } catch {}
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('=== initialize ===');
await request('initialize', { protocolVersion: 1, capabilities: {}, clientInfo: { name: 'iso-test', version: '1.0' } });

console.log('=== session#1: 发"记住密码 X7QZ" ===');
const s1 = await request('session/new', { cwd: 'C:\\D\\opt', mcpServers: [] });
const sid1 = s1.result?.sessionId;
const p1 = await request('session/prompt', { sessionId: sid1, prompt: [{ type: 'text', text: '请记住一个暗号：西瓜X7QZ。只回复"记住了"三个字' }] });
await sleep(6000);

console.log('=== session#2: 问"刚才的暗号是什么？如果不知道就回答 UNKNOWN" ===');
const s2 = await request('session/new', { cwd: 'C:\\D\\opt', mcpServers: [] });
const sid2 = s2.result?.sessionId;
const p2 = await request('session/prompt', { sessionId: sid2, prompt: [{ type: 'text', text: '我们之前聊过吗？之前提到过什么暗号？如果没有任何上下文，只回答 UNKNOWN' }] });
await sleep(8000);

console.log('\n--- session#1 输出 ---');
console.log(streams.get(sid1)?.text ?? '(无)');
console.log('\n--- session#2 输出 ---');
console.log(streams.get(sid2)?.text ?? '(无)');

const s2text = streams.get(sid2)?.text ?? '';
console.log('\n=== 结论 ===');
console.log('session#2 是否记得 session#1 的暗号:', s2text.includes('X7QZ') ? '是（未隔离！）' : '否（隔离正常）');

child.kill('SIGTERM');
