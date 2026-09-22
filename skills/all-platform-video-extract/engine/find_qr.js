(function () {
  // 在登录弹窗里找那张二维码，返回它的屏幕矩形（给 ffmpeg 裁剪用）
  var sel = 'img,canvas,svg,div[class*="qrcode" i],div[class*="qr-code" i],div[class*="qr" i]';
  var els = [].slice.call(document.querySelectorAll(sel));
  var best = null;
  els.forEach(function (e) {
    var r = e.getBoundingClientRect();
    if (r.width < 90 || r.height < 90) return;            // 二维码不会太小
    if (Math.abs(r.width - r.height) > r.width * 0.35) return; // 要求接近正方形
    var src = (e.src || e.getAttribute('data-src') || e.className || '').toString();
    var looksQr = /^data:image/.test(src) || /qr/i.test(src) || e.tagName === 'CANVAS';
    if (!looksQr) return;
    if (!best || r.width * r.height > best.w * best.h) {
      best = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), tag: e.tagName, cls: (e.className || '').toString().slice(0, 40) };
    }
  });
  // 找不到就退一步：把弹窗左侧那块区域交出去，人工/自动都能截
  if (!best) {
    var box = [].slice.call(document.querySelectorAll('[class*="login" i],[role="dialog"],[class*="modal" i]'))
      .map(function (e) { return e.getBoundingClientRect(); })
      .filter(function (r) { return r.width > 380 && r.height > 260; })
      .sort(function (a, b) { return b.width * b.height - a.width * a.height; })[0];
    if (box) best = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), tag: 'FALLBACK-MODAL', cls: '' };
  }
  return best ? JSON.stringify(best) : 'NONE';
})()
