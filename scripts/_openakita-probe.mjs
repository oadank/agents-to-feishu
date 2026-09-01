import { spawn } from 'node:child_process';
const py = 'C:\\D\\opt\\openakita\\venv\\Scripts\\python.exe';
const server = 'C:\\D\\opt\\agents-to-feishu\\scripts\\openakita-acp-server.py';
const child = spawn(py, [server], { cwd: 'C:\\Users\\oadan\\.openakita\\workspaces\\default', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '';
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
child.stderr.on('data', (c) => { const s = c.toString(); if (process.env.OK_DEBUG) console.log('[ERR]', s.slice(0, 200)); });
child.stdout.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:\\D\\opt', mcpServers: [] } });
    else if (m.id === 2) {
      console.log('sessionId:', m.result?.sessionId);
      send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: m.result.sessionId, prompt: [{ type: 'text', text: '只回复两个字：收到' }] } });
    } else if (m.id === 3) {
      console.log('RESULT:', JSON.stringify(m.result?._meta));
      console.log('stopReason:', m.result?.stopReason, 'isError:', m.result?.isError);
      process.exit(0);
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 150000);
