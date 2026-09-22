// 阶段 4 侦察·关键对照实验：把"浏览器环境"和"cookie"两个变量掰开
// 用 Node 原生 fetch（无浏览器上下文、无 TLS 伪装、无页面 JS）打同一个 detail 接口，
// 分三组：完整 cookie / 仅匿名 cookie / 完全无 cookie
// 用法：node recon_nodereq.mjs
import { readFileSync } from 'node:fs';

const PORT = readFileSync('C:/D/opt/tools/yt-dlp/cdp.port', 'utf8').trim();
const AWEME = process.env.AWEME_ID || '7686131844495969586';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = ts.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || '')) || ts.find((t) => t.type === 'page');
if (!page) { console.error('CDP 没有 page 目标'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
});
const cookies = await new Promise((res, rej) => {
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.cookies || []); });
  ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
  setTimeout(() => rej(new Error('CDP 超时')), 8000);
});
ws.close();

const douyin = cookies.filter((c) => /douyin/i.test(c.domain || ''));
const LOGIN = /^(sessionid|sessionid_ss|sid_guard|sid_tt|sid_ucp|uid_tt|ssid_ucp|passport_)/;
const anon = douyin.filter((c) => !LOGIN.test(c.name));
const ck = (arr) => arr.map((c) => `${c.name}=${c.value}`).join('; ');

const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${AWEME}&device_platform=webapp&aid=6383`;
const headers = (cookie) => ({
  'user-agent': UA,
  referer: 'https://www.douyin.com/',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  ...(cookie ? { cookie } : {}),
});

async function probe(label, cookie) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: headers(cookie) });
    const t = await r.text();
    const ok = t.includes('aweme_detail');
    console.log(`${label.padEnd(24)} HTTP ${r.status}  len=${String(t.length).padStart(6)}  ${ok ? '✅ 有 aweme_detail' : '❌ 无数据'}  ${Date.now() - t0}ms`);
    if (!ok) console.log('   响应开头: ' + t.slice(0, 120).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`${label.padEnd(24)} 异常: ${e.message}`);
  }
}

console.log(`抖音域 cookie ${douyin.length} 条（登录态 ${douyin.length - anon.length} / 匿名 ${anon.length}）`);
console.log(`目标: ${url}\n`);
await probe('① 完整 cookie', ck(douyin));
await new Promise((r) => setTimeout(r, 2000));
await probe('② 仅匿名 cookie', ck(anon));
await new Promise((r) => setTimeout(r, 2000));
await probe('③ 完全无 cookie', '');
