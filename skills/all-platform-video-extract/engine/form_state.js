(function () {
  // 只报结构与值，不报 Cookie；用于确认输入是否真落进框里
  var out = { url: location.href, title: document.title };
  out.fields = [].slice.call(document.querySelectorAll('input,textarea')).filter(function (e) {
    var r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4;
  }).map(function (e) {
    var r = e.getBoundingClientRect();
    return { ph: e.placeholder || '', type: e.type || '', value: (e.value || '').slice(0, 30), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  out.buttons = [].slice.call(document.querySelectorAll('div,span,button,a')).filter(function (e) {
    var r = e.getBoundingClientRect(); if (r.width < 8 || r.height < 8) return false;
    var t = (e.textContent || '').replace(/\s+/g, '');
    return t.length > 0 && t.length <= 10 && /获取验证码|验证码登录|登录|同意|确认|下一步|滑块|拖动/.test(t);
  }).map(function (e) {
    var r = e.getBoundingClientRect();
    return { txt: (e.textContent || '').trim().slice(0, 12), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }).slice(0, 20);
  // 同意勾选框状态（没勾上，发验证码会被拦）
  out.checks = [].slice.call(document.querySelectorAll('input[type=checkbox],[class*="check" i],[role=checkbox]')).map(function (e) {
    var r = e.getBoundingClientRect();
    return { checked: !!e.checked, cls: (e.className || '').toString().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), vis: r.width > 4 };
  }).filter(function (c) { return c.vis; }).slice(0, 6);
  return JSON.stringify(out, null, 1);
})()
