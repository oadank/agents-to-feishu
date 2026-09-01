/* 独立 React(pReact) 注入配置页 —— 迁移自 Vue 版，接口 /api/injection */
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
    const [enabled, setEnabled] = useState(true);
    const [global, setGlobal] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(null);   // true | false | null
    const [err, setErr] = useState(null);

    useEffect(function () {
      let dead = false;
      (async function () {
        const r = await api("/api/injection");
        if (!dead) {
          if (r.httpOk) { setEnabled(r.data.enabled !== false); setGlobal(r.data.global || ""); setErr(null); }
          else { setErr("加载失败: " + (r.data?.error || "")); }
          setLoading(false);
        }
      })();
      return function () { dead = true; };
    }, []);

    async function save() {
      setSaving(true); setErr(null);
      const r = await api("/api/injection", "PUT", { enabled, global });
      setSaving(false);
      if (r.ok) { setEnabled(r.data.enabled !== false); setGlobal(r.data.global || ""); setSaved(true); }
      else { setErr(r.data?.error || "保存失败"); setSaved(false); }
    }

    if (loading) {
      return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载注入配置…")));
    }

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " 💉 注入配置",
      ),
      err ? h("div", { class: "card" }, h("div", { class: "err" }, err)) : null,
      saved ? h("div", { class: "card" }, h("div", { class: "ok" }, "✅ 统一注入已保存（agent 重新 apply 后新会话生效）")) : null,

      h("div", { class: "card" },
        h("div", { class: "row" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" } },
            h("span", { class: "dim" }, "启用统一注入"),
            h(Switch, { checked: enabled, onChange: () => { setEnabled(!enabled); setSaved(null); } }),
          ),
        ),
        h("div", { class: "dim", style: { marginTop: 6, marginBottom: 6 } }, "统一注入：所有 agent 首条消息注入的全局 systemPrompt（config-store.json 唯一真相源；独立注入在各 Agent 编辑里）"),
        h("textarea", { rows: 22, value: global, onInput: (e) => { setGlobal(e.target.value); setSaved(null); }, placeholder: "在这里写统一注入全文（Markdown）…" }),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存注入"),
          h("span", { class: "dim" }, "已 " + global.length + " 字符"),
        ),
      ),

      h("div", { class: "tip" },
        "提示：统一注入会在 agent 下次 apply（应用/重启）后随新会话生效。若要立即生效，去「Agent 分配置」对目标 agent 点「应用」。",
      ),
    );
  }

  render(h(App, null), document.getElementById("root"));
})();