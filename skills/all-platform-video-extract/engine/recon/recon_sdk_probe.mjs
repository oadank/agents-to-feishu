// 阶段 4 可行性探针：webmssdk.es5.js 直接扔进 Node 的 vm 沙箱，看缺多少环境
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILE = process.env.SDK || 'C:/Users/oadan/AppData/Local/Temp/ytdlp-study/webmssdk.es5.js';
const code = readFileSync(FILE, 'utf8');
console.log('SDK 大小:', code.length, '字符');

function el(tag) {
  return {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [],
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { return c; }, removeChild() {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { x: 0, y: 0, width: 300, height: 150, top: 0, left: 0, right: 300, bottom: 150 }; },
    getContext(kind) { return kind === '2d' ? ctx2d() : null; },
    toDataURL() { return 'data:image/png;base64,'; },
    querySelectorAll() { return []; }, querySelector() { return null; },
  };
}
function ctx2d() {
  const noop = () => {};
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^[a-z]/.test(k) ? noop : undefined)), set: (t, k, v) => (t[k] = v, true) });
}
const loc = { href: 'https://www.douyin.com/', protocol: 'https:', host: 'www.douyin.com', hostname: 'www.douyin.com', origin: 'https://www.douyin.com', pathname: '/', search: '', hash: '' };
const doc = {
  cookie: 'ttwid=1; s_v_web_id=verify_test', readyState: 'complete',
  documentElement: el('html'), body: el('body'), head: el('head'),
  createElement: (t) => el(t), createElementNS: (ns, t) => el(t),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  getElementsByTagName: () => [], addEventListener() {}, removeEventListener() {}, location: loc,
};
const sandbox = {
  console, document: doc, location: loc,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
  navigator: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0',
    platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh'], hardwareConcurrency: 8,
    deviceMemory: 8, maxTouchPoints: 0, webdriver: false, plugins: [], mimeTypes: [], vendor: 'Google Inc.',
    cookieEnabled: true, onLine: true, userAgentData: { brands: [], mobile: false, platform: 'Windows' },
  },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  atob, btoa, TextEncoder, TextDecoder, URL, URLSearchParams,
  performance: { now: () => Date.now(), timing: {}, timeOrigin: Date.now() },
  crypto: globalThis.crypto,
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  XMLHttpRequest: function () { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; this.addEventListener = () => {}; },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  Image: function () { return el('img'); },
  MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  requestAnimationFrame: (cb) => setTimeout(cb, 16), cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.top = sandbox; sandbox.parent = sandbox; sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code, ctx, { filename: 'webmssdk.es5.js', timeout: 60000 });
  console.log('✅ SDK 在最小环境下加载成功（无异常）');
} catch (e) {
  console.log('❌ 加载抛异常:', String(e.message).slice(0, 300));
  console.log('  栈:', String(e.stack || '').split('\n').slice(1, 5).join('\n  '));
}

const keys = Object.keys(sandbox).filter((k) => /byted|acrawler|mssdk|_webrt|secsdk|\$|sign/i.test(k));
console.log('相关全局键:', keys.slice(0, 40));
console.log('byted_acrawler:', typeof sandbox.byted_acrawler);
if (sandbox.byted_acrawler && typeof sandbox.byted_acrawler === 'object') console.log('  keys:', Object.keys(sandbox.byted_acrawler));
for (const k of keys) {
  const v = sandbox[k];
  if (v && typeof v === 'object') {
    const sub = Object.keys(v).filter((x) => /sign|bogus/i.test(x));
    if (sub.length) console.log('  ' + k + ' 里的签名相关成员:', sub.slice(0, 20));
  }
}
