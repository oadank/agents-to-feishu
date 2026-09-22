// 阶段 4 侦察·第一步：定位承载 a_bogus 签名的 JS
// 做法：导航到抖音视频页 → 列出所有 script src → 探测 window 上挂的签名相关全局对象
// 用法：node recon_sign.mjs      （产物：本目录 recon_globals.json）
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = 'C:/D/opt/tools/yt-dlp';
const PORT = (process.env.CDP_PORT || readFileSync(join(TOOLS, 'cdp.port'), 'utf8')).trim();
const VIDEO = process.env.RECON_URL || 'https://www.douyin.com/video/7686131844495969586';

const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = ts.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('CDP 没有 page 目标：专用 Edge 没开或没登录'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expr) => (await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc('Page.enable').catch(() => {});
await rpc('Runtime.enable').catch(() => {});
console.log('导航到视频页:', VIDEO);
await rpc('Page.navigate', { url: VIDEO });
await sleep(10000);

const list = JSON.parse((await js(`JSON.stringify([].slice.call(document.querySelectorAll('script[src]')).map(function(s){return s.src}))`)) || '[]');
console.log(`\n=== script src 共 ${list.length} 条 ===`);
list.forEach((u, i) => console.log(`  [${i}] ${u}`));

const interesting = list.filter((u) => /webmssdk|acrawler|secsdk|slardar|mssdk|sign|bogus|sec_|sdk/i.test(u));
console.log(`\n=== 名字可疑的 ${interesting.length} 条 ===`);
interesting.forEach((u) => console.log('  ★ ' + u));

console.log('\n=== window 上的签名相关全局 ===');
const probe = await js(`JSON.stringify({
  url: location.href,
  webmssdk: typeof window.webmssdk,
  webmssdkKeys: (window.webmssdk && typeof window.webmssdk === 'object') ? Object.keys(window.webmssdk).slice(0, 50) : null,
  acrawler: typeof window.byted_acrawler,
  acrawlerKeys: (window.byted_acrawler && typeof window.byted_acrawler === 'object') ? Object.keys(window.byted_acrawler).slice(0, 50) : null,
  matched: Object.keys(window).filter(function(k){ return /bogus|sign|webmssdk|acrawler|secsdk|mssdk|sec_/i.test(k) }).slice(0, 80)
}, null, 1)`);
console.log(probe || '(探测无返回)');
writeFileSync(join(HERE, 'recon_globals.json'), String(probe || ''), 'utf8');
writeFileSync(join(HERE, 'recon_scripts.txt'), list.join('\n') + '\n', 'utf8');
console.log('\n产物: recon_globals.json / recon_scripts.txt');
ws.close();
