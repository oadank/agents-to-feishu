/* 运行时管理页 —— 每个 Agent 真实对接的 CLI 程序/路径 + 检测状态 + 启动参数开关（模板驱动 + 可点开关/输入） */
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

  function RuntimeCard(props) {
    const { rt } = props;

    // 整页只读（2026-09-05 老大定稿）：运行时管理 = 真实配置参观页，一律灰框不可选。
    // 修改入口在别处：模型/Provider 在「Agent 分配置」，密钥在「总配置」，路径探测自动。
    const env = rt.env || {};
    const tpl = rt.envTpl || {};
    const labels = rt.envLabels || {};
    const meta = rt.envMeta || null;
    const keys = meta ? Object.keys(meta) : Object.keys(tpl);
    const val = (k) => (meta && meta[k] ? meta[k].value : (env[k] !== undefined ? env[k] : (tpl[k] || "（自动）")));
    const noteOf = (k) => (meta && meta[k] && meta[k].note) || "";
    const hasParams = keys.length > 0;

    const grayBox = (k) => h("input", { type: "text", value: val(k) || "（自动）", readOnly: true, disabled: true, tabIndex: -1,
      style: { minWidth: 260, background: "#f4f6f8", color: "#9aa2ad",
               border: "1px solid #f0f2f5", cursor: "default",
               userSelect: "none", WebkitUserSelect: "none", MozUserSelect: "none" } });

    return h("div", { class: "card" },
      h("div", { class: "rthead" },
        h("span", { class: "rt-name" }, rt.display),
        rt.kind === "service"
          ? (rt.detected ? h("span", { class: "tag ok" }, "✓ 服务在线") : h("span", { class: "tag err" }, "✗ 服务未响应"))
          : (rt.detected ? h("span", { class: "tag ok" }, "✓ 已检测到 CLI") : h("span", { class: "tag err" }, "✗ 未检测到")),
      ),
      rt.kind === "service" ? [
        h("div", { class: "row kv" }, h("span", { class: "k" }, "服务地址:"),
          h("input", { type: "text", value: rt.resolvedPath || "http://127.0.0.1:8001", readOnly: true, disabled: true, tabIndex: -1,
            style: { minWidth: 260, background: "#f4f6f8", color: "#9aa2ad", border: "1px solid #f0f2f5", cursor: "default", userSelect: "none", WebkitUserSelect: "none", MozUserSelect: "none" } })),
        rt.activeModel ? h("div", { class: "row kv" }, h("span", { class: "k" }, "当前生效模型:"),
          h("input", { type: "text", value: rt.activeModel, readOnly: true, disabled: true, tabIndex: -1,
            style: { minWidth: 260, background: "#f4f6f8", color: "#9aa2ad", border: "1px solid #f0f2f5",
                     cursor: "default", userSelect: "none", WebkitUserSelect: "none", MozUserSelect: "none" } })) : null,
      ] : [
        h("div", { class: "row kv" }, h("span", { class: "k" }, "对接 CLI:"),
          h("input", { type: "text", value: rt.resolvedPath || rt.command || "—", readOnly: true, disabled: true, tabIndex: -1,
            style: { minWidth: 260, background: "#f4f6f8", color: "#9aa2ad", border: "1px solid #f0f2f5", cursor: "default", userSelect: "none", WebkitUserSelect: "none", MozUserSelect: "none" } })),
      ],
      !rt.detected && rt.install ? h("div", { class: "row kv" }, h("span", { class: "k" }, "安装提示:"),
        h("span", { class: "v" }, rt.install)) : null,
      hasParams ? h("div", { class: "env-box" },
        h("div", { class: "env-title" }, "启动参数（当前真实生效值，由配置中心自动管理 · 本页只读）"),
        keys.map(function (k) {
          const isFlag = (rt.envFlags || []).includes(k);
          const label = labels[k] || k;
          const noteEl = noteOf(k) ? h("span", { class: "dim", style: { fontSize: 11, marginLeft: 6 } }, noteOf(k)) : null;
          const flagVal = isFlag ? (env[k] ? "已启用" : "已关闭") : null;
          return h("div", { class: "row kv", key: k },
            h("span", { class: "k" }, label),
            h("input", { type: "text", value: isFlag ? flagVal : (val(k) || "（自动）"), readOnly: true, disabled: true, tabIndex: -1,
              style: { minWidth: 260, background: "#f4f6f8", color: "#9aa2ad",
                       border: "1px solid #f0f2f5", cursor: "default",
                       userSelect: "none", WebkitUserSelect: "none", MozUserSelect: "none" } }),
            noteEl);
        }),
      ) : null,
    );
  }

  function App() {
    const [runtimes, setRuntimes] = useState(null);
    const [store, setStore] = useState(null);
    const [err, setErr] = useState(null);
    async function load() {
      const [r, s] = await Promise.all([api("/api/runtimes"), api("/api/store")]);
      if (r.httpOk && r.data && Array.isArray(r.data.runtimes)) setRuntimes(r.data.runtimes);
      else setErr("加载失败: " + (r.data?.error || r.status || ""));
      if (s.httpOk && s.data) setStore(s.data);
    }
    useEffect(function () { load(); }, []);

    if (err) return h("div", { class: "wrap" }, h("div", { class: "err" }, err));
    if (!runtimes || !store) return h("div", { class: "wrap" }, h("div", { class: "dim" }, "加载运行时…"));

    return h("div", { class: "wrap" },
      h("h1", null, inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"), " 🧩 运行时管理"),
      h("div", { class: "note-box" },
        "这里管理每个 Agent 实际对接的 AI CLI 程序。模型 / Provider / 上下文自动取自「Agent 分配置」；" +
        "每个 runtime 的启动参数已预设正确默认值（装上对应 CLI 即可不报错启动），可在此微调。改完点「保存并应用」即自动重启对应 Agent 生效。"),
      runtimes.map(function (rt) { return h(RuntimeCard, { rt: rt, store: store, key: rt.runtime, onChanged: load }); }),
    );
  }

  render(h(App, null), document.getElementById("root"));
})();
