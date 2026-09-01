/**
 * 诊断 dsh ACP initialize 超时（"ACP request 100 timeout"）。
 * 复用 dsh.ts 的 spawn 参数 + 环境，手动发 initialize 并计时，打印所收 stdout/stderr。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const harness = 'C:\\D\\opt\\deepseek-harness\\deepseek-harness';
const config = 'C:\\Users\\oadan\\.dsh\\dsh-bot\\cordis.yml';

function readKey(k) {
  try {
    const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const txt = fs.readFileSync(cred, 'utf8');
    const m = txt.match(new RegExp(`^\\s*${k}\\s*:\\s*(\\S+)`, 'm'));
    return m ? m[1] : '';
  } catch { return ''; }
}

// 复刻 dsh.ts buildSpawnEnv：剥离 DSH_* + 注 DEEPSEEK_API_KEY
const clean = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('DSH_')) continue;
  clean[k] = v;
}
const env = {
  ...clean,
  DEEPSEEK_API_KEY: readKey('DEEPSEEK_API_KEY'),
  ARK_API_KEY: readKey('ARK_API_KEY'),
  DSH_PERMISSION_MODE: 'danger-full-access',
  DSH_HOME: path.join(os.homedir(), '.dsh'),
  ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe',
  SystemRoot: 'C:\\WINDOWS',
};

const child = spawn(process.execPath, ['--import', 'tsx/esm', 'packages/examples/acp-demo/src/bin.ts', '--config', config], {
  cwd: harness, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
});
console.log('spawned pid', child.pid);

let started = Date.now();
child.stdout.on('data', (c) => {
  const t = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[stdout +${t}s] ${c.toString().trim().slice(0, 300)}`);
});
child.stderr.on('data', (c) => {
  const t = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[stderr +${t}s] ${c.toString().trim().slice(0, 500)}`);
});

// 发 initialize
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
send({ jsonrpc: '2.0', id: 100, method: 'initialize', params: { protocolVersion: 1, capabilities: {}, clientInfo: { name: 'diag', version: '0.1.0' } } });

// 65s 内等 initialize 响应
const deadline = started + 65_000;
const poll = setInterval(() => {
  if (Date.now() > deadline) {
    console.log(`\n[TIMEOUT] no initialize response within 65s -> reproduces "ACP request 100 timeout"`);
    clearInterval(poll);
    try { child.kill('SIGKILL'); } catch {}
    process.exit(1);
  }
}, 500);

// 如果进程提前退出
child.on('close', (code, sig) => {
  console.log(`[close] code=${code} sig=${sig}`);
  clearInterval(poll);
  process.exit(0);
});
