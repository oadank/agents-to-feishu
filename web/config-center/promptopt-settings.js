/* 独立 React(pReact) 配置页：一页两部分 —— ① 用户提示词优化(/p) ② 副驾回复预选(/de)。
 *
 * [2026-09-25 老大定稿] 界面上只留必须项：
 *  · 模型 = 两个下拉（服务商 + 模型），地址与密钥由后端从「总配置 + 凭证层」解析，用户一个字段都不用填；
 *  · 温度 / 最大长度 / 深度思考 **不在页面出现**：这些参数在代码里配死（默认关思考求快），
 *    摆出来只会碍事（老大原话：要那玩意干鸡毛）。想调的人改 config-store.json 就行，字段还在。
 * 写法纪律：先攒数组再渲染，不写多层嵌套三元（前两版那样丢过括号，整页白屏）。
 */
(function () {
  "use strict";
  var h = preact.h, render = preact.render;
  var useState = preactHooks.useState, useEffect = preactHooks.useEffect;
  var inIframe = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();

  function api(url, method, body) {
    var opt = { method: method || "GET" };
    if (body !== undefined) { opt.headers = { "content-type": "application/json" }; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { httpOk: r.ok, ok: r.ok && d.ok !== false, data: d };
      });
    }).catch(function (e) { return { httpOk: false, ok: false, data: { error: String(e) } }; });
  }
  function num(v, dft) { var n = Number(v); return v !== "" && Number.isFinite(n) ? n : dft; }
  function pick(arr, id) { return (arr || []).filter(function (x) { return x.id === id; })[0] || null; }
  function Switch(props) {
    return h("label", { class: "switch" },
      h("input", { type: "checkbox", checked: !!props.checked, onChange: props.onChange }),
      h("span", { class: "slider" }));
  }

  /** 一套模型 = 服务商 + 模型两个下拉，外加一行只读的「现在用什么」 */
  function ModelPick(props) {
    var v = props.value || {};
    var provs = (props.catalog || {}).providers || [];
    var cur = pick(provs, v.providerId);
    var models = cur ? cur.models : [];
    var chosen = cur ? pick(models, v.modelId) : null;
    var eff;
    if (cur && !cur.hasKey) {
      eff = "选的这套缺密钥（" + cur.keyEnv + "）—— 去「总配置」填一次 key，这里不用填";
    } else if (cur) {
      eff = "现在用：" + cur.displayName + " · " + (chosen ? chosen.label : "还没挑模型") + "（地址和密钥自动带出）";
    } else {
      eff = "还没选模型：上面挑一个就行";
    }
    function patch(o) { props.onChange(Object.assign({}, v, o)); }
    return h("div", { class: "row" },
      h("label", { class: "field" }, "服务商",
        h("select", {
          value: v.providerId || "",
          onChange: function (e) {
            var p = pick(provs, e.target.value);
            patch({ providerId: e.target.value, modelId: p && p.models.length ? p.models[0].id : "" });
          },
        },
          h("option", { value: "" }, "— 选一个 —"),
          provs.map(function (p) {
            return h("option", { key: p.id, value: p.id }, p.displayName + "（" + p.models.length + " 个" + (p.hasKey ? "" : "，缺密钥") + "）");
          }))),
      h("label", { class: "field" }, "模型",
        h("select", {
          value: v.modelId || "", disabled: !cur,
          onChange: function (e) { patch({ modelId: e.target.value }); },
        },
          models.length === 0 ? h("option", { value: "" }, "— 先选服务商 —") : null,
          models.map(function (m) { return h("option", { key: m.id, value: m.id }, m.label); }))),
      h("div", { class: "kbd" }, eff));
  }

  var DECISION_HINT = {
    aliyun: '阿里云百炼 decision-model-preview · 本机网关透传 · 实测几十毫秒（默认）',
    bocha: '博查 bocha-jev-v1 · 限时免费 · 需自备 key',
    vercel: 'Vercel typesafe-ai/jev · 本机未实测',
    opencode: 'OpenCode Zen jev-1.13 · 付费 · 需 key',
  };

  /** 决策模型（判断局面那一环）：一个下拉 + 一个开关。地址/模型名跟着选项走，密钥从「总配置」凭证层取，全不用填 */
  function DecisionPick(props) {
    var v = props.value || {};
    var ids = ["aliyun", "bocha", "vercel", "opencode"];
    return h("div", { class: "row" },
      h("label", { class: "field" }, "决策模型（只回概率/选项，不生成文本，几十毫秒）",
        h("select", {
          value: v.preset || "aliyun",
          onChange: function (e) { props.onChange(Object.assign({}, v, { preset: e.target.value })); },
        }, ids.map(function (x) { return h("option", { key: x, value: x }, DECISION_HINT[x]); }))),
      h("label", { class: "cb" },
        h("input", { type: "checkbox", checked: props.on !== false, onChange: props.onToggle }),
        "判断局面用它（不勾=用下面那套聊天模型判断）"));
  }

  function App() {
    var stPo = useState(null), po = stPo[0], setPo = stPo[1];
    var stDe = useState(null), de = stDe[0], setDe = stDe[1];
    var stLoad = useState(true), loading = stLoad[0], setLoading = stLoad[1];
    var stSave = useState(false), saving = stSave[0], setSaving = stSave[1];
    var stOk = useState(false), saved = stOk[0], setSaved = stOk[1];
    var stCat = useState({ providers: [], agents: [] }), cat = stCat[0], setCat = stCat[1];
    var stErr = useState(""), err = stErr[0], setErr = stErr[1];
    var stTP = useState(false), testing = stTP[0], setTesting = stTP[1];
    var stTxt = useState(""), testText = stTxt[0], setTestText = stTxt[1];
    var stOpt = useState(""), optimized = stOpt[0], setOptimized = stOpt[1];
    var stTD = useState(false), deTesting = stTD[0], setDeTesting = stTD[1];
    var stRun = useState(null), deRun = stRun[0], setDeRun = stRun[1];
    var stDeIn = useState("我: 走完没，把结果贴出来\n助手: 引擎跑通了，还差页面排版和真机点卡片\n"), deIn = stDeIn[0], setDeIn = stDeIn[1];

    useEffect(function () {
      var dead = false;
      Promise.all([api("/api/prompt-optimize"), api("/api/model-catalog")]).then(function (rs) {
        if (dead) return;
        if (rs[0].httpOk) { setPo(rs[0].data.promptOptimize); setDe(rs[0].data.de); }
        else setErr("配置加载失败: " + ((rs[0].data && rs[0].data.error) || ""));
        if (rs[1].httpOk) setCat(rs[1].data);
        setLoading(false);
      });
      return function () { dead = true; };
    }, []);

    function save() {
      setSaving(true); setErr(""); setSaved(false);
      api("/api/prompt-optimize", "PUT", {
        enabled: po.enabled, prefixes: po.prefixes, llm: po.llm,
        de: { enabled: de.enabled, command: de.command, historyTurns: de.historyTurns, judgeEngine: de.judgeEngine || "decision", decision: de.decision || { preset: "aliyun", providerId: "litellm", url: "", model: "", apiKey: "" }, blockRiskySend: de.blockRiskySend, draft: de.draft, judge: de.judge },
      }).then(function (r) {
        setSaving(false);
        if (r.ok) { setPo(r.data.promptOptimize); setDe(r.data.de); setSaved(true); }
        else { setErr((r.data && r.data.error) || "保存失败"); }
      });
    }
    function runP() {
      if (!testText.trim()) { setErr("先在下面写点东西再试"); return; }
      setTesting(true); setOptimized(""); setErr("");
      api("/api/prompt-optimize/test", "POST", { text: testText }).then(function (r) {
        setTesting(false);
        if (r.data && r.data.ok) setOptimized(r.data.optimized || "");
        else setErr("精炼失败：" + ((r.data && r.data.error) || ""));
      });
    }
    function parseTurns(txt) {
      var out = [];
      txt.split(/\r?\n/).forEach(function (raw) {
        var l = raw.trim();
        if (!l) return;
        var m = /^(我|用户|user)\s*[:：]\s*([\s\S]*)$/i.exec(l);
        if (m) { out.push({ role: "user", text: m[2] }); return; }
        var a = /^(助手|ai|assistant)\s*[:：]\s*([\s\S]*)$/i.exec(l);
        if (a) { out.push({ role: "assistant", text: a[2] }); return; }
        out.push({ role: "user", text: l });
      });
      return out;
    }
    function runDe() {
      var turns = parseTurns(deIn);
      if (!turns.length) { setErr("先写几行对话（我: … / 助手: …）再试跑"); return; }
      setDeTesting(true); setDeRun(null); setErr("");
      api("/api/de/test", "POST", { turns: turns }).then(function (r) {
        setDeTesting(false);
        if (r.data && r.data.ok) setDeRun(r.data);
        else setErr("/de 试跑失败：" + ((r.data && r.data.error) || ""));
      });
    }

    if (loading) return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载配置…")));
    if (!po || !de) return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "err" }, err || "配置读不到")));

    var top = [];
    var title = [];
    if (!inIframe) title.push(h("button", { key: "back", class: "btn", style: { fontSize: "12px" }, onClick: function () { location.href = "./"; } }, "←"));
    title.push(" ⚡ 提示词优化 · 副驾回复预选");
    top.push(h("h1", null, title));
    if (err) top.push(h("div", { class: "card", key: "e" }, h("div", { class: "err" }, err)));
    if (saved) top.push(h("div", { class: "card", key: "s" }, h("div", { class: "ok" }, "✅ 已保存（5 秒内自动生效，不用重启）")));

    /* ── 第一部分：/p ── */
    var p1 = [];
    p1.push(h("h2", null, "第一部分 · 用户提示词优化（/p）"));
    p1.push(h("div", { class: "dim" }, "消息以触发前缀开头 → 先把话精炼清楚，再交给 bot 干活。"));
    p1.push(h("div", { class: "row" },
      h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
        h("span", { class: "dim" }, "启用"),
        h(Switch, { checked: po.enabled, onChange: function () { setPo(Object.assign({}, po, { enabled: !po.enabled })); } })),
      h("label", { class: "field" }, "触发前缀（逗号分隔）",
        h("input", { type: "text", value: po.prefixes || "", onInput: function (e) { setPo(Object.assign({}, po, { prefixes: e.target.value })); } }))),
      h("div", { class: "dim" }, po.enabled ? "开着：命中前缀就先精炼" : "关着：原样发给 bot"));
    p1.push(h(ModelPick, { value: po.llm, catalog: cat, onChange: function (llm) { setPo(Object.assign({}, po, { llm: llm })); } }));
    p1.push(h("div", { class: "row" },
      h("button", { class: "btn primary", onClick: runP, disabled: testing }, testing ? "精炼中…" : "试一下"),
      h("span", { class: "dim" }, "只跑本引擎，不发消息")));
    p1.push(h("textarea", { rows: 2, value: testText, placeholder: "例：那个表格你看下，把重的删掉再排一下", onInput: function (e) { setTestText(e.target.value); setOptimized(""); } }));
    if (optimized) p1.push(h("div", { class: "out" }, optimized));
    top.push(h("div", { class: "card", key: "p1" }, p1));

    /* ── 第二部分：/de ── */
    var p2 = [];
    p2.push(h("h2", null, "第二部分 · 自动出 3 条「我回给 AI」的候选（/de）"));
    p2.push(h("div", { class: "dim" }, "飞书里发 /de：读本会话最近几条 → 判断局面 → 写 3 条能直接发给对面 AI 的话 → 出一张三选一卡片。点哪条，就用你的身份把那句原文发回本会话，不加水印。"));
    p2.push(h("div", { class: "row" },
      h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
        h("span", { class: "dim" }, "启用"),
        h(Switch, { checked: de.enabled, onChange: function () { setDe(Object.assign({}, de, { enabled: !de.enabled })); } })),
      h("label", { class: "field", style: { flex: "0 1 140px" } }, "触发词",
        h("input", { type: "text", value: de.command || "/de", onInput: function (e) { setDe(Object.assign({}, de, { command: e.target.value })); } })),
      h("label", { class: "field", style: { flex: "0 1 150px" } }, "读最近几条",
        h("input", { type: "number", min: "4", max: "60", value: de.historyTurns, onInput: function (e) { setDe(Object.assign({}, de, { historyTurns: num(e.target.value, 15) })); } })),
      h("label", { class: "cb" },
        h("input", { type: "checkbox", checked: de.blockRiskySend !== false, onChange: function () { setDe(Object.assign({}, de, { blockRiskySend: !(de.blockRiskySend !== false) })); } }),
        "判定为高风险（不可逆）时不许一键直发")));
    p2.push(h(DecisionPick, {
      value: de.decision || {}, on: de.judgeEngine !== "chat",
      onChange: function (d) { setDe(Object.assign({}, de, { decision: d })); },
      onToggle: function () { setDe(Object.assign({}, de, { judgeEngine: de.judgeEngine === "chat" ? "decision" : "chat" })); },
    }));
    p2.push(h(ModelPick, { value: de.draft, catalog: cat, onChange: function (draft) { setDe(Object.assign({}, de, { draft: draft })); } }));
    p2.push(h("div", { class: "dim" }, "上面这套同时负责判断与排序；想让它用另一套更便宜的模型，再挑一次（不挑就复用）。"));
    p2.push(h(ModelPick, { value: de.judge, catalog: cat, onChange: function (judge) { setDe(Object.assign({}, de, { judge: judge })); } }));
    p2.push(h("div", { class: "row" },
      h("button", { class: "btn primary", onClick: runDe, disabled: deTesting }, deTesting ? "试跑中…" : "试跑 /de"),
      h("span", { class: "dim" }, "用下面这几行假对话，不发消息")));
    p2.push(h("textarea", { rows: 3, value: deIn, onInput: function (e) { setDeIn(e.target.value); setDeRun(null); } }));
    if (deRun) {
      p2.push(h("div", { class: "kbd" }, deRun.context.note));
      deRun.candidates.forEach(function (c, i) {
        var tag = c.role ? "[" + c.role + "] " : "第" + (i + 1) + "条 ";
        p2.push(h("div", { class: "out", key: "c" + i }, tag + Math.round((c.p || 0) * 100) + "% — " + c.text));
      });
    }
    top.push(h("div", { class: "card", key: "p2" }, p2));

    top.push(h("div", { class: "card", key: "save" }, h("div", { class: "row" },
      h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存"),
      h("span", { class: "dim" }, "温度、长度、思考这些参数代码里已配好（默认关思考，图快），不摆到页面上碍事。"))));
    top.push(h("div", { class: "tip", key: "tip" },
      "配置存进 config-store.json 的 promptOptimize 与 de 两段；密钥仍在本机凭证文件里，页面只显示有没有取到。",
      h("br"),
      "这两块跑在本项目自己身上：dsh 关机、插件卸载，飞书里的 /p 和 /de 照旧。"));

    return h("div", { class: "wrap" }, top);
  }

  render(h(App, null), document.getElementById("root"));
})();
