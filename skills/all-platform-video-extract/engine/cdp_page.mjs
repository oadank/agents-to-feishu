// 共享：从 CDP `/json/list` 的结果里挑出要操作的**目标页**
//
// 🔴 为什么需要它（2026-09-21 实测踩到）：专用 Edge 里会同时存在 `edge://nurturing/`
// （Edge 自家的 Microsoft Rewards 欢迎页）之类的内部页面，**而且它常常排在第一个**。
// 直接 `ts.find(t => t.type === 'page')` 就会命中它，症状是：
//   · 抓流把页面导航到别人身上
//   · 登录二维码从自家欢迎页上抓（当然是抓不到）
//   · cdp_tool 的点击作用在错的 tab 上
// 而且**全程不报错**，极难排查。
//
// 挑选优先级：① URL 含 douyin.com ② 非浏览器内部页（edge:/chrome:/about:/devtools:） ③ 兜底第一个
export const pickPage = (list, prefer = /douyin\.com/) => {
  const pages = (list || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  return pages.find((t) => prefer.test(t.url || ''))
    || pages.find((t) => !/^(edge|chrome|about|devtools):/.test(t.url || ''))
    || pages[0];
};
