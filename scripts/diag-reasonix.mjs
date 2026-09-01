/**
 * 诊断 reasonix-cli.exe acp：手动 initialize + session/new，看真实响应。
 */
import { spawn } from 'node:child_process';

const cmd = 'C:\\Users\\oadan\\AppData\\Local\\Programs\\Reasonix\\reasonix-cli.exe';
const child = spawn(cmd, ['acp'], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
let buf = '';
const started = Date.now();

child.stdout.on('data', (c) => {
  buf += c.toString();
  const lines = buf.split('\n'); buf = lines.pop() || '';
  for (const l of lines) {
    const t = ((Date.now()-started)/1000).toFixed(1);
    console.log(`[+${t}s] ${l.slice(0,400)}`);
  }
});
child.stderr.on('data', (c) => console.log(`[stderr +${((Date.now()-started)/1000).toFixed(1)}s] ${c.toString().slice(0,400)}`));

const send = (o) => child.stdin.write(JSON.stringify(o)+'\n');
send({ jsonrpc:'2.0', id:1, method:'initialize', params:{protocolVersion:1, capabilities:{}, clientInfo:{name:'diag',version:'0.1.0'}} });

setTimeout(() => {
  console.log(`\n[+20s] sending session/new after init`);
  send({ jsonrpc:'2.0', id:2, method:'session/new', params:{ cwd:'C:\\D\\opt', mcpServers:[] } });
}, 20000);

setTimeout(() => {
  console.log(`\n[+30s] killing`); try{child.kill('SIGKILL')}catch{}; process.exit(0);
}, 30000);
