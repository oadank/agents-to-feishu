// 阶段 4 侦察：用 CDP 抓一次真实 detail 请求的**完整请求头**，定位 UIFID 落在哪个字段
// 用法：node recon_headers.mjs
import { readFileSync } from 'node:fs';

const PORT = readFileSync('C:/D/opt/tools/yt-dlp/cdp.port', 'utf8').trim();
const AWEME = process.env.AWEME_ID || '7686131844495969586';
const URL_ = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${AWEME}&device_platform=webapp&aid=6383`;

const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = ts.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || '')) || ts.find((t) => t.type === 'page');
if (!page) { console.error('CDP 没有 page 目标'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
});
let seq = 0;
const pending = new Map();
const hits = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent' && /aweme\/detail/.test(m.params?.request?.url || '')) {
    hits.push(m.params.request);
  }
});
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc('Network.enable');
// 用页面自己的 fetch 打一次（带 credentials，等价于业务请求）
const expr = `(async function(){ var r = await fetch(${JSON.stringify(URL_)}, {credentials:"include"}); return (await r.text()).length; })()`;
const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log('页面内 fetch 响应长度:', r.result?.value);
await sleep(1500);

console.log(`\n抓到 ${hits.length} 条 detail 请求\n`);
for (const req of hits.slice(-1)) {
  console.log('=== URL ===');
  console.log(req.url.slice(0, 300));
  console.log('\n=== 请求头（共 ' + Object.keys(req.headers || {}).length + ' 个）===');
  for (const [k, v] of Object.entries(req.headers || {})) {
    const flag = /uifid|bogus|sign|sec|tt-|x-/i.test(k) ? ' ★' : '';
    console.log(`  ${k}: ${String(v).slice(0, 160)}${flag}`);
  }
  const q = req.url.split('?')[1] || '';
  const interesting = q.split('&').filter((p) => /uifid|bogus|sign|a_bogus/i.test(p));
  console.log('\n=== URL 里的签名/标识参数 ===');
  interesting.forEach((p) => console.log('  ' + p.slice(0, 200)));
}
ws.close();
