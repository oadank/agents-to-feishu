// 收尾：把专用 Edge 的页面「停」到不播东西的位置（2026-09-21，老大点名要求）
//
// 为什么需要：抖音视频页**播完会自动连播下一条**，窗口留在那儿就会在后台一直响。
//   而且不光是抓流后端会播——签名中转后端虽然只发一次接口请求，但页面被留在视频页上，
//   抖音自己也会开始播。所以无论走哪条路，跑完都得把页面收走。
//
// 🔴 为什么默认停 about:blank 而不是抖音首页：**抖音首页自己也会自动播放推荐流**（通常还带声音），
//   停在首页照样达不到"别一直循环播放"的目的。要停在首页就设 PARK_URL。
//
// 用法：
//   node park_page.mjs                                   # 默认 → about:blank（安静）
//   PARK_URL=https://www.douyin.com/ node park_page.mjs   # 停在抖音首页（会自己播，不推荐）
//   浏览器没开时静默退出（不算失败）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPage } from './cdp_page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = (process.env.CDP_PORT || readFileSync(join(HERE, 'cdp.port'), 'utf8')).trim();
const TARGET = process.env.PARK_URL || 'about:blank';

let ts;
try {
  ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
} catch {
  console.log('[park] 调试口连不上（浏览器没开），无需收尾');
  process.exit(0);
}
const page = pickPage(ts);
if (!page) { console.log('[park] 没有可用的页面目标'); process.exit(0); }
if ((page.url || '') === TARGET) { console.log('[park] 页面已在目标位置，不动'); process.exit(0); }

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

try {
  await rpc('Page.enable');
  await rpc('Page.navigate', { url: TARGET });
  console.log(`[park] 已把页面从「${String(page.url).slice(0, 50)}」停到「${TARGET}」`);
} catch (e) {
  console.log('[park] 收尾失败（不影响下载结果）: ' + e.message);
}
ws.close();
process.exit(0);
