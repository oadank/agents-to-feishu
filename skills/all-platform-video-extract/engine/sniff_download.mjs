// 用「已登录的浏览器」当解析引擎：抓最高清晰度 + 保留音频，每条视频一个子目录。
// 为什么不用 yt-dlp 直解抖音：详情接口要 a_bogus 签名（抖音自家 JS 现场算），
// stable 2026.08.19 / nightly 2026.09.16 喂完整登录 Cookie 仍 403。让浏览器自己播，我们抄地址。
// 🔴 清晰度三级来源（按可靠性）：
//   1) 页面 SSR 数据 window._ROUTER_DATA —— 抖音把完整 rendition 清单塞在首屏脚本里，
//      含 bit_rate_list / play_addr.uri_list，不依赖播放器当时选了哪一路；
//   2) 拦截详情接口 JSON 响应体（aweme/detail、play/info 之类），同样递归挖；
//   3) 都没有才回退「网络响应里 content-length 最大的那路」（实测只有 576p，偏低）。
// 产物：<OUT_ROOT>/<视频标题>/video.mp4（最高画质合流）、audio.m4a（单独音频，喂 ASR/妙记）、info.json
// 用法：node sniff_download.mjs "<视频页URL>" [子目录名覆盖]
import { writeFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = (process.env.CDP_PORT || readFileSync(join(HERE, 'cdp.port'), 'utf8')).trim();
const VIDEO = process.argv[2] || 'https://v.douyin.com/w2CD2pVwgws/';
const NAME_OVERRIDE = process.argv[3];
const OUT_ROOT = process.env.OUT_ROOT || 'C:/Users/oadan/Videos/VideoExtract';
const UA = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())['User-Agent'];

const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
// 🔴 2026-09-21 修：专用 Edge 里会同时存在 edge://nurturing/ 之类自家页面且排第一，
// 盲取 find(type==='page') 会命错 tab（navigate 到别人身上，抓流全废）。按 URL 优先挑抖音页。
const pages = ts.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const page = pages.find((t) => /douyin\.com/.test(t.url || ''))
  || pages.find((t) => !/^(edge|chrome|about|devtools):/.test(t.url || ''))
  || pages[0];
if (!page) throw new Error('CDP 没有 page 目标：先启动专用 Edge（app_run 参数见 SKILL.md）');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true }); });
let seq = 0; const pending = new Map(); const media = []; const jsonReqs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else if (m.method === 'Network.responseReceived') {
    const r = m.params.response; const u = r.url || '';
    if (/aweme|play\/info|video\/play|multi_single|detail/i.test(u) && !/\.(js|css|png|jpg|jpeg|webp|svg|woff)/i.test(u)) {
      jsonReqs.push({ requestId: m.params.requestId, url: u, mime: r.mimeType || '' });
    }
    const isMedia = /\.(mp4|m4s|flv|m3u8)(\?|$)/i.test(u) || /media-video|media-audio|video_mp4|\/aweme\/|playAddr/i.test(u) || /^video\//i.test(r.mimeType || '');
    if (isMedia) media.push({ url: u, mime: r.mimeType, length: Number(r.headers?.['content-length'] || r.headers?.['Content-Length'] || 0) });
  }
});
const rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc('Page.enable'); await rpc('Network.enable'); await rpc('Runtime.enable');
console.log('导航到视频页，让浏览器自己算签名…');
await rpc('Page.navigate', { url: VIDEO });
await sleep(10000);
await rpc('Runtime.evaluate', { expression: `(function(){var v=document.querySelector('video');if(v&&!v.paused)return'playing';if(v){v.play();return'play()'}return'no-video';})()` })
  .then((r) => console.log('播放: ' + JSON.stringify(r.result?.value))).catch(() => {});
await sleep(8000);
const title = await rpc('Runtime.evaluate', { expression: 'document.title' }).then((r) => String(r.result?.value || '')).catch(() => '');
// 🔴 锚点：真正在播的那条视频的时长与地址。推荐流 SSR 里混着几百条别的视频，
//    只按分辨率挑会下错片（实测把 26 秒 4K 竖屏当成目标下载），必须用时长对齐来筛。
const href = await rpc('Runtime.evaluate', { expression: 'location.href' }).then((r) => String(r.result?.value || '')).catch(() => '');
const playDur = await rpc('Runtime.evaluate', { expression: `(function(){var v=document.querySelector('video');return v&&v.duration&&isFinite(v.duration)?v.duration:0})()` }).then((r) => Number(r.result?.value) || 0).catch(() => 0);
const playSize = await rpc('Runtime.evaluate', { expression: `(function(){var v=document.querySelector('video');return v&&v.videoWidth?v.videoWidth+'x'+v.videoHeight:''})()` }).then((r) => String(r.result?.value || '')).catch(() => '');
console.log(`播放锚点: 时长 ${playDur.toFixed(2)}s  播放器分辨率 ${playSize || '?'}  地址 ${href.slice(0, 60)}`);

