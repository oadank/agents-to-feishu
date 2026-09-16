/**
 * 诊断：DSH ACP 一次 prompt 到底推哪些 session/update 事件
 *
 * 启动入口/环境共用 scripts/dsh-acp-spawn.mjs（dshAcpSpawnPlan + dshAcpEnv：
 * 剥 DSH_*、注 DSH_HOME/Windows 系统变量）；本脚本只再注入 API key 与权限模式。
 * 运行：npx tsx scripts/diag-dsh-events.mts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dshAcpSpawnPlan, dshAcpEnv } from './dsh-acp-spawn.mjs';

const config = 'C:\\Users\\oadan\\.dsh\\dsh-bot\\cordis.yml';
const plan = dshAcpSpawnPlan({ config });
const child = spawn(plan.command, plan.args, {
  cwd: plan.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: dshAcpEnv({
    DSH_PERMISSION_MODE: 'danger-full-access',
    DEEPSEEK_API_KEY: (() => {
      try { return fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/)?.[1] ?? ''; } catch { return ''; }
    })(),
  }),
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
