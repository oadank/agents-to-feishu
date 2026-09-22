// CDP 驱动工具：对专用 Edge 实例「看、点、拖、打字」，不依赖窗口可见
// 用法:
//   node cdp_tool.mjs evalfile <js文件>            执行表达式并打印返回值
//   node cdp_tool.mjs nav <url>                    当前页跳转
//   node cdp_tool.mjs shot <out.png>               整页截图
//   node cdp_tool.mjs state                        列出可点按钮/输入框/弹窗线索（决定下一步用）
//   node cdp_tool.mjs click "<按钮文字或placeholder>"   真实鼠标点击命中的最后一个元素
//   node cdp_tool.mjs clickxy <x> <y>              真实鼠标点击指定坐标
//   node cdp_tool.mjs type "<文本>"                 往当前聚焦输入框真输入（支持中文）
//   node cdp_tool.mjs drag <x1> <y1> <x2> <y2>     按住拖动（滑块验证码用）
//   node cdp_tool.mjs key <键名>                   回车/Tab/Backspace 等
//   node cdp_tool.mjs waitlogin [秒]               轮询等登录态 Cookie 出现
// 端口读同目录 cdp.port（bind 实测挑的空闲口）
import { readFileSync, writeFileSync } from 'node:fs';
import { pickPage } from './cdp_page.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = (process.env.CDP_PORT || readFileSync(join(HERE, 'cdp.port'), 'utf8')).trim();
const [cmd, ...rest] = process.argv.slice(2);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = pickPage(targets);
if (!page) throw new Error(`CDP ${PORT} 上没有 page 目标：专用 Edge 挂了，重开它`);

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
const rpc = (method, params = {}) =>
  new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (s) => JSON.stringify(s);

async function evalJs(expr) {
  await rpc('Runtime.enable');
  const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页内执行出错: ' + r.exceptionDetails.text);
  return r.result?.value;
}
// 找元素中心坐标（按文字/placeholder 模糊匹配，只认看得见的）
async function findCenter(needle) {
  const expr = `(function(){var t=${ev(needle)};var norm=function(s){return (s||'').replace(/\\s+/g,'')};
  var sel='input,textarea,[contenteditable],button,a,div,span,label,[role=button]';
  var hit=[].slice.call(document.querySelectorAll(sel)).filter(function(e){var r=e.getBoundingClientRect();
    if(!r.width||!r.height||r.width<6||r.height<6)return false;
    var k=norm((e.placeholder||'')+(e.getAttribute('aria-label')||'')+(e.textContent||'')+(e.title||''));
    return k.indexOf(norm(t))>=0;});
  if(!hit.length)return null;var e=hit[hit.length-1];var r=e.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),tag:e.tagName,ph:e.placeholder||'',txt:(e.textContent||'').trim().slice(0,30),n:hit.length});})()`;
  const raw = await evalJs(expr);
  return raw ? JSON.parse(raw) : null;
}
async function mouseClick(x, y) {
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(60);
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(70);
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
}
async function mouseDrag(x1, y1, x2, y2) {
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 });
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1 });
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x1 + ((x2 - x1) * i) / steps), y: Math.round(y1 + ((y2 - y1) * i) / steps), button: 'left', buttons: 1 });
    await sleep(28);
  }
  await sleep(120);
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1, buttons: 0 });
}
const LOGIN_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_guard']);
async function loginState() {
  await rpc('Network.enable').catch(() => {});
  const { cookies } = await rpc('Network.getAllCookies');
  return cookies.filter((c) => LOGIN_NAMES.has(c.name));
}

if (!cmd) { console.error('缺子命令'); process.exit(1); }

if (cmd === 'evalfile') {
  console.log(JSON.stringify(await evalJs(readFileSync(rest[0], 'utf8')), null, 2));
} else if (cmd === 'nav') {
  await rpc('Page.enable');
  await rpc('Page.navigate', { url: rest[0] });
  console.log('已跳转: ' + rest[0]);
} else if (cmd === 'shot') {
  await rpc('Page.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  const r = await rpc('Page.captureScreenshot', { format: 'png' });
  writeFileSync(rest[0], Buffer.from(r.data, 'base64'));
  console.log('截图已存: ' + rest[0]);
} else if (cmd === 'state') {
  const expr = `(function(){var out={url:location.href,title:document.title};
  out.inputs=[].slice.call(document.querySelectorAll('input,textarea,[contenteditable]')).filter(function(e){var r=e.getBoundingClientRect();return r.width>4&&r.height>4;}).map(function(e){var r=e.getBoundingClientRect();return {ph:e.placeholder||'',type:e.type||'',x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width)};});
  out.clickables=[].slice.call(document.querySelectorAll('button,a,[role=button],div,span')).filter(function(e){var r=e.getBoundingClientRect();if(r.width<8||r.height<8)return false;var t=(e.textContent||'').replace(/\\s+/g,'').trim();return t.length>0&&t.length<=8&&/登录|扫码|手机号|验证码|下一步|同意|取消|密码|刷新/.test(t);}).map(function(e){var r=e.getBoundingClientRect();return {txt:(e.textContent||'').trim().slice(0,12),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};}).slice(0,24);
  out.hasQR=!!document.querySelector('img[src*="qr"],canvas[class*="qr"],[class*="qrcode"],[class*="Qrcode"]');
  out.modalCount=document.querySelectorAll('[class*="mask"],[class*="modal"],[class*="dialog"],[role=dialog]').length;
  return JSON.stringify(out,null,1);})()`;
  console.log(await evalJs(expr));
} else if (cmd === 'click') {
  const c = await findCenter(rest[0]);
  if (!c) { console.error('找不到可点元素: ' + rest[0]); process.exit(4); }
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, buttons: 0 }).catch(() => {});
  await mouseClick(c.x, c.y);
  console.log(JSON.stringify({ 点了: c }));
} else if (cmd === 'clickxy') {
  await mouseClick(Number(rest[0]), Number(rest[1]));
  console.log(`已点 (${rest[0]},${rest[1]})`);
} else if (cmd === 'drag') {
  await mouseDrag(...rest.slice(0, 4).map(Number));
  console.log(`已拖 (${rest[0]},${rest[1]}) -> (${rest[2]},${rest[3]})`);
} else if (cmd === 'type') {
  await rpc('Input.insertText', { text: rest[0] ?? '' });
  console.log(`已输入 ${[...rest[0] ?? ''].length} 个字符到聚焦框`);
} else if (cmd === 'key') {
  const map = { Enter: ['Enter', '\r'], Tab: ['Tab', '\t'], Backspace: ['Backspace', ''] };
  const [key, text] = map[rest[0]] || [rest[0], ''];
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: rest[0], code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0 });
  await rpc('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'char' : 'keyUp', text, key: rest[0], code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0 });
  if (key !== 'Enter') await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: rest[0], code: key });
  else await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  console.log('已按键: ' + rest[0]);
} else if (cmd === 'waitlogin') {
  const secs = Number(rest[0] || 360);
  const deadline = Date.now() + secs * 1000;
  let n = 0;
  while (Date.now() < deadline) {
    const hit = await loginState().catch(() => []);
    n++;
    if (hit.length) { console.log(`✅ 登录态到手（第 ${n} 次轮询；字段: ${hit.map((c) => c.name).join(', ')}）`); ws.close(); process.exit(0); }
    await sleep(2000);
  }
  console.log(`❌ ${secs} 秒内没等到登录态（轮询 ${n} 次）`);
  ws.close();
  process.exit(3);
} else {
  console.error('未知子命令: ' + cmd);
  process.exit(1);
}
ws.close();
