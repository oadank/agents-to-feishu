// 抖音登录二维码自动刷新服务（本机回环，不对外）
// 解决的问题：抖音网页登录码 2~3 分钟过期，而 agent 每轮"生成→打开"要耗掉约 1 分钟，
// 人工接力必输。这里让用户在自己的浏览器里开 http://127.0.0.1:8899/ ，
// 页面每 10 秒自动重载，二维码永远是活的；同时本进程自己轮询登录态，
// 一旦登录成功立刻导出 Cookie 并调用浏览器抓流引擎下载，全程无人值守。
// 🔴 2026-09-21 起下载改走 sniff_download.mjs：yt-dlp 直解抖音实测只有约 2/3 成功率
//    （抖音风控随机抽奖，不是签名问题），抓流走的是已登录浏览器的真实请求，稳。
//    详情见 SKILL.md「2026-09-21 yt-dlp 复核实测」节。
// 依赖：Node >= 22（全局 WebSocket）+ 同目录 cdp.port / yt-dlp.exe
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pickPage } from './cdp_page.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = (process.env.CDP_PORT || readFileSync(join(HERE, 'cdp.port'), 'utf8')).trim();
const HTTP_PORT = Number(process.env.QR_PORT || 8899);
const VIDEO_URL = process.env.VIDEO_URL || 'https://v.douyin.com/w2CD2pVwgws/';
// 输出目录由 sniff_download.mjs 自己决定（现为 C:\Users\oadan\Videos\VideoExtract\<标题>\）；
// 原 const OUT_DIR = 'C:/D/opt/extract_video' 已作废（2026-09-21 起产物归用户媒体库）
const LOGIN_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_guard']);
const WANTED = /\.(?:douyin|iesdouyin|snssdk|ixigua)\.com$/i;

const state = { phase: 'opening', msg: '正在打开抖音登录页…', qr: null, qrAt: 0, log: [], done: false };
const say = (m) => { const s = `[${new Date().toLocaleTimeString('zh-CN')}] ${m}`; state.log.push(s); state.msg = m; console.log(s); };

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = pickPage(targets);
if (!page) { say('CDP 上没有 page 目标，专用 Edge 可能挂了'); process.exit(1); }

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
await rpc('Page.enable').catch(() => {});
await rpc('Runtime.enable').catch(() => {});
await rpc('Network.enable').catch(() => {});

