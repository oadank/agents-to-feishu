#!/usr/bin/env node
/**
 * ACP 探针：直接驱动任意 ACP agent（绕过桥接），验证模型可见工具与调用行为。
 * initialize → session/new → session/prompt → 打印全部往返。
 *
 * 默认驱动 dsh harness；可用环境变量换目标：
 *   CTI_PROBE_CMD=完整命令  CTI_PROBE_ARGS="空格分隔参数"  CTI_PROBE_CWD=工作目录
 * 例（reasonix）：CTI_PROBE_CMD="C:\...\reasonix-cli.exe" CTI_PROBE_ARGS="acp"
 */
import { spawn } from 'node:child_process';

const CONFIG = process.argv[2] || 'C:/Users/oadan/.dsh/dsh-bot/cordis.yml';
const HARNESS = process.env.CTI_PROBE_CWD || 'C:/D/opt/deepseek-harness/deepseek-harness';
const PROMPT_TEXT = process.argv[3] || '[用户附了一张图片，本地路径: C:\\Users\\oadan\\AppData\\Local\\Temp\\agents-to-feishu\\1788009658346-img_v3_02151_be9d7fba-db4b-43cc-bfe8-cfabdb5da66g.png]\n这是啥';

const CMD = process.env.CTI_PROBE_CMD || process.execPath;
const ARGS = process.env.CTI_PROBE_ARGS
  ? process.env.CTI_PROBE_ARGS.split(' ').filter(Boolean)
  : ['--import', 'tsx/esm', 'packages/examples/acp-demo/src/bin.ts', '--config', CONFIG];

const child = spawn(CMD, ARGS, {
  cwd: HARNESS,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      // 摘要打印：方法/工具相关全打，其余打类型
      const tag = msg.method || (msg.result !== undefined ? `result(id=${msg.id})` : `id=${msg.id}`);
      const s = JSON.stringify(msg);
      if (/tool/i.test(s)) console.log('<<', s.slice(0, 600));
      else console.log('<<', tag, s.length > 300 ? s.slice(0, 300) + '…' : s);
    } catch { console.log('<< (非JSON行)', line.slice(0, 200)); }
  }
});
child.stderr.on('data', (d) => {
  const t = d.toString();
  if (!/ExperimentalWarning|trace-warnings/.test(t)) console.error('[harness-stderr]', t.slice(0, 500));
});

function send(obj) {
  const s = JSON.stringify(obj);
  console.log('>>', s.slice(0, 200));
  child.stdin.write(s + '\n');
}

let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    const on = (d) => {
      // 简易匹配：result 带同 id
    };
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const pending = new Map();
child.stdout.on('data', (d) => {
  // 在这里做 id 匹配（重复消费同一流）
});

// 简化：一次性脚本，用全局监听解析 result
const rawChunks = [];
child.stdout.removeAllListeners('data');
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const r = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
      continue;
    }
    const s = JSON.stringify(msg);
    if (/tool/i.test(s)) console.log('<<[TOOL]', s.slice(0, 800));
    else if (msg.method) console.log('<<', msg.method, s.length > 260 ? s.slice(0, 260) + '…' : s);
  }
});

const TIMEOUT = parseInt(process.env.PROBE_TIMEOUT || '120', 10) * 1000;
const timer = setTimeout(() => { console.log(`\n[probe] ${TIMEOUT / 1000}s 超时，结束`); child.kill(); process.exit(0); }, TIMEOUT);

(async () => {
  const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  console.log('[probe] initialize ok, serverInfo =', JSON.stringify(init.result?.serverInfo ?? {}));
  const sn = await rpc('session/new', { cwd: 'C:\\D\\opt', mcpServers: [] });
  const sessionId = sn.result?.sessionId;
  console.log('[probe] session =', sessionId);
  console.log('[probe] 发送看图 prompt（request），等待模型行为…');
  const pr = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: PROMPT_TEXT }] });
  console.log('[probe] prompt 完成 stopReason =', JSON.stringify(pr.result ?? pr.error));
})();
