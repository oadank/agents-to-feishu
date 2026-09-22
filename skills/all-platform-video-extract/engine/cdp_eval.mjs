// 通用：在专用 Edge（CDP 9401）当前页面里执行一段 JS 并打印结果
// 用法：node cdp_eval.mjs "<js 表达式>"       （表达式支持多语句，返回值需是最后一行或 return）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = (process.env.CDP_PORT || readFileSync(join(HERE, 'cdp.port'), 'utf8')).trim();
const expr = process.argv[2] || '1+1';

const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
// 🔴 专用 Edge 里可能同时开着 edge://nurturing/（Microsoft Rewards 欢迎页）等自家页面，且它就排第一。
// 盲取 find(type==='page') 会命错 tab（2026-09-21 实测踩到），所以按 URL 优先挑目标页。
const prefer = process.env.CDP_TARGET_URL || 'douyin\\.com';
const pages = ts.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const page = pages.find((t) => new RegExp(prefer).test(t.url || ''))
  || pages.find((t) => !/^(edge|chrome|about|devtools):/.test(t.url || ''))
  || pages[0];
if (!page) { console.error('CDP 没有 page 目标'); process.exit(1); }
console.error('[cdp_eval] target = ' + page.url);

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

// 🔴 用 async 包装：表达式里可以直接 await fetch(...) 等异步结果（同步表达式照样能用）
const wrapped = `(async function(){ try { return JSON.stringify({ ok: true, v: await (async function(){ ${expr} })() }); } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.stack || e).slice(0, 600) }); } })()`;
const r = await rpc('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
if (r.exceptionDetails) {
  console.error('页面报错:', JSON.stringify(r.exceptionDetails).slice(0, 600));
  process.exit(2);
}
const raw = r.result?.value;
try {
  const j = JSON.parse(raw);
  if (j.ok) console.log(typeof j.v === 'string' ? j.v : JSON.stringify(j.v, null, 1));
  else { console.error('表达式抛错:', j.err); process.exit(3); }
} catch {
  console.log(raw);
}
ws.close();
