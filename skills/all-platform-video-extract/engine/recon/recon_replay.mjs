// 阶段 4 侦察·一锤定音：抓真实请求的完整 URL → Node 原样重放 → 逐项删参数定位「最小必需集」
// 用法：node recon_replay.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = readFileSync('C:/D/opt/tools/yt-dlp/cdp.port', 'utf8').trim();
const AWEME = process.env.AWEME_ID || '7686131844495969586';
const BASE = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${AWEME}&device_platform=webapp&aid=6383`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

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
  if (m.method === 'Network.requestWillBeSent' && /aweme\/detail/.test(m.params?.request?.url || '')) hits.push(m.params.request.url);
});
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});

await rpc('Network.enable');
const expr = `(async function(){ var r = await fetch(${JSON.stringify(BASE)}, {credentials:"include"}); return (await r.text()).length; })()`;
const rr = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log('页面内触发 fetch，响应长度:', rr.result?.value);
await new Promise((r) => setTimeout(r, 1200));

const cookies = await new Promise((res, rej) => {
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 99) res(m.result?.cookies || []); });
  ws.send(JSON.stringify({ id: 99, method: 'Network.getAllCookies' }));
  setTimeout(() => rej(new Error('取 cookie 超时')), 8000);
});
ws.close();

const douyin = cookies.filter((c) => /douyin/i.test(c.domain || ''));
const ck = douyin.map((c) => `${c.name}=${c.value}`).join('; ');
const full = hits[hits.length - 1];
if (!full) { console.error('没抓到 detail 请求'); process.exit(1); }
console.log(`抓到完整 URL：${full.length} 字符`);
writeFileSync(process.env.TEMP + '\\ytdlp-study\\recon_full_url.txt', full, 'utf8');

const strip = (u, key) => u.replace(new RegExp('[&?]' + key + '=[^&]*'), '');
const headers = (cookie) => ({
  'user-agent': UA,
  referer: 'https://www.douyin.com/',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  ...(cookie ? { cookie } : {}),
});
async function probe(label, url, cookie) {
  try {
    const r = await fetch(url, { headers: headers(cookie) });
    const t = await r.text();
    const ok = t.includes('aweme_detail');
    console.log(`  ${label.padEnd(34)} HTTP ${r.status} len=${String(t.length).padStart(6)} ${ok ? '✅ 成功' : '❌ ' + t.slice(0, 46).replace(/\s+/g, ' ')}`);
    return ok;
  } catch (e) { console.log(`  ${label.padEnd(34)} 异常 ${e.message}`); return false; }
}

console.log('\n=== A. 带浏览器 cookie ===');
await probe('① 完整签名 URL', full, ck);
for (const k of ['a_bogus', 'uifid', 'x-secsdk-web-signature', 'msToken', 'verifyFp']) {
  await new Promise((r) => setTimeout(r, 1200));
  await probe('② 去掉 ' + k, strip(full, k), ck);
}
console.log('\n=== B. 不带任何 cookie ===');
await new Promise((r) => setTimeout(r, 1200));
await probe('③ 完整签名 URL，无 cookie', full, '');
await new Promise((r) => setTimeout(r, 1200));
await probe('④ 只留 uifid，无 cookie', `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${AWEME}&device_platform=webapp&aid=6383&uifid=${(full.match(/[&?]uifid=([^&]*)/) || [])[1] || ''}`, '');
