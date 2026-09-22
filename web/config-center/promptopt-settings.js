/* 独立 React(pReact) 提示词优化配置页 —— 内建 ⚡ 能力（勾选即用），接口 /api/prompt-optimize */
(function () {
  "use strict";
  const { h, render } = preact;
  const { useState, useEffect } = preactHooks;
  const inIframe = (function () { try { return window.self !== window.top; } catch { return true; } })();

  async function api(url, method, body) {
    const opt = { method: method || "GET" };
    if (body !== undefined) { opt.headers = { "content-type": "application/json" }; opt.body = JSON.stringify(body); }
    try {
      const r = await fetch(url, opt);
      let d = {}; try { d = await r.json(); } catch {}
      return { httpOk: r.ok, ok: r.ok && d.ok !== false, data: d };
    } catch (e) { return { httpOk: false, ok: false, data: { error: String(e) } }; }
  }
  function Switch(props) {
    return h("label", { class: "switch", title: props.title || "" },
      h("input", { type: "checkbox", checked: !!props.checked, onChange: props.onChange }),
      h("span", { class: "slider" }),
    );
  }

  function App() {
    const [enabled, setEnabled] = useState(false);
    const [endpoint, setEndpoint] = useState("");
    const [prefixes, setPrefixes] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(null);      // true | false | null
    const [err, setErr] = useState(null);
    const [testText, setTestText] = useState("");
    const [testing, setTesting] = useState(false);
    const [optimized, setOptimized] = useState(null);
    const [testErr, setTestErr] = useState(null);

    useEffect(function () {
      let dead = false;
      (async function () {
        const r = await api("/api/prompt-optimize");
        if (!dead) {
          if (r.httpOk) {
            const c = r.data.promptOptimize || {};
            setEnabled(c.enabled === true);
            setEndpoint(c.endpoint || "");
            setPrefixes(c.prefixes || "");
            setErr(null);
          } else { setErr("加载失败: " + (r.data && r.data.error || "")); }
          setLoading(false);
        }
      })();
      return function () { dead = true; };
    }, []);

    async function save() {
      setSaving(true); setErr(null);
      const r = await api("/api/prompt-optimize", "PUT", { enabled, endpoint, prefixes });
      setSaving(false);
      if (r.ok) {
        const c = r.data.promptOptimize || {};
        setEnabled(c.enabled === true); setEndpoint(c.endpoint || ""); setPrefixes(c.prefixes || "");
        setSaved(true);
      } else { setErr((r.data && r.data.error) || "保存失败"); setSaved(false); }
    }

    async function runTest() {
      const text = testText.trim();
      if (!text) { setTestErr("先在下面写点东西再试"); return; }
      setTesting(true); setTestErr(null); setOptimized(null);
      const r = await api("/api/prompt-optimize/test", "POST", { text });
      setTesting(false);
      if (r.data && r.data.ok && r.data.optimized) { setOptimized(r.data.optimized); }
      else { setTestErr((r.data && r.data.error) || "优化失败"); }
    }

    if (loading) {
      return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载提示词优化配置…")));
    }

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " ⚡ 提示词优化",
      ),
      err ? h("div", { class: "card" }, h("div", { class: "err" }, err)) : null,
      saved ? h("div", { class: "card" }, h("div", { class: "ok" }, "✅ 已保存（bot 5 秒内自动生效，不用重启）")) : null,

      h("div", { class: "card" },
        h("div", { class: "row" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" } },
            h("span", { class: "dim" }, "启用提示词优化"),
            h(Switch, { checked: enabled, onChange: () => { setEnabled(!enabled); setSaved(null); } }),
          ),
          h("span", { class: "dim" }, enabled ? "已开启：飞书里按下面的前缀发消息即触发" : "已关闭：前缀原样发给 agent，不做优化"),
        ),
        h("div", { class: "row" },
          h("label", { class: "field" }, "触发前缀（多个用逗号分隔）",
            h("input", {
              type: "text", value: prefixes, placeholder: "/p,优化：,优化:",
              onInput: (e) => { setPrefixes(e.target.value); setSaved(null); },
            }),
          ),
          h("label", { class: "field" }, "优化服务地址",
            h("input", {
              type: "text", value: endpoint, placeholder: "http://127.0.0.1:3080/optimize-prompt",
              onInput: (e) => { setEndpoint(e.target.value); setSaved(null); },
            }),
          ),
        ),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存"),
          h("span", { class: "dim" }, "改完点保存即可，不需要重启任何 bot"),
        ),
      ),

      h("div", { class: "card" },
        h("div", { class: "dim", style: { marginBottom: 6 } }, "试一下：写一段话，看看会被润色成什么样（不经过飞书，直接调优化服务）"),
        h("textarea", {
          rows: 4, value: testText,
          placeholder: "例：帮我看看这个表格，把重复的行删掉，然后按时间排序",
          onInput: (e) => { setTestText(e.target.value); setTestErr(null); setOptimized(null); },
        }),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onClick: runTest, disabled: testing }, testing ? "优化中…（最长 60 秒）" : "试一下"),
          h("span", { class: "dim" }, "优化过程会先读 openmem 里对你的了解，再改写"),
        ),
        testErr ? h("div", { class: "err", style: { marginTop: 8 } }, "失败：" + testErr) : null,
        optimized ? h("div", null,
          h("div", { class: "dim", style: { marginTop: 10 } }, "优化后："),
          h("div", { class: "out" }, optimized),
        ) : null,
      ),

      h("div", { class: "tip" },
        "怎么用：在飞书里给 bot 发「" + (prefixes.split(",")[0] || "/p").trim() + " 你的原话」，bot 会先回一条「⚡ 优化后提示词」，再按优化后的内容干活。",
        h("br"),
        "判定说明：骂人话、操作指令、闲聊这类本来就不需要润色的内容，会原样返回、一个字不改。",
      ),
    );
  }

  render(h(App, null), document.getElementById("root"));
})();