// 递归收集任何"带地址 + 带清晰度信息"的对象，字段位置全不猜，改版也扛得住
function walk(node, found, depth = 0) {
  if (depth > 16 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, found, depth + 1); return; }
  const urls = [];
  const push = (x) => { if (typeof x === 'string' && x.length > 8 && !/^data:/.test(x)) urls.push(x); };
  if (Array.isArray(node.uri_list)) node.uri_list.forEach(push);
  if (node.play_addr && typeof node.play_addr === 'object') (node.play_addr.uri_list || []).forEach(push);
  if (typeof node.play_addr === 'string') push(node.play_addr);
  if (typeof node.src === 'string' && /https?:|\/\//.test(node.src)) push(node.src);
  if (Array.isArray(node.url_list)) node.url_list.forEach(push);
  if (urls.length) {
    const px = (Number(node.width) || 0) * (Number(node.height) || 0);
    const br = Number(node.bit_rate ?? node.bitrate ?? node.gate_width ?? 0) || 0;
    // 抖音时长字段单位不统一（有的毫秒有的秒），>2000 一律按毫秒处理
    const raw = Number(node.duration ?? node.total_duration ?? node.video_duration ?? node.play_dur ?? 0) || 0;
    const dur = raw > 2000 ? raw / 1000 : raw;
    // 编码器判据（实测）：抖音把编码写在流路径里 —— `media-video-hvc1` = HEVC，无此标记即 H.264 系。
    // 元数据里的 is_h265/codec_type 在这份清单里根本不存在，所以以 URL 标记为准；
    // 体积用同对象的 data_size（整段字节），比按分辨率猜准得多。
    const own = Object.entries(node).filter(([, v]) => typeof v === 'string').map(([, v]) => String(v).toLowerCase()).join(' ');
    const urlText = urls.map((u) => String(u).toLowerCase()).join(' ');
    const h265 = node.is_h265 === 1 || /hvc1|hevc|h265|av01|\bav1\b/.test(urlText + ' ' + own) || Number(node.codec_type) >= 2;
    // 🔴 2026-09-21 吸收 yt-dlp 的格式偏好规则（见 SKILL.md「yt-dlp 复核实测」）：
    //   · h266/bytevc2（抖音自研 VVC）至今播不了 → 垫底（yt-dlp 标它 UNPLAYABLE 且 preference −100）
    //   · 带水印档 → 垫底（yt-dlp 给它 −2）。判据取抖音 URL 上的 lr=unwatermarked / watermark=0|1
    //     注意顺序：必须先判 unwatermarked，否则 "watermarked" 会把 "unwatermarked" 也命中
    const h266 = /bytevc2|hvc2|h266|vvc/.test(urlText + ' ' + own);
    const wm = /unwatermarked|watermark=0/.test(urlText) ? 0 : (/watermark=1|watermarked/.test(urlText) ? 1 : -1);
    const size = Number(node.data_size ?? node.size ?? 0) || 0;
    found.push({ urls, px, br, size, dur, h265, h266, wm, res: (node.width || '?') + 'x' + (node.height || '?'), keys: Object.keys(node).join(','), def: String(node.definition ?? node.quality ?? node.label ?? node.ratio ?? '') });
  }
  for (const k of Object.keys(node)) walk(node[k], found, depth + 1);
}
const renditions = [];

