// 「签名中转」解析器（2026-09-21 新增，插件后端之一）
// 思路：a_bogus / uifid / x-secsdk-web-signature 这些参数藏在 webmssdk 的 VM 字节码里、且由拦截器
// 自动注入 fetch（实测：字符串搜不到、公开入口 frontierSign 调用 0 次），补环境复刻代价过高。
// 但实测「完整签名 URL + cookie」用 Node 原生 fetch 重放 → HTTP 200 数据完整。
// 所以这里只借浏览器一道手：让它发一次详情请求，我们抄下**已被 SDK 签好名的 URL**，剩下全在 Node 里干。
//
// 相比抓流（sniff_download.mjs）的好处：不用播放视频、不用等 20~40 秒、不用从 SSR 的几百路杂质里挑，
// 接口返回的就是全部转码档 + 原声音轨。代价：浏览器仍需开着（但只是挂个页面，不参与下载）。
//
// 用法：RESOLVE_JSON=1 node resolve_signed.mjs "<视频URL或短链>"
// 输出：一行 __RESOLVE_JSON__{id,title,duration,webpage_url,formats[]}（与 sniff 格式一致）
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = (process.env.CDP_PORT || readFileSync(join(HERE, 'cdp.port'), 'utf8')).trim();
const VIDEO = process.argv[2] || process.env.VIDEO_URL || '';
const MARKER = '__RESOLVE_JSON__';
const SIG_KEYS = /^(a_bogus|X-Bogus|x-bogus|uifid|msToken|verifyFp|fp|x-secsdk-web-signature|webid|_signature)$/;

if (!VIDEO) { console.error('用法: RESOLVE_JSON=1 node resolve_signed.mjs "<视频URL>"'); process.exit(1); }
const log = (m) => console.error('[signed] ' + m);

// ── 1) 拿 aweme id（短链跟随跳转）
async function getAwemeId(url) {
  const direct = url.match(/\/video\/(\d+)/) || url.match(/\/note\/(\d+)/);
  if (direct) return direct[1];
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } });
  const m = r.url.match(/\/(?:video|note)\/(\d+)/);
  if (m) return m[1];
  const body = await r.text();
  const m2 = body.match(/\/(?:video|note)\/(\d{15,})/);
  if (m2) return m2[1];
  throw new Error('解析不出 aweme id（短链没跳到视频页？）');
}

// ── 2) 连 CDP，挑对页面（必须优先 douyin，否则会命中 edge://nurturing/ 那种自家页）
const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = ts.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const page = pages.find((t) => /douyin\.com/.test(t.url || ''))
  || pages.find((t) => !/^(edge|chrome|about|devtools):/.test(t.url || ''))
  || pages[0];
if (!page) { console.error('CDP 没有 page 目标：专用 Edge 没开？'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
});
let seq = 0;
const pending = new Map();
let signedUrl = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params?.request?.url || '';
    if (/aweme\/detail/.test(u) && !signedUrl) signedUrl = u;
  }
});
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const awemeId = await getAwemeId(VIDEO);
log('aweme id = ' + awemeId);
const bare = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&device_platform=webapp&aid=6383`;

await rpc('Page.enable').catch(() => {});
await rpc('Network.enable');
// 🔴 页面必须位于抖音域内：否则对 douyin.com 的 fetch 既跨域、又带不上登录 cookie。
//    实测踩到（2026-09-21）：浏览器刚启动停在「新建标签页」时，解析直接失败。不在域内就先导航过去。
if (!/douyin\.com/.test(page.url || '')) {
  log(`页面不在抖音域（当前 ${String(page.url).slice(0, 60)}），先导航到视频页…`);
  await rpc('Page.navigate', { url: `https://www.douyin.com/video/${awemeId}` });
  await sleep(9000);
}
// 让页面发一次详情请求：SDK 的拦截器会往里注入 a_bogus/uifid/msToken/verifyFp/x-secsdk-web-signature
const expr = `(async function(){ var r = await fetch(${JSON.stringify(bare)}, {credentials:"include"}); return (await r.text()).length; })()`;
const ev = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
log('页面内请求响应长度: ' + ev.result?.value);
for (let i = 0; i < 20 && !signedUrl; i++) await sleep(200);
if (!signedUrl) { console.error('没抓到被签名的请求 URL（页面没登录？拦截器没生效？）'); process.exit(2); }

const sig = signedUrl.split('?')[1]?.split('&').filter((p) => SIG_KEYS.test(p.split('=')[0])) || [];
log(`抓到签名 URL（${signedUrl.length} 字符），签名参数 ${sig.length} 个: ${sig.map((s) => s.split('=')[0]).join(', ')}`);

const cookies = await new Promise((res, rej) => {
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 777) res(m.result?.cookies || []); });
  ws.send(JSON.stringify({ id: 777, method: 'Network.getAllCookies' }));
  setTimeout(() => rej(new Error('取 cookie 超时')), 8000);
});
ws.close();
const cookie = cookies.filter((c) => /douyin/i.test(c.domain || '')).map((c) => `${c.name}=${c.value}`).join('; ');
log(`带上 ${cookie.split('; ').length} 条抖音 cookie 去重放`);

