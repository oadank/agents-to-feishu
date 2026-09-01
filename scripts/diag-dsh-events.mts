/**
 * 诊断：DSH ACP 一次 prompt 到底推哪些 session/update 事件
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
    try { clean.DEEPSEEK_API_KEY = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/)?.[1] ?? ''; } catch {}
    return clean;
  })(),
});

let lineBuf = '';
let nextId = 100;
const pending = new Map<number, (m: any) => void>();
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
      // 打印所有 method 类型
      if (msg.method) {
        console.log(`[EVENT] method=${msg.method}`, msg.method === 'session/update' ? `sessionUpdate=${msg.params?.update?.sessionUpdate} type=${msg.params?.update?.content?.type}` : '');
        if (msg.method === 'session/update') {
          const u = msg.params?.update;
          if (u?.sessionUpdate === 'agent_message_chunk') {
            console.log(`   text=${JSON.stringify(u.content?.text?.slice(0, 80))}`);
          }
          if (u?.sessionUpdate === 'agent_thought_chunk') {
            console.log(`   thought=${JSON.stringify(u.content?.text?.slice(0, 80))}`);
          }
          if (u?._meta?.usage) console.log(`   usage=${JSON.stringify(u._meta.usage)}`);
        }
      }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)!(msg); }
      if (msg.method === 'session/request_permission') {
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
      }
    } catch {}
  }
});

console.log('=== initialize ===');
await request('initialize', { protocolVersion: 1, capabilities: {}, clientInfo: { name: 'diag', version: '1.0' } });
console.log('=== session/new ===');
const s = await request('session/new', { cwd: 'C:\\D\\opt', mcpServers: [] });
const sid = s.result?.sessionId;
console.log('sessionId:', sid);

console.log('\n=== prompt: "1+1=?" ===');
const p = await request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '1+1=?' }] });
console.log('prompt done, is_error:', p.result?.is_error);

await new Promise((r) => setTimeout(r, 3000));
child.kill('SIGTERM');
console.log('\n✅ 诊断完成');
