import { spawn } from 'node:child_process';
import fs from 'node:fs';
const exe = 'C:\\Users\\oadan\\AppData\\Local\\Programs\\Reasonix\\reasonix-cli.exe';
// 复刻桥接 persona 注入：config.reasonix.env 的 GLOBAL + 独立 prompt
function loadPersona() {
  try {
    const env = fs.readFileSync('C:\\Users\\oadan\\.agents-to-feishu\\config.reasonix.env', 'utf-8');
    const grab = (k) => {
      const m = env.match(new RegExp(k + '="((?:[^"\\\\]|\\\\.)*)"'));
      return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
    };
    return (grab('CTI_SYSTEM_PROMPT_GLOBAL') + '\n\n' + grab('CTI_BOT_REASONIX_SYSTEM_PROMPT')).trim();
  } catch { return ''; }
}
const PERSONA = loadPersona();
console.log('persona len =', PERSONA.length);
const child = spawn(exe, ['acp'], { cwd: 'C:\\D\\opt', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: {
  ...process.env,
  APPDATA: 'C:\\Users\\oadan\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\oadan', HOME: 'C:\\Users\\oadan',
  PATH: (process.env.PATH || '') + ';C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Program Files\\nodejs;C:\\Users\\oadan\\AppData\\Roaming\\npm;C:\\Program Files\\Git\\bin;C:\\Program Files\\GitHub CLI',
} });
let buf = '';
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
let sessionId = '';
let newCount = 0;
child.stderr.on('data', (c) => console.log('[STDERR]', c.toString().trim().slice(0, 200)));
child.on('exit', (code) => { console.log('[EXIT]', code); process.exit(0); });
child.stdout.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    let m;
    try { m = JSON.parse(line); } catch { console.log('[UNPARSEABLE]', line.slice(0, 200)); continue; }
    const tag = m.id != null ? `id=${m.id}` : 'notif';
    if (m.method) {
      if (m.method === 'session/request_permission') {
        console.log(`[PERM] options=${JSON.stringify(m.params?.options?.map((o) => o.optionId))} kind=${m.params?.kind}`);
        send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: m.params?.options?.find((o) => /allow/i.test(o.optionId))?.optionId || m.params?.options?.[0]?.optionId } } });
      } else if (m.method === 'session/update') {
        const u = m.params?.update;
        if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
          console.log(`[TOOL ${u.sessionUpdate}] status=${u.status} title=${u.title} rawInput=${JSON.stringify(u.rawInput)?.slice(0, 150)}`);
        } else if (u?.sessionUpdate === 'agent_message_chunk') {
          console.log('[MSG]', (u.content?.text || '').slice(0, 200));
        } else {
          console.log(`[UPD ${u?.sessionUpdate}]`);
        }
      } else {
        console.log(`[${tag}] ${m.method}`);
      }
      continue;
    }
    // responses
    if (m.id === 1) {
      send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:\\D\\opt', mcpServers: [] } });
    } else if (m.id === 2) {
      newCount++;
      sessionId = m.result?.sessionId || sessionId;
      console.log(`[RESP id=2 #${newCount}] keys=${Object.keys(m.result || {})} sessionId=${String(m.result?.sessionId).slice(0, 12)} err=${JSON.stringify(m.error)}`);
      if (newCount === 1 && sessionId) {
        send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: PERSONA + '\n\n重测：执行 shell 命令 gh api user --jq .login 并把输出原样告诉我。' }] } });
        console.log('--- prompt sent ---');
      }
    } else if (m.id === 3) {
      console.log(`[RESP id=3]`, JSON.stringify(m).slice(0, 400));
      process.exit(0);
    } else {
      console.log(`[${tag}]`, JSON.stringify(m).slice(0, 200));
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 180000);