// ── 3) Node 侧重放签名 URL（这一步完全不碰浏览器）
const resp = await fetch(signedUrl, {
  headers: {
    'user-agent': process.env.UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0',
    referer: 'https://www.douyin.com/',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    cookie,
  },
});
const text = await resp.text();
log(`重放结果 HTTP ${resp.status}，${text.length} 字节`);
if (!text.includes('aweme_detail')) {
  console.error('重放没拿到 aweme_detail：' + text.slice(0, 200));
  process.exit(3);
}
const detail = JSON.parse(text).aweme_detail;

// ── 4) 解析成 formats（规则参考 yt-dlp 的 _parse_aweme_video_app）
const v = detail.video || {};
const formats = [];
const pushAddr = (addr, meta) => {
  for (const u of addr?.url_list || []) {
    if (typeof u !== 'string' || !u.startsWith('http')) continue;
    formats.push({
      url: u, ext: 'mp4', acodec: 'none',
      ...meta,
      format_id: `${meta.format_id}-${formats.length}`,
      // API 路径（aweme/v1）容易被额外拦，按 yt-dlp 的做法降权
      format_note: `${meta.format_note}${/aweme\/v1/.test(u) ? ' (API)' : ''}`,
    });
  }
};
// 分辨率解析：抖音 gear_name 形如 normal_720_0 / adapt_lowest_1080_1 / h264_720p_217550。
// 🔴 不能直接找 3~4 位数字：h264 的 "264" 和码率 "217550" 都会误命中。按优先级取：
//   ① xx720p 形式 ② 下划线包裹的 3~4 位数字 ③ 放弃（交给 play_addr 自带的宽高）
const geares = (name) => {
  const s = String(name || '');
  let m = /(\d{3,4})p/i.exec(s);
  if (m) return Number(m[1]);
  m = /_(\d{3,4})(?=_|$)/.exec(s);
  return m ? Number(m[1]) : null;
};

// 4a) bit_rate 各档（最全的一批）
const baseW = Number(v.width) || 0;
const baseH = Number(v.height) || 0;
const ratio = (baseW && baseH) ? baseW / baseH : 16 / 9;
for (const [i, br] of (v.bit_rate || []).entries()) {
  if (!br.play_addr) continue;
  // 分辨率优先取 play_addr 自带的宽高（yt-dlp 也这么做），没有才退回 gear_name 里的数字
  const paH = Number(br.play_addr?.height) || null;
  const paW = Number(br.play_addr?.width) || null;
  const h = paH || geares(br.gear_name) || baseH || null;
  const w = paW || (h ? Math.round(h * ratio) : (baseW || null));
  pushAddr(br.play_addr, {
    format_id: `gear-${br.gear_name || i}`,
    width: w, height: h,
    vcodec: (br.is_h265 || br.is_bytevc1) ? 'hevc' : 'h264',
    tbr: br.bit_rate ? Math.round(br.bit_rate / 1000) : null,
    fps: br.FPS || null,
    format_note: `interface gear ${br.gear_name || i}`,
  });
}
// 4b) 直链（无水印，通常是最高清）
if (v.play_addr) pushAddr(v.play_addr, { format_id: 'play_addr', width: v.width || null, height: v.height || null, vcodec: (v.is_h265 || v.is_bytevc1) ? 'hevc' : 'h264', format_note: 'interface direct' });
if (v.play_addr_h264) pushAddr(v.play_addr_h264, { format_id: 'play_h264', width: v.width || null, height: v.height || null, vcodec: 'h264', format_note: 'interface direct h264' });
if (v.play_addr_bytevc1) pushAddr(v.play_addr_bytevc1, { format_id: 'play_h265', width: v.width || null, height: v.height || null, vcodec: 'hevc', format_note: 'interface direct hevc' });
// 4c) 带水印档（垫底）
if (v.download_addr) pushAddr(v.download_addr, { format_id: 'download_addr', width: v.width || null, height: v.height || null, vcodec: 'h264', format_note: 'interface watermarked', preference: -10 });
// 4d) 原声音轨（抖音视频音轨＝原声文件；实测是 mp3，别一律标 m4a）
for (const u of detail.music?.play_url?.url_list || []) {
  if (typeof u !== 'string' || !u.startsWith('http')) continue;
  const aext = /\.mp3(\?|$)/i.test(u) ? 'mp3' : 'm4a';
  formats.push({ url: u, ext: aext, vcodec: 'none', acodec: aext === 'mp3' ? 'mp3' : 'aac', format_id: `music-${formats.length}`, format_note: 'interface music track' });
}

const dur = v.duration ? Number(v.duration) / 1000 : (detail.duration ? Number(detail.duration) / 1000 : null);
log(`解析出 ${formats.length} 路（视频 ${formats.filter((f) => f.vcodec !== 'none').length} / 音频 ${formats.filter((f) => f.vcodec === 'none').length}）`);

console.log(MARKER + JSON.stringify({
  id: String(detail.aweme_id || awemeId),
  title: (detail.desc || '').trim() || `douyin-${awemeId}`,
  duration: dur,
  webpage_url: `https://www.douyin.com/video/${detail.aweme_id || awemeId}`,
  formats,
}));
if (process.env.DUMP_SIGNED_URL) writeFileSync(process.env.DUMP_SIGNED_URL, signedUrl, 'utf8');
process.exit(0);
