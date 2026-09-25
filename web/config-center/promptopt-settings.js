/* 独立 React(pReact) 配置页：一页两部分 —— ① ⚡ 提示词优化(/p) ② 副驾回复预选(/de)。
   两块各自一套模型，全部走本仓引擎，不依赖 dsh。接口 /api/prompt-optimize 与 /api/de/test。
   写法纪律：一律先攒进数组再渲染，不写多层嵌套三元（上一版就是那样丢括号，整页白屏）。 */
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
  function Switch(props) {
    return h("label", { class: "switch" },
      h("input", { type: "checkbox", checked: !!props.checked, onChange: props.onChange }),
      h("span", { class: "slider" }));
  }

  /* 一套模型配置：地址 / 密钥 / 模型（可拉列表挑）/ 温度 / 上限 / 思考开关 */
  function LlmForm(props) {
    var llm = props.llm || {};
    var st1 = useState(null), models = st1[0], setModels = st1[1];
    var st2 = useState(false), listing = st2[0], setListing = st2[1];
    var st3 = useState(""), lerr = st3[0], setLerr = st3[1];
    function set(k, v) { var o = {}; o[k] = v; props.onChange(Object.assign({}, llm, o)); }
    function pull() {
      setListing(true); setLerr(""); setModels(null);
      api("/api/llm-models", "POST", { baseUrl: llm.baseUrl, apiKey: llm.apiKey }).then(function (r) {
        setListing(false);
        if (r.data && r.data.ok) {
          var ms = r.data.models || [];
          setModels(ms);
          if (!ms.length) setLerr("这个 key 底下列表为空");
        } else {
          setLerr((r.data && r.data.error) || "拉取失败");
        }
      });
    }
    var kids = [];
    kids.push(h("label", { class: "field" }, "接口地址 (OpenAI 兼容)",
      h("input", { type: "text", value: llm.baseUrl || "", placeholder: "https://api.deepseek.com/v1", onInput: function (e) { set("baseUrl", e.target.value); } })));
    kids.push(h("label", { class: "field" }, "API Key",
      h("input", { type: "password", value: llm.apiKey || "", placeholder: "sk-…", onInput: function (e) { set("apiKey", e.target.value); } })));
    var modelBox = [];
    modelBox.push(h("div", { style: { display: "flex", gap: 6 } },
      h("input", { type: "text", value: llm.model || "", placeholder: "deepseek-chat", style: { flex: 1 }, onInput: function (e) { set("model", e.target.value); } }),
      h("button", { class: "btn", type: "button", onClick: pull, disabled: listing }, listing ? "拉取中…" : "拉列表")));
    if (models) {
      var opts = [h("option", { key: "_", value: "" }, "选择模型（共 " + models.length + " 个）")];
      models.forEach(function (m) { opts.push(h("option", { key: m, value: m }, m)); });
      modelBox.push(h("select", { style: { marginTop: 4, width: "100%" }, value: "", onChange: function (e) { if (e.target.value) set("model", e.target.value); } }, opts));
    }
    if (lerr) modelBox.push(h("span", { class: "err" }, lerr));
    kids.push(h("label", { class: "field" }, "模型（可手填，也可拉列表挑）", modelBox));
    kids.push(h("label", { class: "field", style: { maxWidth: 90 } }, "温度",
      h("input", { type: "number", step: "0.05", min: "0", max: "2", value: llm.temperature === undefined ? "" : llm.temperature, onInput: function (e) { set("temperature", e.target.value === "" ? undefined : num(e.target.value, 0.7)); } })));
    kids.push(h("label", { class: "field", style: { maxWidth: 110 } }, "最大 token",
      h("input", { type: "number", step: "50", min: "50", max: "8000", value: llm.maxTokens === undefined ? "" : llm.maxTokens, onInput: function (e) { set("maxTokens", e.target.value === "" ? undefined : num(e.target.value, 900)); } })));
    kids.push(h("label", { class: "field", style: { maxWidth: 140 } }, "深度思考",
      h("select", { value: llm.thinking || "default", onChange: function (e) { set("thinking", e.target.value); } },
        h("option", { value: "default" }, "跟着模型"),
        h("option", { value: "disabled" }, "关闭（快，实测 3.0s→0.8s）")),
      h("span", { class: "dim" }, "仅对 DeepSeek 生效")));
    return h("div", { class: "row" }, kids);
  }

  function App() {
    var s1 = useState(null), po = s1[0], setPo = s1[1];
    var s2 = useState(null), de = s2[0], setDe = s2[1];
    var s3 = useState(true), loading = s3[0], setLoading = s3[1];
    var s4 = useState(false), saving = s4[0], setSaving = s4[1];
    var s5 = useState(null), saved = s5[0], setSaved = s5[1];
    var s6 = useState(""), err = s6[0], setErr = s6[1];
    var s7 = useState(""), testText = s7[0], setTestText = s7[1];
    var s8 = useState(""), optimized = s8[0], setOptimized = s8[1];
    var s9 = useState(false), testing = s9[0], setTesting = s9[1];
    var s10 = useState("我: 那个截断的问题修好了吗\n助手: 改了 max_tokens，重启排好了\n"), deIn = s10[0], setDeIn = s10[1];
    var s11 = useState(null), deRun = s11[0], setDeRun = s11[1];
    var s12 = useState(false), deTesting = s12[0], setDeTesting = s12[1];

    useEffect(function () {
      var dead = false;
      api("/api/prompt-optimize").then(function (r) {
        if (dead) return;
        if (r.httpOk) { setPo(r.data.promptOptimize); setDe(r.data.de); setErr(""); }
        else { setErr("加载失败: " + ((r.data && r.data.error) || "")); }
        setLoading(false);
      });
      return function () { dead = true; };
    }, []);

    function save() {
      setSaving(true); setErr(""); setSaved(null);
      api("/api/prompt-optimize", "PUT", {
        enabled: po.enabled, engine: po.engine, endpoint: po.endpoint, prefixes: po.prefixes,
        tierA: po.tierA, tierB: po.tierB, llm: po.llm, de: de,
      }).then(function (r) {
        setSaving(false);
        if (r.ok) { setPo(r.data.promptOptimize); setDe(r.data.de); setSaved(true); }
        else { setErr((r.data && r.data.error) || "保存失败"); setSaved(false); }
      });
    }
    function runP() {
      if (!testText.trim()) { setErr("先在 /p 试写区里写点东西"); return; }
      setTesting(true); setOptimized(""); setErr("");
      api("/api/prompt-optimize/test", "POST", { text: testText }).then(function (r) {
        setTesting(false);
        if (r.data && r.data.ok) setOptimized(r.data.optimized || "");
        else setErr("优化失败：" + ((r.data && r.data.error) || ""));
      });
    }
    function parseTurns(s) {
      var out = [];
      s.split(/\r?\n/).forEach(function (raw) {
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
      if (!turns.length) { setErr("先在 /de 试跑区写几行对话（我: … / 助手: …）"); return; }
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
    var titleKids = [];
    if (!inIframe) titleKids.push(h("button", { key: "back", class: "btn", style: { fontSize: 12 }, onClick: function () { location.href = "./"; } }, "←"));
    titleKids.push(" ⚡ 提示词优化 与 副驾回复预选");
    top.push(h("h1", null, titleKids));
    if (err) top.push(h("div", { class: "card", key: "e" }, h("div", { class: "err" }, err)));
    if (saved) top.push(h("div", { class: "card", key: "s" }, h("div", { class: "ok" }, "✅ 已保存（bot 5 秒内自动生效，不用重启）")));
    top.push(h("div", { class: "card", key: "n" }, h("div", { class: "dim" },
      "这两块都跑在 agents-to-feishu 自己身上，模型各配各的，不依赖 dsh（dsh 挂了这里照样能用）。填完点最下面的保存。")));

    /* ── 第一部分 /p ── */
    var p1 = [];
    p1.push(h("h2", { style: { margin: "0 0 8px", fontSize: 15 } }, "第一部分 · 用户提示词优化（/p）"));
    p1.push(h("div", { class: "row" },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" } },
        h("span", { class: "dim" }, "启用"),
        h(Switch, { checked: po.enabled, onChange: function () { setPo(Object.assign({}, po, { enabled: !po.enabled })); } })),
      h("span", { class: "dim" }, po.enabled ? "开着：飞书里命中前缀就先精炼再干活" : "关着：前缀原样发给 agent")));
    var rowEng = [];
    rowEng.push(h("label", { class: "field", key: "pre" }, "触发前缀（逗号分隔）",
      h("input", { type: "text", value: po.prefixes || "", onInput: function (e) { setPo(Object.assign({}, po, { prefixes: e.target.value })); } })));
    rowEng.push(h("label", { class: "field", key: "eng" }, "引擎",
      h("select", { value: po.engine || "local", onChange: function (e) { setPo(Object.assign({}, po, { engine: e.target.value })); } },
        h("option", { value: "local" }, "本仓引擎（不依赖 dsh）"),
        h("option", { value: "endpoint" }, "外部端点（高级/兼容旧配置）"))));
    if (po.engine === "endpoint") {
      rowEng.push(h("label", { class: "field", key: "ep" }, "外部端点地址",
        h("input", { type: "text", value: po.endpoint || "", placeholder: "http://127.0.0.1:3080/optimize-prompt", onInput: function (e) { setPo(Object.assign({}, po, { endpoint: e.target.value })); } })));
    }
    p1.push(h("div", { class: "row" }, rowEng));
    p1.push(h("div", { class: "row" },
      h("label", { class: "dim" },
        h("input", { type: "checkbox", checked: po.tierA !== false, onChange: function () { setPo(Object.assign({}, po, { tierA: !(po.tierA !== false) })); } }),
        " 沟通/指令类充分精炼"),
      h("label", { class: "dim" },
        h("input", { type: "checkbox", checked: po.tierB !== false, onChange: function () { setPo(Object.assign({}, po, { tierB: !(po.tierB !== false) })); } }),
        " 内容产出类充分精炼")));
    p1.push(h("div", { class: "dim", style: { margin: "4px 0" } }, "↓ /p 用的模型"));
    p1.push(h(LlmForm, { llm: po.llm, onChange: function (llm) { setPo(Object.assign({}, po, { llm: llm })); } }));
    p1.push(h("div", { class: "row" },
      h("button", { class: "btn primary", onClick: runP, disabled: testing }, testing ? "精炼中…（最长 60 秒）" : "试一下"),
      h("span", { class: "dim" }, "试一下只跑本引擎，不发消息")));
    p1.push(h("textarea", { rows: 3, value: testText, placeholder: "例：帮我看看这个表格，把重复的行删掉，然后按时间排序", onInput: function (e) { setTestText(e.target.value); setOptimized(""); } }));
    if (optimized) {
      p1.push(h("div", null,
        h("div", { class: "dim", style: { marginTop: 8 } }, "精炼后："),
        h("div", { class: "out" }, optimized)));
    }
    top.push(h("div", { class: "card", key: "p1" }, p1));

    /* ── 第二部分 /de ── */
    var p2 = [];
    p2.push(h("h2", { style: { margin: "0 0 8px", fontSize: 15 } }, "第二部分 · 自动出 3 条「用户回给 AI」的候选（/de）"));
    p2.push(h("div", { class: "dim", style: { marginBottom: 6 } },
      "你在飞书发 /de：机器人读这个会话最近若干条 → 判断你此刻的局面 → 写 3 条可直接发给对面 AI 的话 → 出一张三选一卡片。点哪条，就用你的身份把那句话原文发回本会话（不加水印）。"));
    p2.push(h("div", { class: "row" },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" } },
        h("span", { class: "dim" }, "启用 /de"),
        h(Switch, { checked: de.enabled, onChange: function () { setDe(Object.assign({}, de, { enabled: !de.enabled })); } })),
      h("label", { class: "field", style: { maxWidth: 110 } }, "触发词",
        h("input", { type: "text", value: de.command || "/de", onInput: function (e) { setDe(Object.assign({}, de, { command: e.target.value })); } })),
      h("label", { class: "field", style: { maxWidth: 130 } }, "读最近几条",
        h("input", { type: "number", min: "4", max: "60", value: de.historyTurns, onInput: function (e) { setDe(Object.assign({}, de, { historyTurns: num(e.target.value, 15) })); } }),
        h("span", { class: "dim" }, "建议 10~15，太多费 token")),
      h("label", { class: "dim" },
        h("input", { type: "checkbox", checked: de.blockRiskySend !== false, onChange: function () { setDe(Object.assign({}, de, { blockRiskySend: !(de.blockRiskySend !== false) })); } }),
        " 高风险不许一键直发")));
    var rowMem = [];
    rowMem.push(h("label", { class: "dim", key: "cb" },
      h("input", { type: "checkbox", checked: !!de.useOpenmem, onChange: function () { setDe(Object.assign({}, de, { useOpenmem: !de.useOpenmem })); } }),
      " 顺带读 openmem 画像/记忆（可选增强，不是 dsh）"));
    if (de.useOpenmem) {
      rowMem.push(h("label", { class: "field", key: "url" }, "openmem 地址",
        h("input", { type: "text", value: de.openmemUrl || "", onInput: function (e) { setDe(Object.assign({}, de, { openmemUrl: e.target.value })); } })));
    }
    p2.push(h("div", { class: "row" }, rowMem));
    p2.push(h("div", { class: "dim", style: { margin: "4px 0" } }, "↓ /de 起草三条候选用的模型（要写得像你说话）"));
    p2.push(h(LlmForm, { llm: de.draft, onChange: function (draft) { setDe(Object.assign({}, de, { draft: draft })); } }));
    p2.push(h("div", { class: "dim", style: { margin: "4px 0" } }, "↓ 判断局面与排序用的模型（地址留空 = 复用上面那个；想省钱可填个便宜快的）"));
    p2.push(h(LlmForm, { llm: de.judge, onChange: function (judge) { setDe(Object.assign({}, de, { judge: judge })); } }));
    p2.push(h("div", { class: "row" },
      h("button", { class: "btn primary", onClick: runDe, disabled: deTesting }, deTesting ? "试跑中…（最多 45 秒）" : "试跑 /de"),
      h("span", { class: "dim" }, "试跑用下面这几行假对话，不发消息、不进会话")));
    p2.push(h("textarea", { rows: 4, value: deIn, onInput: function (e) { setDeIn(e.target.value); setDeRun(null); } }));
    if (deRun) {
      p2.push(h("div", { class: "dim", style: { marginTop: 8 } },
        "判断：" + JSON.stringify(deRun.judge) + " ｜ " + deRun.context.note));
      deRun.candidates.forEach(function (c, i) {
        var tag = c.role ? "[" + c.role + "] " : "第" + (i + 1) + "条 ";
        p2.push(h("div", { class: "out", key: "c" + i, style: { marginTop: 6 } },
          tag + "拟用 " + Math.round((c.p || 0) * 100) + "% — " + c.text));
      });
      if (deRun.degraded && (deRun.degraded.judge || deRun.degraded.rank)) {
        p2.push(h("div", { class: "dim", style: { marginTop: 4 } }, "注：判断或排序这次没成，已按降级出稿"));
      }
    }
    top.push(h("div", { class: "card", key: "p2" }, p2));

    top.push(h("div", { class: "card", key: "save" }, h("div", { class: "row" },
      h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存全部"),
      h("span", { class: "dim" }, "保存即生效（bot 侧 5 秒缓存轮询），不用重启"))));
    top.push(h("div", { class: "tip", key: "tip" },
      "配置落盘：config-store.json 的 promptOptimize 与 de 两段；改完点「保存全部」，bot 5 秒内读到新值，不用重启。",
      h("br"),
      "密钥只存在本机这个文件里，页面用密码框显示，不会回传到任何远端。"));

    return h("div", { class: "wrap" }, top);
  }

  render(h(App, null), document.getElementById("root"));
})();
