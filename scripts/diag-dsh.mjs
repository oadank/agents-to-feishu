/**
 * 诊断 dsh ACP initialize 超时（"ACP request 100 timeout"）。
 * 启动入口/环境共用 scripts/dsh-acp-spawn.mjs（dshAcpSpawnPlan + dshAcpEnv，
 * 与 dsh.ts resolveDshCommand 同形状：剥 DSH_*、注 DSH_HOME/Windows 系统变量），
 * 本脚本再额外注入 credentials 里的 API key 与 danger-full-access。
 * 手动发 initialize 并计时，打印所收 stdout/stderr。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dshAcpSpawnPlan, dshAcpEnv } from './dsh-acp-spawn.mjs';

const config = 'C:\\Users\\oadan\\.dsh\\dsh-bot\\cordis.yml';

function readKey(k) {
  try {
    const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const txt = fs.readFileSync(cred, 'utf8');
    const m = txt.match(new RegExp(`^\\s*${k}\\s*:\\s*(\\S+)`, 'm'));
    return m ? m[1] : '';
  } catch { return ''; }
}

const plan = dshAcpSpawnPlan({ config });
const env = dshAcpEnv({
  DEEPSEEK_API_KEY: readKey('DEEPSEEK_API_KEY'),
  ARK_API_KEY: readKey('ARK_API_KEY'),
  DSH_PERMISSION_MODE: 'danger-full-access',
});

const child = spawn(plan.command, plan.args, {
  cwd: plan.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
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
