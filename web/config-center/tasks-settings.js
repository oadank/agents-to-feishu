/* 团队任务账前端（2026-09-20）—— 纯 DOM，无框架依赖，照 config-center 独立页规矩挂在 iframe 里。
   数据全走 textContent，任务标题里带尖括号也不会把页面戳穿。 */
(function () {
  'use strict';

  var API = '/api/tasks';
  var lastRev = -1;
  var cache = [];

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function api(path, method, body) {
    return fetch(API + path, {
      method: method || 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); }).catch(function (e) {
      return { ok: false, error: '请求失败：' + (e && e.message ? e.message : String(e)) };
    });
  }

  var FLUSH_MS = 6000;
  function say(text, kind) {
    var m = $('msg');
    m.textContent = text || '';
    m.className = 'msg ' + (kind || 'dim');
    if (kind === 'err') { setTimeout(function () { if (m.textContent === text) m.textContent = ''; }, 12000); }
  }

  function me() {
    var v = $('me').value.trim();
    if (!v) { say('先把「操作人」填上（你是谁），不然领活交活都会被拒', 'err'); return ''; }
    return v;
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso), diff = (Date.now() - d.getTime()) / 60000;
    var hm = d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
    if (diff < 1) return '刚刚';
    if (diff < 60) return Math.round(diff) + ' 分钟前';
    if (diff < 60 * 24) return hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  // ── 渲染 ──
  function renderStats(b) {
    var box = $('stats'); box.textContent = '';
    var c = b.counts || {};
    [['total', '总账'], ['todo', '待办'], ['doing', '在做'], ['review', '待验'], ['done', '完成'], ['blocked', '卡住']]
      .forEach(function (pair) {
        var s = el('div', 'stat');
        s.appendChild(el('b', null, c[pair[0]] === undefined ? '-' : c[pair[0]]));
        s.appendChild(el('span', null, pair[1]));
        box.appendChild(s);
      });
  }

  function renderAlerts(b) {
    var box = $('alerts'); box.textContent = '';
    var any = false;
    (b.shardClash || []).forEach(function (x) {
      any = true;
      box.appendChild(el('div', 'alert bad', '🔴 地盘撞车：' + x.shard + ' 同时有 ' + x.ids.length + ' 件在做（' + x.ids.join(' / ') + '）—— 并成一件事，或让一家交棒'));
    });
    (b.stale || []).forEach(function (x) {
      any = true;
      box.appendChild(el('div', 'alert', '🟡 卡住：' + x.id + ' ' + x.title + '（' + x.owner + '）已经 ' + x.hours + ' 小时没动'));
    });
    (b.noEvidence || []).forEach(function (x) {
      any = true;
      box.appendChild(el('div', 'alert', '🟡 空口完成：' + x.id + ' ' + x.title + '（' + x.owner + '）标了完成但没证据'));
    });
    (b.reopened || []).forEach(function (x) {
      any = true;
      box.appendChild(el('div', 'alert', '🔁 回炉 ' + x.count + ' 次：' + x.id + ' ' + x.title +
        (x.last ? '（最近：' + x.last.from + '→' + x.last.to + ' · ' + x.last.why + ' · ' + x.last.by + '）' : '')));
    });
    if (!any) box.appendChild(el('div', 'alert', '✅ 没撞车、没卡住、没空口完成 —— 账很干净', 'ok'));
  }

  function actionBtn(label, cls, fn) {
    var b = el('button', 'btn mini ' + (cls || ''), label);
    b.addEventListener('click', fn);
    return b;
  }

  function renderRows(tasks) {
    var tb = $('rows'); tb.textContent = '';
    if (!tasks.length) {
      var tr0 = el('tr'); var td0 = el('td', 'dim', '账上空着。上面建第一条。'); td0.colSpan = 7; tr0.appendChild(td0); tb.appendChild(tr0); return;
    }
    tasks.forEach(function (t) {
      var tr = el('tr');
      var tdId = el('td');
      tdId.appendChild(el('span', 'id', t.id));
      tdId.appendChild(el('div', 'rev', 'v' + t.rev + (t.dedupeKey ? ' · 幂等 ' + t.dedupeKey : '')));
      tr.appendChild(tdId);

      var tdTitle = el('td');
      tdTitle.appendChild(el('div', null, t.title));
      if (t.intent) {
        var d = el('details'); d.appendChild(el('summary', 'dim', '意图'));
        d.appendChild(el('div', 'dim', t.intent)); tdTitle.appendChild(d);
      }
      tr.appendChild(tdTitle);
      tr.appendChild(el('td', 'dim', t.shard));
      tr.appendChild(el('td', null, t.owner));

      var tdSt = el('td');
      tdSt.appendChild(el('span', 'pill ' + t.status, t.status));
      tr.appendChild(tdSt);
      tr.appendChild(el('td', 'dim', fmtTime(t.updatedAt)));

      var tdAct = el('td');
      if (t.evidence) {
        var dd = el('details'); dd.appendChild(el('summary', 'ok', '有证据'));
        dd.appendChild(el('div', 'dim', t.evidence)); tdAct.appendChild(dd);
      } else if (t.status !== 'todo') {
        tdAct.appendChild(el('span', 'warn', '无证据'));
      }
      var line = el('div', 'row'); line.style.margin = '4px 0 0';
      if (t.status === 'todo') line.appendChild(actionBtn('领活', 'primary', function () { claim(t); }));
      if (t.status === 'doing') line.appendChild(actionBtn('报完成', 'primary', function () { advance(t, 'done'); }));
      if (t.status === 'doing') line.appendChild(actionBtn('卡住', '', function () { advance(t, 'blocked'); }));
      if (t.status === 'blocked') line.appendChild(actionBtn('接着干', 'primary', function () { advance(t, 'doing'); }));
      if (t.status === 'done') line.appendChild(actionBtn('回炉', '', function () { advance(t, 'doing', true); }));
      line.appendChild(actionBtn('记一笔', '', function () { note(t); }));
      tdAct.appendChild(line);
      if (t.history && t.history.length) {
        var dh = el('details'); dh.appendChild(el('summary', 'dim', '流水 ' + t.history.length + ' 条'));
        var ul = el('ul', 'hist');
        t.history.slice(-12).reverse().forEach(function (h) {
          ul.appendChild(el('li', null, fmtTime(h.at) + ' · ' + h.by + ' · ' + h.action +
            (h.from || h.to ? ' [' + (h.from || '?') + '→' + (h.to || '?') + ']' : '') + (h.note ? ' · ' + h.note : '')));
        });
        dh.appendChild(ul); tdAct.appendChild(dh);
      }
      tr.appendChild(tdAct);
      tb.appendChild(tr);
    });
  }

  // ── 动作 ──
  function claim(t) {
    var by = me(); if (!by) return;
    api('/' + encodeURIComponent(t.id) + '/claim', 'POST', { by: by, baseRev: t.rev }).then(function (r) {
      if (r.conflict) { say(r.error, 'err'); load(true); return; }
      if (!r.ok) { say(r.error || '领活没成', 'err'); return; }
      say('已领下 ' + t.id + '（第 ' + r.task.rev + ' 版）', 'ok');
      load(true);
    });
  }

  function advance(t, to, needWhy) {
    var by = me(); if (!by) return;
    var body = { by: by, baseRev: t.rev, status: to };
    if (to === 'done') {
      var ev = window.prompt('交活要留证据（文件 / commit / 链接 / 验收口径），空口说不算完：', t.evidence || '');
      if (ev === null) return;
      body.evidence = ev;
    }
    if (needWhy) {
      var why = window.prompt('状态倒退要写原因（为什么从 ' + t.status + ' 退回 ' + to + '）：', '');
      if (!why) { say('不写原因就不许倒退', 'err'); return; }
      body.why = why;
    }
    if (to === 'blocked') {
      var wk = window.prompt('卡在哪儿？（写一句，别人好接手）', '');
      if (wk === null) return;
      body.note = wk;
    }
    api('/' + encodeURIComponent(t.id) + '/update', 'POST', body).then(function (r) {
      if (r.conflict) { say(r.error, 'err'); load(true); return; }
      if (!r.ok) { say(r.error || '推进没成', 'err'); return; }
      say(t.id + ' → ' + r.task.status + '（第 ' + r.task.rev + ' 版）', 'ok');
      load(true);
    });
  }

  function note(t) {
    var by = me(); if (!by) return;
    var txt = window.prompt('给 ' + t.id + ' 记一笔（不动状态，只留痕）：', '');
    if (!txt) return;
    api('/' + encodeURIComponent(t.id) + '/update', 'POST', { by: by, baseRev: t.rev, note: txt }).then(function (r) {
      if (!r.ok) { say(r.error || '记不上', 'err'); return; }
      say('已记在 ' + t.id + ' 第 ' + r.task.rev + ' 版', 'ok'); load(true);
    });
  }

  function create() {
    var title = $('n-title').value.trim();
    var shard = $('n-shard').value.trim();
    if (!title) { say('标题空着建不了账', 'err'); return; }
    if (!shard) { say('地盘（shard）空着建不了账 —— 不知道动哪块，撞车就没法判', 'err'); return; }
    api('', 'POST', {
      title: title, shard: shard,
      owner: $('n-owner').value.trim() || me() || 'unassigned',
      intent: $('n-intent').value.trim(),
      dedupeKey: $('n-dedupe').value.trim(),
      by: $('n-owner').value.trim() || 'web',
    }).then(function (r) {
      if (!r.ok) { say(r.error || '建账失败', 'err'); return; }
      if (r.duplicated) { say('幂等号已存在 → 没重复建账，直接续用 ' + r.task.id + '（' + r.task.status + '）', 'warn'); }
      else { say('已建账 ' + r.task.id, 'ok'); }
      ['n-title', 'n-intent', 'n-dedupe'].forEach(function (i) { $(i).value = ''; });
      load(true);
    });
  }

  // ── 拉取 ──
  function load(force) {
    var qs = '?limit=300';
    if ($('f-status').value) qs += '&status=' + encodeURIComponent($('f-status').value);
    if ($('f-owner').value.trim()) qs += '&owner=' + encodeURIComponent($('f-owner').value.trim());
    if ($('f-shard').value.trim()) qs += '&shard=' + encodeURIComponent($('f-shard').value.trim());
    Promise.all([api(qs), api('/board')]).then(function (rs) {
      var list = rs[0], board = rs[1];
      if (!list.ok) { say(list.error || '读账失败', 'err'); return; }
      cache = list.tasks || [];
      if (!force && board.globalRev === lastRev) return;
      lastRev = board.globalRev;
      $('grev').textContent = board.globalRev;
      renderStats(board); renderAlerts(board); renderRows(cache);
    });
  }

  $('n-create').addEventListener('click', create);
  $('f-refresh').addEventListener('click', function () { load(true); });
  ['f-status'].forEach(function (i) { $(i).addEventListener('change', function () { load(true); }); });
  ['f-owner', 'f-shard'].forEach(function (i) {
    $(i).addEventListener('keydown', function (e) { if (e.key === 'Enter') load(true); });
  });
  if (!$('me').value) { $('me').value = window.localStorage.getItem('tb_me') || ''; }
  $('me').addEventListener('change', function () { window.localStorage.setItem('tb_me', $('me').value.trim()); });

  load(true);
  setInterval(function () { load(false); }, FLUSH_MS);
})();