// 来源 1：页面 SSR 的 _ROUTER_DATA。🔴 但它是**整个推荐流**的数据（实测 1300+ 路，绝大多数是别人的视频），
// 直接全量递归会挑到别的片子。先按当前 aweme id 在页内把子树裁出来，再挖清晰度。
const awemeId = (href.match(/\/video\/(\d+)/) || href.match(/\/note\/(\d+)/) || [])[1] || '';
if (awemeId) {
  try {
    const expr = `(function(){var id=${JSON.stringify(awemeId)};var root=window._ROUTER_DATA||window.__INITIAL_STATE__||null;if(!root)return'null';var hits=[];(function scan(o,d){if(!o||typeof o!=='object'||d>18||hits.length>4)return;if(Array.isArray(o)){o.forEach(function(x){scan(x,d+1)});return;}var v=o.aweme_id||o.awemeId||o.awemeID||o.vid||o.id;if(String(v)===id){hits.push(o);return;}for(var k in o){scan(o[k],d+1);}})(root,0);return hits.length?JSON.stringify(hits):'null';})()`;
    const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = r.result?.value;
    if (v && v !== 'null') {
      const before = renditions.length;
      walk(JSON.parse(v), renditions);
      console.log(`SSR 收敛到本条 aweme ${awemeId}: 挖到 ${renditions.length - before} 路候选`);
    } else console.log('SSR 里没定位到本条 aweme 的子树');
  } catch (e) { console.log('SSR 提取失败: ' + e.message); }
} else {
  console.log('地址里没解析出 aweme id，跳过 SSR 来源');
}
// 来源 2：拦到的 JSON 响应体。同样只认与本条 aweme 相关的接口，避免把推荐流条目混进来。
for (const d of jsonReqs.slice(0, 40)) {
  if (awemeId ? !d.url.includes(awemeId) : !/aweme\/detail|play\/info|video\/play/i.test(d.url)) continue;
  try {
    const { body, base64Encoded } = await rpc('Network.getResponseBody', { requestId: d.requestId });
    if (base64Encoded || !body || body.length > 4e6) continue;
    walk(JSON.parse(body), renditions);
  } catch { /* 响应体已被丢弃，忽略 */ }
}
ws.close();

