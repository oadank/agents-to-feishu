// 读抖音页面（收藏/喜欢/主页）：导航 → 滚动加载 → 抽出条目清单，全部本地、不外传。
// 用法：node douyin_collect.mjs <url> [滚动次数]
// 只依赖 Node 22+ 的全局 WebSocket 与 CDP 端口文件 cdp.port（那个已登录的专用 Edge）。
import { readFileSync } from 'node:fs';
import { pickPage } from './cdp_page.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = (process.env.CDP_PORT || readFileSync(join(HERE, 'cdp.port'), 'utf8')).trim();
const URL_ = process.argv[2] || 'https://www.douyin.com/user/self';
const SCROLLS = Number(process.argv[3] || 6);
const TAB = process.argv[4] || '';   // 例如 收藏 / 喜欢：进去后先点这个标签

const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = pickPage(ts);
if (!page) { console.error('CDP 没有 page 目标：先启动专用 Edge'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('连不上 CDP')), { once: true }); });
let seq = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => {
  const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

await rpc('Page.enable'); await rpc('Runtime.enable');
console.log('打开 ' + URL_);
await rpc('Page.navigate', { url: URL_ });
await sleep(9000);
console.log('标题: ' + await ev('document.title') + '   地址: ' + await ev('location.href'));

// 页面结构侦察：有没有 tab、当前在哪个 tab、可见区块标题
console.log('页面上的标签页/入口：');
const tabs = await ev(`(function(){var out=[];document.querySelectorAll('[role=tab],.semi-tabs-tab,[data-e2e="user-profile-tab"] a,[data-e2e="user-tab-item"],li').forEach(function(e){var t=(e.innerText||'').trim();if(t&&t.length<=12&&/收藏|喜欢|作品|合集|短剧|关注|粉丝|列表/.test(t))out.push(t)});return [...new Set(out)].join(' | ')||'（没识别到 tab）'})()`);
console.log('  ' + tabs);

if (TAB) {
  // 标签是 React 绑定的 div/span，点最小的那个文本完全匹配的节点最稳；点不到就用真实鼠标事件兜底
  const clicked = await ev(`(function(){var want=${JSON.stringify(TAB)};var els=[...document.querySelectorAll('li,div,span,a,[role=tab]')].filter(function(e){return (e.innerText||'').trim()===want});els.sort(function(a,b){return (a.innerText.length-a.innerText.length)||(a.getBoundingClientRect().width*b.getBoundingClientRect().width-b.getBoundingClientRect().width*a.getBoundingClientRect().width)});var e=els[0];if(!e)return 'no-element';var r=e.getBoundingClientRect();if(!r.width)return 'zero-size';e.click();var x=r.x+r.width/2,y=r.y+r.height/2;['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y}))});return 'clicked '+Math.round(x)+','+Math.round(y);})()`);
  console.log(`点标签「${TAB}」: ${clicked}`);
  await sleep(7000);
  console.log('点击后地址: ' + await ev('location.href') + '   标题: ' + await ev('document.title'));
}

for (let i = 0; i < SCROLLS; i++) { await ev('window.scrollBy(0, 1400)'); await sleep(1300); }
await ev('window.scrollTo(0, 0)'); await sleep(600);

// 抽条目：视频/图文链接 + 标题文本，按 href 去重，保留出现顺序
const items = await ev(`(function(){
  var map = new Map();
  document.querySelectorAll('a[href*="/video/"],a[href*="/note/"],a[href*="/user/"]').forEach(function(a){
    var href = a.getAttribute('href') || '';
    var m = href.match(/\\/(video|note)\\/(\\d+)/);
    if (!m) return;
    var id = m[2], kind = m[1];
    var box = a.closest('li,div[class*="item"],div[class*="card"]') || a;
    var txt = (box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
    var dur = (box.innerText || '').match(/\\d{1,2}:\\d{2}/g) || [];
    var key = kind + ':' + id;
    if (!map.has(key)) map.set(key, { id: id, kind: kind, url: 'https://www.douyin.com/' + kind + '/' + id, title: txt, dur: dur[dur.length - 1] || '' });
  });
  return JSON.stringify([...map.values()]);
})()`);
const list = JSON.parse(items || '[]');
console.log(`\n抓到 ${list.length} 条条目：`);
list.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. [${x.dur || '?'}] ${x.title || '(无文本)'}\n      ${x.url}`));
if (!list.length) console.log('  空。可能不在收藏 tab 上（用页面标签名告诉我，或我改去点那个 tab），也可能未登录。');
ws.close();
