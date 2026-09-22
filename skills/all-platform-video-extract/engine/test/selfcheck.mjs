// 抖音抓流链路自检（阶段 3 测试基建·第一件）
// 改完 sniff_download.mjs / 插件后跑一次，确认没改坏。纯文本+内存校验，不起子进程。
// 用法：node C:\D\opt\tools\yt-dlp\test\selfcheck.mjs      （退出码 0=全过，1=有 FAIL）
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SNIFF = join(ROOT, 'sniff_download.mjs');
const PLUGIN_ROOT = join(ROOT, 'plugins');
const PLUGIN_PY = join(PLUGIN_ROOT, 'douyin-browser', 'yt_dlp_plugins', 'extractor', 'douyin_browser.py');

const pass = [];
const fail = [];
const ok = (m) => pass.push(m);
const bad = (m) => fail.push(m);

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

// ── 1) 排序表达式：从源文件抠**真码**来跑，禁止"测试脚本自己抄一份"（那叫假验证）
const src = read(SNIFF);
if (!src) {
  bad(`抓流脚本不存在：${SNIFF}`);
} else {
  const i = src.indexOf('.sort((');
  const j = src.indexOf('));', i);
  if (i < 0 || j < 0) {
    bad('抠不到排序表达式（.sort((a, b) => ...)），是不是被重构了？');
  } else {
    const arrow = src.slice(i + '.sort('.length, j + 1);
    const mk = (res, px, size, br, h265, h266, wm) => ({ res, px, size, br, h265, h266, wm });
    const list = [
      mk('720x1280-h266', 921600, 2.0e6, 100, false, true, 0),   // 不可播编码，必须最后
      mk('1920x1080-hevc', 2073600, 7.7e6, 800, true, false, 0),
      mk('1080x1920-wm', 2073600, 8.0e6, 810, false, false, 1),  // 带水印，必须倒数第二
      mk('1280x720-h264', 921600, 29.4e6, 900, false, false, 0),
    ];
    for (const preferH264 of [false, true]) {
      const cmp = new Function('preferH264', 'return (' + arrow + ')');
      const got = [...list].sort(cmp(preferH264)).map((r) => r.res);
      const last = got[got.length - 1];
      const secondLast = got[got.length - 2];
      if (last !== '720x1280-h266') bad(`PREFER_H264=${preferH264}: h266 没垫底 → ${got.join(' > ')}`);
      else if (secondLast !== '1080x1920-wm') bad(`PREFER_H264=${preferH264}: 带水印档没垫底 → ${got.join(' > ')}`);
      else ok(`排序 PREFER_H264=${preferH264} → ${got.join(' > ')}`);
    }
  }

  // ── 2) RESOLVE_JSON（插件解析后端）关键片段齐不齐
  const need = [
    ['RESOLVE_JSON 分支', "process.env.RESOLVE_JSON === '1'"],
    ['JSON 输出前缀', "'__RESOLVE_JSON__'"],
    ['视频 ext=mp4', "ext: 'mp4'"],
    ['音频 ext=m4a', "ext: 'm4a'"],
    ['网络音轨兜底', 'sniff-net-audio-'],
    ['封面图域过滤', 'douyinpic'],
  ];
  for (const [name, needle] of need) {
    if (src.includes(needle)) ok(`sniff 含 ${name}`);
    else bad(`sniff 缺 ${name}（找 "${needle}"）`);
  }
}

// ── 3) 插件：文件在不在、目录层级对不对（层级错=静默不加载，踩过）
if (existsSync(PLUGIN_PY)) {
  ok('插件文件存在');
  const py = read(PLUGIN_PY);
  for (const [name, needle] of [['_VALID_URL', '_VALID_URL'], ['解析后端方法', '_resolve_via'], ['双后端注册表', '_JOBS'], ['IE_NAME', 'IE_NAME']]) {
    if (py.includes(needle)) ok(`插件含 ${name}`);
    else bad(`插件缺 ${name}`);
  }
} else {
  bad(`插件文件不存在：${PLUGIN_PY}（层级必须是 <根>/<项目名>/yt_dlp_plugins/extractor/*.py）`);
}

// ── 3b) 签名中转后端（resolve_signed.mjs，插件的 api 后端）
const SIGNED = join(ROOT, 'resolve_signed.mjs');
if (existsSync(SIGNED)) {
  ok('签名中转脚本存在');
  const s = read(SIGNED);
  for (const [name, needle] of [
    ['接口路径', 'aweme/detail'],
    ['签名参数白名单', 'a_bogus'],
    ['统一 JSON marker', '__RESOLVE_JSON__'],
    ['分辨率解析', 'geares'],
    ['视频 ext=mp4', "ext: 'mp4'"],
    ['页面目标按 douyin 优先', 'douyin\\.com'],
  ]) {
    if (s.includes(needle)) ok(`resolve_signed 含 ${name}`);
    else bad(`resolve_signed 缺 ${name}（找 "${needle}"）`);
  }
} else {
  bad(`签名中转脚本不存在：${SIGNED}`);
}

// ── 3c) CDP 目标页挑选：禁止盲取第一个 page（Edge 自家页 edge://nurturing/ 会排第一，2026-09-21 实测踩过）
const BLIND_FILES = ['cdp_eval.mjs', 'sniff_download.mjs', 'resolve_signed.mjs', 'qr_server.mjs',
  'cdp_tool.mjs', 'get_douyin_cookies.mjs', 'douyin_collect.mjs', 'recon/recon_sign.mjs'];
const blind = BLIND_FILES.filter((rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) && /\.find\(\(t\) => t\.type === 'page'/.test(read(p));
});
if (blind.length) bad('仍在盲取第一个 page（应走 pickPage）：' + blind.join(', '));
else ok(`无盲取 page 的写法（${BLIND_FILES.length} 个文件都走 pickPage）`);
if (existsSync(join(ROOT, 'cdp_page.mjs'))) ok('cdp_page.mjs 共享挑选器存在');
else bad('缺 cdp_page.mjs');
// 页面收尾脚本：跑完得把抖音页收走，否则视频页会自动连播下一条、窗口一直在后台响
if (existsSync(join(ROOT, 'park_page.mjs'))) ok('park_page.mjs 收尾脚本存在');
else bad('缺 park_page.mjs（跑完不会收页面，视频页会自动连播）');
if (/park_page\.mjs/.test(read(PLUGIN_PY) || '')) ok('插件跑完会调 park_page 收尾');
else bad('插件里没有 park_page 收尾调用');

// ── 4) 汇总
console.log('=== PASS ===');
pass.forEach((m) => console.log('  ✓ ' + m));
if (fail.length) {
  console.log('=== FAIL ===');
  fail.forEach((m) => console.log('  ✗ ' + m));
}
console.log(`\n结果：${pass.length} 过 / ${fail.length} 挂`);
process.exit(fail.length ? 1 : 0);
