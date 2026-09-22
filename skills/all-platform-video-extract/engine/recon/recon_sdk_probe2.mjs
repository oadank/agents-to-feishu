// 探针 v2：补齐 Fetch API 类，看 SDK 能否真正加载 + frontierSign 能否调用
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILE = 'C:/Users/oadan/AppData/Local/Temp/ytdlp-study/webmssdk.es5.js';
const code = readFileSync(FILE, 'utf8');

function el(tag) {
  return {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [],
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { return c; }, removeChild() {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { x: 0, y: 0, width: 300, height: 150, top: 0, left: 0, right: 300, bottom: 150 }; },
    getContext(kind) { return kind === '2d' ? new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) }) : null; },
    toDataURL() { return 'data:image/png;base64,'; }, querySelectorAll() { return []; }, querySelector() { return null; },
  };
}
const loc = { href: 'https://www.douyin.com/', protocol: 'https:', host: 'www.douyin.com', hostname: 'www.douyin.com', origin: 'https://www.douyin.com', pathname: '/', search: '', hash: '', referrer: 'https://www.douyin.com/' };
const doc = {
  cookie: 'ttwid=1; s_v_web_id=verify_test; msToken=FAKE_MS_TOKEN', referrer: 'https://www.douyin.com/', readyState: 'complete',
  hidden: false, visibilityState: 'visible',
  documentElement: el('html'), body: el('body'), head: el('head'),
  createElement: (t) => el(t), createElementNS: (ns, t) => el(t),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  getElementsByTagName: () => [], addEventListener() {}, removeEventListener() {}, location: loc,
};
const win = {
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
  // 🔴 上一版就是缺这几个：SDK 顶层直接读 Request/Headers
  Request, Response, Headers, FormData, Blob, AbortController, AbortSignal, ReadableStream, WebSocket,
  File: globalThis.File || class File {}, FileReader: globalThis.FileReader || class FileReader {},
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}), headers: new Headers() }),
  XMLHttpRequest: function () { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; this.addEventListener = () => {}; },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  Image: function () { return el('img'); },
  MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  requestAnimationFrame: (cb) => setTimeout(cb, 16), cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
};
win.window = win; win.self = win; win.top = win; win.parent = win; win.globalThis = win;

const ctx = vm.createContext(win);
try {
  vm.runInContext(code, ctx, { filename: 'webmssdk.es5.js', timeout: 60000 });
  console.log('✅ SDK 加载完成（无异常）');
} catch (e) {
  console.log('❌ 加载抛异常:', e.name + ': ' + String(e.message).slice(0, 200));
}

const a = win.byted_acrawler;
console.log('byted_acrawler:', typeof a, a && typeof a === 'object' ? Object.keys(a) : '');
if (a && typeof a.frontierSign === 'function') {
  console.log('frontierSign 形参个数:', a.frontierSign.length);
  try {
    const r = a.frontierSign({ url: 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7686131844495969586&device_platform=webapp&aid=6383' });
    console.log('★ frontierSign 调用结果:', JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.log('✗ frontierSign 调用抛错:', e.name + ': ' + String(e.message).slice(0, 220));
  }
} else {
  console.log('✗ frontierSign 不是函数（SDK 没挂全）');
}
