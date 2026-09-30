// 诊断脚本：列出页面/接口里出现的**每条 aweme**（id、时长、最高分辨率、作者、标题片段）。
// 用途：① sniff_download 下错片时，从推荐流候选里把"下到的那条别人视频"反查出来；
//       ② 在抖音搜索页/推荐流上按目标时长捞片（第 2 个参数传秒数 → 按时长贴近排序）。
// 用法：node recon/feed_probe.mjs "<视频页|搜索页|推荐流URL>" [要找的秒数]
// 前置：专用 Edge 开在 9401 且已登录（端口从 ../cdp.port 读，可用 CDP_PORT 覆盖）
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTFILE = [join(HERE, '..', 'cdp.port'), join(HERE, 'cdp.port')].find((p) => existsSync(p));
const PORT = (process.env.CDP_PORT || (PORTFILE && readFileSync(PORTFILE, 'utf8')) || '9401').trim();
const VIDEO = process.argv[2];
const WANT = Number(process.argv[3] || 0);
if (!VIDEO) { console.error('用法: node feed_probe.mjs "<URL>" [目标秒数]'); process.exit(2); }

const UA = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())['User-Agent'];
const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = ts.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const page = pages.find((t) => /douyin\.com/.test(t.url || '')) || pages.find((t) => !/^(edge|chrome|about|devtools):/.test(t.url || '')) || pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true }); });
let seq = 0; const pending = new Map(); const jsonReqs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url || '';
    if (/aweme|play\/info|video\/play|multi_single|detail/i.test(u) && !/\.(js|css|png|jpg|jpeg|webp|svg|woff)/i.test(u)) jsonReqs.push({ requestId: m.params.requestId, url: u });
  }
});
const rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc('Page.enable'); await rpc('Network.enable'); await rpc('Runtime.enable');
await rpc('Page.navigate', { url: VIDEO });
await sleep(12000);
await rpc('Runtime.evaluate', { expression: `(function(){var v=document.querySelector('video');if(v&&!v.paused)return'playing';if(v){v.play();return'play()'}return'no-video';})()` });
await sleep(9000);

const byId = new Map();
const ent = (id) => { const e = byId.get(id) || { id, px: 0, dur: 0, res: '', renditions: 0 }; byId.set(id, e); return e; };
const ms2s = (n) => { const v = Number(n) || 0; return v > 2000 ? v / 1000 : v; };
function walk(node, depth = 0, ctx = '') {
  if (!node || typeof node !== 'object' || depth > 18) return;
  if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1, ctx); return; }
  const rawId = node.aweme_id ?? node.awemeId ?? node.awemeID ?? node.vid;
  const id = rawId !== undefined && rawId !== null && String(rawId).length >= 8 ? String(rawId) : ctx;
  if (id) {
    const e = ent(id);
    const d = ms2s(node.duration ?? (node.video && node.video.duration) ?? node.video_duration);
    if (d && !e.dur) e.dur = d;
    if (node.desc && !e.desc) e.desc = String(node.desc).replace(/\s+/g, ' ').slice(0, 58);
    if (node.author && node.author.nickname && !e.author) e.author = String(node.author.nickname);
    const w = Number(node.width) || (node.video && Number(node.video.width)) || 0;
    const h = Number(node.height) || (node.video && Number(node.video.height)) || 0;
    if (w * h > e.px) { e.px = w * h; e.res = (w || '?') + 'x' + (h || '?'); }
  }
  const urls = [...(Array.isArray(node.uri_list) ? node.uri_list : []), ...(node.play_addr && Array.isArray(node.play_addr.uri_list) ? node.play_addr.uri_list : []), typeof node.play_addr === 'string' ? [node.play_addr] : [], typeof node.src === 'string' ? [node.src] : [], Array.isArray(node.url_list) ? node.url_list : []]
    .filter((x) => typeof x === 'string' && x.length > 8 && !/^data:/.test(x));
  if (id && urls.length) ent(id).renditions++;
  for (const k of Object.keys(node)) walk(node[k], depth + 1, id);
}
for (const d of jsonReqs.slice(0, 60)) {
  try {
    const { body, base64Encoded } = await rpc('Network.getResponseBody', { requestId: d.requestId });
    if (base64Encoded || !body || body.length > 4e6) continue;
    walk(JSON.parse(body));
  } catch { /* 丢弃 */ }
}
try {
  const r = await rpc('Runtime.evaluate', { expression: `(function(){var root=window._ROUTER_DATA||window.__INITIAL_STATE__||null;return root?JSON.stringify(root):'null'})()`, returnByValue: true });
  const v = r.result?.value;
  if (v && v !== 'null') walk(JSON.parse(v));
} catch (e) { console.log('SSR 读取失败: ' + e.message); }
ws.close();

const list = [...byId.values()].sort((a, b) => (WANT ? Math.abs((a.dur || 9e9) - WANT) - Math.abs((b.dur || 9e9) - WANT) : b.px - a.px));
console.log(`共 ${list.length} 条 aweme（接口 ${jsonReqs.length} 个）${WANT ? `  按时长贴近 ${WANT}s 排` : ''}`);
for (const e of list.slice(0, 40)) {
  const hit = WANT && Math.abs(e.dur - WANT) <= 3 ? '  <== 时长吻合' : '';
  console.log(`  ${e.id}  ${String(e.res || '?').padEnd(11)} ${String(Math.round(e.dur || 0)).padStart(4)}s  ${String(e.author || '?').padEnd(10)} ${String(e.desc || '')}${hit}`);
}
