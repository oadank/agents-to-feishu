(() => {
  const norm = (s) => (s || '').replace(/\s+/g, '').trim();
  const vis = (e) => e && e.getClientRects().length > 0;
  const cands = [...document.querySelectorAll('div,span,button,a')].filter((e) => vis(e) && norm(e.textContent) === '登录');
  if (!cands.length) return JSON.stringify({ clicked: false, why: '页面上找不到"登录"按钮', title: document.title, url: location.href });
  const el = cands[cands.length - 1];
  el.click();
  return JSON.stringify({ clicked: true, tag: el.tagName, title: document.title, url: location.href });
})()
