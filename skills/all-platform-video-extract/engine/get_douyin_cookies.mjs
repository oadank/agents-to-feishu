// 从专用 Edge 实例的调试接口(CDP)取抖音 Cookie，导出成 yt-dlp 能直接吃的 cookies.txt
// 为什么走 CDP：Edge 独占锁死 Cookie 库 + 新版 Chromium 系统级加密，yt-dlp 的
//   --cookies-from-browser edge 在这台机器上实测报 PermissionError(见 openmem 记录)。
//   CDP 返回的是浏览器自己解好密的明文值，绕开这两道墙。
// 依赖：Node >= 22.4（用全局 WebSocket，零依赖）。本机 Node v24 实测可用。
// 用法：node get_douyin_cookies.mjs          端口从同目录 cdp.port 读
//       CDP_PORT=9401 node get_douyin_cookies.mjs
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = (process.env.CDP_PORT || readFileSync(join(HERE, 'cdp.port'), 'utf8')).trim();
const OUT = join(HERE, 'cookies.txt');
// 抖音播放器实际会用到这几个域，别缩到只剩 douyin.com（短链在 v.douyin.com，
// 鉴权跳转会落 iesdouyin.com）
const WANTED = /\.(?:douyin|iesdouyin|snssdk|ixigua)\.com$/i;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error(`CDP ${PORT} 上没有 page 目标 —— 那个专用 Edge 窗口被关了？重开它`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const rpc = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', (e) => rej(new Error('连不上 CDP：' + (e.message || e.type))), { once: true });
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});

await rpc('Network.enable');
const { cookies } = await rpc('Network.getAllCookies');
ws.close();

const mine = cookies.filter((c) => WANTED.test(c.domain));
if (!mine.length) {
  console.error('!! 这个专用 Edge 里一条抖音 Cookie 都没有 —— 你还没在它里面打开/登录抖音');
  process.exit(2);
}

const lines = ['# Netscape HTTP Cookie File', '# 由 get_douyin_cookies.mjs 从 CDP 导出，勿手改', ''];
for (const c of mine) {
  const domain = c.domain.startsWith('.') ? c.domain : c.domain;
  const flag = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const secure = c.secure ? 'TRUE' : 'FALSE';
  const expiry = c.expires > 0 ? Math.round(c.expires) : 0;
  lines.push([domain, flag, c.path || '/', secure, expiry, c.name, c.value].join('\t'));
}
writeFileSync(OUT, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
try { chmodSync(OUT, 0o600); } catch {}

// 登录态判据：抖音的 sessionid / sid_guard 只有登录后才有；ttwid 匿名也有
const names = new Set(mine.map((c) => c.name));
const loggedIn = names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_guard');
console.log(`导出 ${mine.length} 条抖音域 Cookie -> ${OUT}`);
console.log(`域名分布: ${[...new Set(mine.map((c) => c.domain))].join(', ')}`);
console.log(loggedIn ? '✅ 检测到登录态字段(sessionid/sid_guard)，可以下带登录限制的视频了'
                     : '⚠️ 只有匿名 Cookie（没找到 sessionid）—— 还没登录，登录受限视频仍会被拒');