const norm = (u) => (u.startsWith('http') ? u : 'https://' + u.replace(/^\/\//, ''));
const isAudio = (u) => /media-audio|audio_mp4|type=audio|\baudio\b/i.test(u);
// SSR 数据里混着封面、图标、预取地址，必须只认媒体域名/后缀，否则会把 jpg 当视频下
const looksMedia = (u) => /douyinvod|\.mp4|\.m4s|video\/tos|videotoros|\/aweme\/|media-video|media-audio|ixigua/i.test(u);
const uniq = (arr) => [...new Set(arr)];
// 时长对不上的一律踢掉。容差必须给宽：同一视频的高码率档与播放器那档，容器时长会差几秒
// （实测 340.4s 的播放锚点 vs 同片 1080p 探出 343.4s，硬卡 1.6s 会把正主的 1080p 误杀）。
// 取 max(5s, 3%)，真·别条视频（差几十到几百秒）依然拦得住。
const DUR_TOL = Math.max(5, playDur * 0.03);
const sameClip = (r) => !playDur || !r.dur || Math.abs(r.dur - playDur) <= DUR_TOL;
// 默认**分辨率优先**（老大 2026-09-19 定）：目的是做知识库，画质对转写没帮助，
// HEVC 反而更清晰更省盘。要喂剪映/老设备时设 PREFER_H264=1 改回 H.264 优先。
const preferH264 = process.env.PREFER_H264 === '1';
const vidR = renditions.filter((r) => r.urls.some((u) => looksMedia(norm(u)) && !isAudio(norm(u))) && sameClip(r))
  // 排序优先级：不可播编码(h266)垫底 → 带水印垫底 → 可选 h264 优先 → 分辨率 → 体积 → 码率
  // 🔴 水印必须排在 h264 偏好**前面**：否则 PREFER_H264=1 时，带水印的 h264 会挤掉无水印的 1080p
  .sort((a, b) => (Number(!!a.h266) - Number(!!b.h266))
    || ((a.wm === 1 ? 1 : 0) - (b.wm === 1 ? 1 : 0))
    || (preferH264 ? Number(!!a.h265) - Number(!!b.h265) : 0)
    || (b.px - a.px) || (b.size - a.size) || (b.br - a.br));
const audR = renditions.filter((r) => r.urls.every((u) => isAudio(norm(u)))).sort((a, b) => b.br - a.br);
const uniqNet = [...new Map(media.map((m) => [m.url.split('?')[0] + '|' + m.url.slice(-40), m])).values()].sort((a, b) => b.length - a.length);

console.log(`标题: ${title}`);
console.log(`候选：清晰度清单 ${renditions.length} 路（视频 ${vidR.length}/音频 ${audR.length}），网络媒体响应 ${media.length} 条，JSON 接口 ${jsonReqs.length} 个`);
vidR.slice(0, 8).forEach((r, i) => console.log(`  [清单${i}] ${r.res || '?'} ${r.size ? (r.size / 1048576).toFixed(1) + 'MB' : '?'} ${r.dur ? Math.round(r.dur) + 's ' : ''}${r.h266 ? 'H.266/不可播' : r.h265 ? 'HEVC/AV1' : 'H.264'}${r.wm === 1 ? ' 带水印' : r.wm === 0 ? ' 无水印' : ''}${process.env.DUMP_KEYS ? '\n        字段: ' + r.keys : ''}`));
// 🔴 2026-09-21 新增 RESOLVE_JSON=1：给 yt-dlp 插件当"只解析不下载"的后端用。
// 输出一行带唯一前缀的 JSON（诊断日志仍在前面，消费方按前缀找这一行即可，不用把日志改道）
if (process.env.RESOLVE_JSON === '1') {
  const px2wh = (s) => { const m = /^(\d+)x(\d+)$/.exec(String(s || '')); return m ? [Number(m[1]), Number(m[2])] : [null, null]; };
  const formats = [];
  vidR.forEach((r, i) => {
    const [w, h] = px2wh(r.res);
    uniq(r.urls.map(norm)).filter((u) => looksMedia(u) && !isAudio(u) && !/douyinpic/i.test(u)).forEach((u, j) => formats.push({
      url: u, ext: 'mp4', width: w, height: h, filesize: r.size || null, tbr: r.br || null,
      vcodec: r.h266 ? 'h266' : (r.h265 ? 'hevc' : 'h264'), acodec: 'none',
      format_id: `sniff-${i}-${j}`,
      format_note: `browser-sniff${r.wm === 1 ? ' watermarked' : ''}${r.h266 ? ' (unplayable)' : ''}`,
    }));
  });
  audR.forEach((r, i) => {
    uniq(r.urls.map(norm)).filter(isAudio).forEach((u, j) => formats.push({
      url: u, ext: 'm4a', vcodec: 'none', acodec: 'aac', filesize: r.size || null, tbr: r.br || null,
      format_id: `sniff-audio-${i}-${j}`, format_note: 'browser-sniff audio',
    }));
  });
  // 🔴 音频兜底（2026-09-21 实测踩到）：清单里往往没有独立音轨，只有 CDP 抓到的网络音频响应。
  // 不补这一步，yt-dlp 只能选到纯视频档 → 成片没声音（表现为 "Downloading 1 format(s)"）。
  uniqNet.filter((m) => isAudio(m.url)).forEach((m, i) => formats.push({
    url: m.url, ext: 'm4a', vcodec: 'none', acodec: 'aac', filesize: m.length || null,
    format_id: `sniff-net-audio-${i}`, format_note: 'browser-sniff audio (net)',
  }));
  console.log('__RESOLVE_JSON__' + JSON.stringify({
    id: awemeId || null, title, duration: playDur || null, webpage_url: href || VIDEO, formats,
  }));
  process.exit(0);
}
if (process.env.LIST_ONLY === '1') {
  console.log('（LIST_ONLY：只列清单不下载）');
  vidR.slice(0, 6).forEach((r, i) => console.log(`  [${i}] ${r.px ? Math.round(Math.sqrt(r.px)) + 'p级' : '?'} ${r.h265 ? 'h265/av1' : '无h265标记'} ${uniq(r.urls).slice(0, 2).map(norm).join('  ||  ').slice(0, 140)}`));
  process.exit(0);
}
if (process.env.DUMP_API) { writeFileSync(join(dirname(process.env.DUMP_API), '_api_urls.txt'), jsonReqs.map((d) => d.url).join('\n')); console.log('  已 dump 接口清单'); }

const safe = (NAME_OVERRIDE || title || '').replace(/ - 抖音$/, '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || ('douyin-' + (href.match(/\/video\/(\d+)/)?.[1] || 'video'));
const DIR = join(OUT_ROOT, safe); mkdirSync(DIR, { recursive: true });
const vCandidates = [
  ...vidR.flatMap((r) => uniq(r.urls.map(norm)).filter((u) => !isAudio(u)).map((u) => ({ url: u, from: '清晰度清单' }))),
  ...uniqNet.filter((m) => !isAudio(m.url) && !/m3u8/.test(m.url)).map((m) => ({ url: m.url, from: '网络最大路' })),
];
const aCandidates = [
  ...audR.flatMap((r) => uniq(r.urls.map(norm)).filter(isAudio).map((u) => ({ url: u, from: '清晰度清单' }))),
  ...uniqNet.filter((m) => isAudio(m.url)).map((m) => ({ url: m.url, from: '网络' })),
];
if (!vCandidates.length) { console.error('!! 一个视频流都没抓到：可能要多等或需手动播放'); process.exit(4); }

async function dl(url, file) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.douyin.com/', origin: 'https://www.douyin.com' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 20000) throw new Error('仅 ' + buf.length + ' 字节，不像成片');
  writeFileSync(file, buf);
  console.log(`  拿到 ${(buf.length / 1048576).toFixed(1)}MB`);
  return buf.length;
}
const vraw = join(DIR, '_video_only.mp4');
const afile = join(DIR, 'audio.m4a');
const final = join(DIR, 'video.mp4');
// 下载后实测校验（元数据里的编码器标记不可靠，实测读不出来，所以一律以 ffprobe 为准）：
//   · 时长对不上 = 别条视频，删掉继续
//   · 时长对得上但不是 h264 = 先存作兜底，继续找 h264 那一路（除非 ALLOW_HEVC=1）
const probeFile = (p) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', p], { encoding: 'utf8' });
  const o = {}; (r.stdout || '').replace(/\r/g, '').split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); });
  return { dur: Number(o.duration) || 0, vcodec: o.codec_name || '' };
};
let chosen = null, vsize = 0, tries = 0;
let fallback = null, fbytes = 0;
const KEEP = join(process.env.TEMP || 'C:/Windows/Temp', 'sniff_fallback.mp4');
for (const c of vCandidates) {
  if (++tries > 12) { console.log('  已试 12 路，收手（避免狂下一堆垃圾）'); break; }
  try {
    vsize = await dl(c.url, vraw);
    const p = probeFile(vraw);
    if (playDur && Math.abs(p.dur - playDur) > DUR_TOL) {
      console.log(`  ✗ 内容是别条视频（${p.dur.toFixed(1)}s ≠ 目标 ${playDur.toFixed(1)}s），丢弃`);
      if (existsSync(vraw)) unlinkSync(vraw);
      continue;
    }
    if (preferH264 && p.vcodec && p.vcodec !== 'h264') {
      console.log(`  ✓ 内容对（${p.dur.toFixed(0)}s）但编码是 ${p.vcodec}，存为兜底，继续找 h264 那一路…`);
      if (!fallback) { try { renameSync(vraw, KEEP); fallback = { ...c, codec: p.vcodec }; fbytes = vsize; } catch { unlinkSync(vraw); } }
      else unlinkSync(vraw);
      continue;
    }
    chosen = { ...c, codec: p.vcodec || 'h264' };
    break;
  }
  catch (e) { console.log(`  这路失败（${e.message}），降级下一路…`); }
}
if (!chosen && fallback) {
  if (!existsSync(KEEP)) { console.error('!! 兜底件不在了'); process.exit(6); }
  renameSync(KEEP, vraw);
  chosen = fallback;
  console.log('  没找到 h264 那一路，采用兜底：' + fallback.codec + ' ' + (fbytes / 1048576).toFixed(1) + 'MB（要长期只收 h264 就说一声，我改成宁可降级分辨率也要 h264）');
}
if (!chosen) { console.error('!! 全部候选下载失败'); process.exit(5); }
console.log(`  视频来源: ${chosen.from}`);
let asize = 0, gotAudio = false;
for (const c of aCandidates) { try { asize = await dl(c.url, afile); gotAudio = true; break; } catch { /* 下一路 */ } }
let merged = false;
if (gotAudio) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vraw, '-i', afile, '-c', 'copy', '-movflags', '+faststart', final], { encoding: 'utf8' });
  merged = r.status === 0;
  if (!merged) console.log('  合流失败，改用带声轨原件：' + (r.stderr || '').trim().slice(0, 120));
}
if (merged) { if (existsSync(vraw)) unlinkSync(vraw); console.log('  已合流 -> video.mp4（单独 audio.m4a 保留，喂 ASR/妙记）'); }
else { renameSync(vraw, final); }

const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', final], { encoding: 'utf8' });
const kv = {}; probe.stdout.replace(/\r/g, '').split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); });
const info = { source_url: VIDEO, title, saved_at: new Date().toISOString(), engine: 'browser-sniff', video: { file: 'video.mp4', bytes: (stat(final)), width: kv.width, height: kv.height, codec: kv.codec_name, duration_sec: kv.duration }, audio: gotAudio ? { file: 'audio.m4a', bytes: stat(afile) } : null, picked_from: chosen.from, rendition_list_size: renditions.length };
writeFileSync(join(DIR, 'info.json'), JSON.stringify(info, null, 2), 'utf8');
console.log(`结果: ${kv.width}x${kv.height} ${Math.round(Number(kv.duration) || 0)}秒 | video ${(info.video.bytes / 1048576).toFixed(1)}MB | audio ${(asize / 1048576).toFixed(1)}MB`);
console.log('目录: ' + DIR);

function stat(p) { try { return readFileSync(p).length; } catch { return 0; } }
