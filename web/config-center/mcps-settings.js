/* 独立 React(pReact) 总配置·MCP 页 —— 迁移自 Vue 版，接口 /api/mcps/* */
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
      return { httpOk: r.ok, ok: r.ok && d.ok !== false, data: d, status: r.status };
    } catch (e) { return { httpOk: false, ok: false, data: { error: String(e) } }; }
  }
  function Field(props, kid) {
    const children = kid !== undefined ? kid : props.children;
    return h("label", { class: "field" }, props.label, children);
  }
  function McpCard(props) {
    const [open, setOpen] = useState(false);
    const [m, setM] = useState(props.init);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState(null);
    const [saved, setSaved] = useState(null);
    function upd(partial) { setM(Object.assign({}, m, partial)); setSaved(null); }
    function argsText() {
      return Array.isArray(m.args) ? m.args.join(",") : (m.argsText || "");
    }
    function setArgsText(txt) {
      const arr = txt.split(",").map((s) => s.trim()).filter(Boolean);
      upd({ args: arr, argsText: txt });
    }
    async function save() {
      setSaving(true); setErr(null);
      const id = String(m.id || '').trim();
      if (!id) { setErr("id 不能为空"); setSaving(false); return; }
      const payload = {
        id, displayName: m.displayName, transport: m.transport === "stdio" ? "stdio" : "streamable-http",
        serverName: m.serverName || m.id,
        failOnStartupError: m.failOnStartupError !== false,
      };
      if (payload.transport === "streamable-http" && m.url) payload.url = m.url;
      if (payload.transport === "stdio") { payload.command = m.command; payload.args = m.args; }
      if (m.toolCallTimeoutMs) payload.toolCallTimeoutMs = m.toolCallTimeoutMs;
      let r = await api("/api/mcps/" + encodeURIComponent(id), "PUT", payload);
      if (r.status === 404) r = await api("/api/mcps", "POST", payload);
      setSaving(false);
      if (r.ok) { setSaved(true); props.onSaved(); }
      else { setErr(r.data?.error || "保存失败"); setSaved(false); }
    }
    async function remove() {
      if (!window.confirm("确认删除 MCP " + (m.displayName || m.id) + "?")) return;
      await api("/api/mcps/" + encodeURIComponent(m.id), "DELETE");
      props.onDeleted();
    }
    return h("div", { class: "pcard" },
      h("div", { class: "phead", onClick: () => setOpen(!open) },
        h("span", { class: "name" }, m.displayName || m.id),
        h("span", { class: "tag" }, m.transport),
        h("span", { class: "tag warn" }, m.id),
        h("span", { class: "chev" }, open ? "收起 ▴" : "展开 ▾"),
      ),
      open ? h("div", { class: "pbody" },
        err ? h("div", { class: "err" }, err) : null,
        saved ? h("div", { class: "ok", style: { marginBottom: 6 } }, "✅ 已保存") : null,
        h("div", { class: "row" },
          Field({ label: "内部 ID" }, h("input", { type: "text", value: m.id || "", onInput: (e) => upd({ id: e.target.value }), placeholder: "如 feishu-base" })),
          Field({ label: "显示名" }, h("input", { type: "text", value: m.displayName || "", onInput: (e) => upd({ displayName: e.target.value }), placeholder: "如 飞书多维表格" })),
        ),
        h("div", { class: "row" },
          Field({ label: "传输方式" }, h("select", { value: m.transport || "streamable-http", onInput: (e) => upd({ transport: e.target.value }) },
            [["streamable-http", "streamable-http"], ["stdio", "stdio"]].map(function (o) { return h("option", { value: o[0] }, o[1]); }))),
          Field({ label: "serverName" }, h("input", { type: "text", value: m.serverName || "", onInput: (e) => upd({ serverName: e.target.value }), placeholder: "如 lark-base" })),
        ),
        (m.transport || "streamable-http") === "streamable-http" ? h("div", { class: "row" },
          Field({ label: "URL" }, h("input", { type: "text", value: m.url || "", onInput: (e) => upd({ url: e.target.value }), placeholder: "http://.../mcp" })),
        ) : h("div", { class: "row" },
          Field({ label: "命令" }, h("input", { type: "text", value: m.command || "", onInput: (e) => upd({ command: e.target.value }), placeholder: "如 npx -y @modelcontextprotocol/server-xxx" })),
          Field({ label: "参数（逗号分隔）" }, h("input", { type: "text", value: argsText(), onInput: (e) => setArgsText(e.target.value), placeholder: "arg1,arg2" })),
        ),
        h("div", { class: "row" },
          Field({ label: "toolCallTimeoutMs" }, h("input", { type: "number", value: m.toolCallTimeoutMs || "", onInput: (e) => upd({ toolCallTimeoutMs: Number(e.target.value) || undefined }), placeholder: "默认 120000" })),
        ),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存"),
          h("button", { class: "btn danger", onClick: remove }, "删除"),
        ),
      ) : null,
    );
  }

  function App() {
    const [mcps, setMcps] = useState(null);
    const [err, setErr] = useState(null);
    async function load() {
      const r = await api("/api/store");
      if (r.httpOk && r.data && Array.isArray(r.data.mcps)) setMcps(r.data.mcps);
      else setErr("加载失败: " + (r.data?.error || ""));
    }
    useEffect(function () { load(); }, []);
    function addNew() {
      const m = { id: 'm' + Date.now(), displayName: '新 MCP', transport: 'streamable-http', serverName: '', url: '', failOnStartupError: false, args: [] };
      setMcps((prev) => (prev || []).concat([m]));
    }
    if (!mcps) {
      return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载 MCP 池…")));
    }
    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " 🔌 总配置 · MCP 服务池",
      ),
      err ? h("div", { class: "card" }, h("div", { class: "err" }, err)) : null,
      h("div", { class: "toolbar" },
        h("button", { class: "btn primary", onClick: addNew }, "+ 新增 MCP"),
        h("span", { class: "dim" }, mcps.length + " 个 MCP"),
      ),
      mcps.map(function (m) {
        return h(McpCard, { key: m.id, init: m, onSaved: load, onDeleted: load });
      }),
      mcps.length === 0 ? h("div", { class: "card" }, h("div", { class: "dim" }, "还没有 MCP，点「+ 新增 MCP」创建。")) : null,
    );
  }

  render(h(App, null), document.getElementById("root"));
})();