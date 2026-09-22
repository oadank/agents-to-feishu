// 用 CDP Debugger 的 V8 级搜索，在所有已加载脚本里定位 a_bogus / uifid / x-secsdk-web-signature 的生成点
import { readFileSync } from 'node:fs';
const PORT = readFileSync('C:/D/opt/tools/yt-dlp/cdp.port', 'utf8').trim();
const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = ts.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || '')) || ts.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('cdp')), { once: true }); });
let seq = 0; const pending = new Map(); const scripts = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === 'Debugger.scriptParsed') scripts.push({ id: m.params.scriptId, url: m.params.url || '' });
});
const rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc('Debugger.enable');
await sleep(4000);
console.log('已解析脚本数:', scripts.length);
const QUERIES = ['a_bogus', 'x-secsdk-web-signature', 'uifid', 'X-Bogus'];
for (const q of QUERIES) {
  console.log('\n=== 搜索 "' + q + '" ===');
  let files = 0;
  for (const s of scripts) {
    if (!s.url || /^(extensions|devtools):/.test(s.url)) continue;
    try {
      const r = await rpc('Debugger.searchInContent', { scriptId: s.id, query: q, caseSensitive: true });
      const hits = r.result || [];
      if (hits.length) {
        files++;
        console.log('  ★ ' + s.url.replace(/^https?:\/\//, '').slice(0, 110) + '   (' + hits.length + ' 处)');
        hits.slice(0, 2).forEach((h) => console.log('      L' + h.lineNumber + ': ' + String(h.lineContent).trim().slice(0, 220)));
      }
    } catch { /* 有些 script 已释放 */ }
  }
  if (!files) console.log('  （无命中）');
}
await rpc('Debugger.disable').catch(() => {});
ws.close();