async function js(expr) {
  const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页内 JS 出错');
  return r.result?.value;
}
// 找二维码矩形；顺便处理"已过期/点击刷新"遮罩
async function locateQr() {
  const expr = `(function(){
    var els=[].slice.call(document.querySelectorAll('img,canvas'));
    for(var i=0;i<els.length;i++){var e=els[i],r=e.getBoundingClientRect();
      if(r.width>=90&&r.height>=90&&Math.abs(r.width-r.height)<r.width*0.35){
        var src=(e.src||'')+e.className;
        if(/^data:image/.test(e.src||'')||/qr/i.test(src)||e.tagName==='CANVAS'){
          return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});
        }}}
    var t=[].slice.call(document.querySelectorAll('div,span,img')).filter(function(e){
      var s=(e.textContent||'').replace(/\\s+/g,'');return /点击刷新|已过期|过期/.test(s)&&s.length<12;});
    if(t.length){t[t.length-1].click();return JSON.stringify({refreshed:true})}
    return 'null';})()`;
  const raw = await js(expr);
  return raw && raw !== 'null' ? JSON.parse(raw) : null;
}
async function openLoginModal() {
  await rpc('Page.navigate', { url: 'https://www.douyin.com/jingxuan' });
  await sleep(9000);
  // 右上角「登录」按钮的真实坐标，页内找不到时按经验点位兜底
  const pos = await js(`(function(){var els=[].slice.call(document.querySelectorAll('div,span,button,a'));
    var h=els.filter(function(e){var r=e.getBoundingClientRect();return r.width>10&&r.height>10&&(e.textContent||'').replace(/\\s+/g,'')==='登录'&&r.y<80;});
    if(!h.length)return 'null';var r=h[0].getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
  let x = 1220, y = 28;
  if (pos && pos !== 'null') { const p = JSON.parse(pos); x = p.x; y = p.y; }
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }).catch(() => {});
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(4000);
  say('登录页已打开，二维码就绪');
}
async function grabQr() {
  const r = await locateQr();
  if (!r) return false;
  if (r.refreshed) { say('二维码过期，已自动点击刷新'); await sleep(2500); return false; }
  const shot = await rpc('Page.captureScreenshot', { format: 'png', clip: { x: r.x - 8, y: r.y - 8, width: r.w + 16, height: r.h + 16, scale: 3 } });
  state.qr = Buffer.from(shot.data, 'base64');
  state.qrAt = Date.now();
  return true;
}
// 🔴 每次查登录态都**新开一条连接**：验证通过后抖音会自己跳转，页面目标会变，
// 用长连接会连不上导致漏判登录成功（轮询 2 秒一次，本机开销可忽略）
async function loginHit() {
  try {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const pg = pickPage(ts);
    if (!pg) return [];
    const w = new WebSocket(pg.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      w.addEventListener('open', res, { once: true });
      w.addEventListener('error', () => rej(new Error('conn')), { once: true });
      setTimeout(() => rej(new Error('timeout')), 4000);
    });
    const got = await new Promise((res, rej) => {
      w.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.cookies || []); }, { once: true });
      w.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
      setTimeout(() => rej(new Error('timeout')), 4000);
    });
    w.close();
    return got.filter((c) => LOGIN_NAMES.has(c.name));
  } catch { return []; }
}
async function exportCookies() {
  // 之前这里调用已被删掉的 cookies() → 崩溃 "cookies is not defined"。
  // 改成跟 loginHit 一样自开一条短连接，页面跳转后也不会失效。
  const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = pickPage(ts);
  if (!pg) throw new Error('CDP 没有 page 目标');
  const w = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.addEventListener('open', res, { once: true }); w.addEventListener('error', () => rej(new Error('conn')), { once: true }); });
  const all0 = await new Promise((res, rej) => {
    w.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.cookies || []); }, { once: true });
    w.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    setTimeout(() => rej(new Error('timeout')), 6000);
  });
  w.close();
  const all = all0.filter((c) => WANTED.test(c.domain));
  if (!all.length) throw new Error('没有抖音域 Cookie');
  const lines = ['# Netscape HTTP Cookie File', '# auto-exported by qr_server.mjs', ''];
  for (const c of all) {
    lines.push([c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', c.expires > 0 ? Math.round(c.expires) : 0, c.name, c.value].join('\t'));
  }
  writeFileSync(join(HERE, 'cookies.txt'), lines.join('\n') + '\n', 'utf8');
  say(`已导出 ${all.length} 条抖音 Cookie 到 cookies.txt`);
  return all;
}
function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: HERE });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
}
async function download() {
  // 🔴 2026-09-21 起改用浏览器抓流引擎（sniff_download.mjs）：它复用同一台已登录 Edge 的真实
  // 播放请求（a_bogus 等签名由抖音自家 JS 算好），实测稳定出片且能拿 1080p。
  // 原 yt-dlp --cookies 直解路线实测只有约 2/3 成功率（抖音风控随机抽奖），不再作为默认。
  say('浏览器抓流引擎开始下载…');
  const r = await run(process.execPath, [join(HERE, 'sniff_download.mjs'), VIDEO_URL]);
  const tail = r.out.split('\n').filter(Boolean).slice(-8).join(' | ');
  say(`抓流结束（退出码 ${r.code}）：${tail.slice(0, 400)}`);
  state.done = true;
  state.phase = r.code === 0 ? 'ok' : 'failed';
}

// ---- HTTP ----
const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10">
<body style="background:#111;color:#eee;font:16px/1.6 system-ui;display:flex;flex-direction:column;align-items:center;padding-top:24px">
<h2 style="margin:0">抖音登录二维码（每 10 秒自动刷新，永不过期）</h2>
<p style="color:#8ab4f8">手机抖音 APP → 左上角「扫一扫」→ 对着下面这张码扫，手机上若弹「确认登录」请点确认</p>
<img src="/qr" style="width:420px;height:420px;background:#fff;border-radius:8px;image-rendering:pixelated">
<pre id="s" style="white-space:pre-wrap;max-width:640px;color:#9f9"></pre>
<script>fetch('/status').then(r=>r.json()).then(j=>{document.getElementById('s').textContent=j.phase+' :: '+j.msg+'\\n'+j.log.slice(-6).join('\\n')})</script>
</body>`;

http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }
  else if (u === '/qr') {
    if (!state.qr || Date.now() - state.qrAt > 20000) { const ok = await grabQr().catch(() => false); if (!ok && !state.qr) { res.writeHead(503); res.end('no qr'); return; } }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(state.qr);
  }
  else if (u === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ phase: state.phase, msg: state.msg, log: state.log.slice(-12) })); }
  else { res.writeHead(404); res.end(); }
}).listen(HTTP_PORT, '127.0.0.1', () => say(`二维码页面: http://127.0.0.1:${HTTP_PORT}/`));

// ---- 主循环：刷码 + 等登录 + 自动下载 ----
// 🔴 SKIP_OPEN=1：绝不调用 openLoginModal()（它会 Page.navigate，把已经走完的
// 短信验证 + 二次验证选择冲掉，只能重发短信）。只用来看当前这张码。
if (process.env.SKIP_OPEN) { say('SKIP_OPEN：不导航不改页面，仅抓当前二维码'); }
else { await openLoginModal(); }
let grabbed = await grabQr();
say(grabbed ? '已抓到二维码，可以在浏览器里看了' : '没定位到二维码，可能页面被改动');
while (!state.done) {
  await sleep(2000);
  const hit = await loginHit();
  if (!hit.length) { if (Date.now() - state.qrAt > 15000) await grabQr().catch(() => {}); continue; }
  say(`检测到登录态字段: ${hit.map((c) => c.name).join(', ')}`);
  state.phase = 'exporting';
  try { await exportCookies(); state.phase = 'downloading'; await download(); }
  catch (e) { say('出错: ' + e.message); state.phase = 'failed'; state.done = true; }
}
say('全部结束，页面保持开着可看结果（Ctrl+C 关本服务）');
ws.close();
setTimeout(() => process.exit(0), 900000);
