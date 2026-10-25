/* 独立 React(pReact) 总配置·模型页 —— 精简版：
 * - 卡片只露「显示名 + 模型列表」；插件/Key/BaseURL/内部ID 收进「高级」折叠
 * - 模型行只填一个模型 id（状态行标签自动 = id，上下文窗口默认 1000000）
 * - 每行模型 + 卡片头部都有「测试连通性」按钮（POST /api/providers/:id/test）
 */
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

  /** 模型行：模型名 + 别名（状态行显示，留空用模型名）+ 测试 + 删。 */
  function ModelRow(props) {
    const m = props.m;
    const [testing, setTesting] = useState(false);
    const [res, setRes] = useState(null);
    async function test() {
      const id = String(m.id || '').trim();
      if (!id) { setRes({ ok: false, error: "先填模型名" }); return; }
      setTesting(true); setRes(null);
      const r = await api("/api/providers/" + encodeURIComponent(props.providerId) + "/test", "POST", { model: id });
      setTesting(false);
      if (r.ok && r.data && r.data.ok) setRes({ ok: true, latencyMs: r.data.latencyMs });
      else setRes({ ok: false, error: (r.data && (r.data.error || r.data.data?.error)) || "测试失败" });
    }
    return h("div", { class: "model-row" },
      h("input", { class: "mid", type: "text", value: m.id || "", onInput: (e) => props.onChange({ id: e.target.value }), placeholder: "模型名（如 deepseek-chat）" }),
      h("input", { class: "mlabel", type: "text", value: m.label || "", onInput: (e) => props.onChange({ label: e.target.value }), placeholder: "状态栏短名" }),
      h("span", { class: res ? (res.ok ? "ok" : "err") : "", style: { fontSize: 11, minWidth: 70, display: "inline-block", textAlign: "right" } },
        res ? (res.ok ? "✓ " + res.latencyMs + "ms" : "✗") : ""),
      h("button", { class: "btn mini danger", onClick: props.onRemove }, "删"),
      h("button", { class: "btn mini", onClick: test, disabled: testing || !props.providerId }, testing ? "测…" : "测试"),
    );
  }

  /** Provider 折叠编辑卡。isNew=true 表示刚新增(还没存过)，保存走 POST；否则走 PUT(更新已有)。 */
  function ProviderCard(props) {
    const [open, setOpen] = useState(props.isNew ? true : !(props.closedSet && props.closedSet.has(props.init.id)));
    const [adv, setAdv] = useState(false);
    const [p, setP] = useState(props.init);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState(null);
    const [saved, setSaved] = useState(null);
    const [testing, setTesting] = useState(false);
    const [testRes, setTestRes] = useState(null);
    // 编辑已有时锁定的原始 id：保存永远 PUT 到这个 id，避免「改了 id 就新增一条副本」
    const origId = props.isNew ? null : props.init.id;
    const isSaved = !props.isNew;
    function upd(partial) { setP(Object.assign({}, p, partial)); setSaved(null); }
    function updModel(i, partial) {
      const models = (p.models || []).slice();
      models[i] = Object.assign({}, models[i], partial);
      upd({ models });
    }
    async function save() {
      setSaving(true); setErr(null);
      const id = String(origId ?? p.id ?? '').trim();
      if (!id) { setErr("id 不能为空"); setSaving(false); return; }
      const payload = { id, displayName: p.displayName, plugin: p.plugin, apiKeyEnv: p.apiKeyEnv, api: p.api || 'openai-completions', models: p.models || [] };
      if (p.baseURL) payload.baseURL = p.baseURL;
      let r;
      if (props.isNew) {
        r = await api("/api/providers", "POST", payload);
      } else {
        r = await api("/api/providers/" + encodeURIComponent(id), "PUT", payload);
      }
      setSaving(false);
      if (r.ok) { setSaved(true); props.onSaved(); }
      else { setErr(r.data?.error || "保存失败"); setSaved(false); }
    }
    async function remove() {
      if (!window.confirm("确认删除 Provider " + (p.displayName || p.id) + "? 引用它的 Agent 会失效。")) return;
      await api("/api/providers/" + encodeURIComponent(p.id), "DELETE");
      props.onDeleted();
    }
    async function test() {
      setTesting(true); setTestRes(null);
      const r = await api("/api/providers/" + encodeURIComponent(origId || p.id) + "/test", "POST", {});
      setTesting(false);
      if (r.ok && r.data && r.data.ok) setTestRes({ ok: true, latencyMs: r.data.latencyMs, model: r.data.model });
      else setTestRes({ ok: false, error: (r.data && (r.data.error || r.data.data?.error)) || "测试失败" });
    }
    function toggleOpen() { const next = !open; setOpen(next); if (props.onClosedChange) props.onClosedChange(props.init.id, !next); }
    const modelCount = (p.models || []).length;
    return h("div", { class: "pcard" },
      h("div", { class: "phead" },
        h("span", { class: "name", style: { cursor: "pointer" }, onClick: toggleOpen }, p.displayName || p.id),
        h("span", { class: "dim", style: { marginLeft: 8 } }, modelCount + " 个模型"),
        props.usageLabel ? h("span", { class: "dim", style: { marginLeft: 8 } }, "⏱ " + props.usageLabel) : null,
        props.balanceLabel ? h("span", { class: "ok", style: { marginLeft: 8 } }, "💰 " + props.balanceLabel) : null,
        h("span", { style: { flex: 1 } }),
        isSaved ? h("button", { class: "btn mini", style: { fontSize: 11 }, onClick: () => props.onMove(props.index, -1), disabled: props.index === 0, title: "上移" }, "↑") : null,
        isSaved ? h("button", { class: "btn mini", style: { fontSize: 11 }, onClick: () => props.onMove(props.index, 1), disabled: props.index >= props.total - 1, title: "下移" }, "↓") : null,
        isSaved ? h("button", { class: "btn mini", onClick: test, disabled: testing }, testing ? "测…" : "测试连通") : null,
        testRes ? h("span", { class: testRes.ok ? "ok" : "err", style: { fontSize: 11, marginLeft: 6 } },
          testRes.ok ? ("✓ " + testRes.latencyMs + "ms" + (testRes.model ? " · " + testRes.model : "")) : testRes.error) : null,
        h("span", { class: "chev", style: { cursor: "pointer" }, onClick: toggleOpen }, open ? "收起 ▴" : "展开 ▾"),
      ),
      open ? h("div", { class: "pbody" },
        err ? h("div", { class: "err" }, err) : null,
        saved ? h("div", { class: "ok", style: { marginBottom: 6 } }, "✅ 已保存") : null,
        h("div", { class: "row" },
          Field({ label: "服务商（Provider）" }, h("input", { type: "text", value: p.displayName || "", onInput: (e) => upd({ displayName: e.target.value }), placeholder: "如 火山 Ark、DeepSeek 官方" })),
          Field({ label: "API 协议（电话用语）" }, h("select", { value: p.plugin + '|' + (p.api || 'openai-completions'), onInput: (e) => { const v = e.target.value.split('|'); upd({ plugin: v[0], api: v[1] }); } },
            [["llm-pi-ai|openai-completions", "OpenAI 聊天（绝大多数服务商用这个）"], ["llm-pi-ai|openai-responses", "OpenAI Responses（新协议）"], ["llm-pi-ai|anthropic-messages", "Anthropic（Claude 协议）"], ["llm-deepseek|openai-completions", "DeepSeek 官方协议"]].map(function (o) { return h("option", { value: o[0] }, o[1]); }))),
        ),
        h("div", { class: "row" },
          Field({ label: "钥匙（Key 环境变量名）" }, h("input", { type: "text", value: p.apiKeyEnv || "", onInput: (e) => upd({ apiKeyEnv: e.target.value }), placeholder: "如 ARK_API_KEY" })),
          Field({ label: "地址（BaseURL）" }, h("input", { type: "text", value: p.baseURL || "", onInput: (e) => upd({ baseURL: e.target.value }), placeholder: "https://..." })),
        ),
        // 列标题行：小字浅色（与字段标签同款），与模型行同构对齐
        h("div", { class: "model-row", style: { fontSize: 12, color: "var(--dim)", margin: "10px 0 4px" } },
          h("span", { style: { flex: 2, minWidth: 0 } }, "模型（状态栏显示的模型）"),
          h("span", { style: { flex: 1, minWidth: 0 } }, "状态栏短名"),
          h("span", { style: { flex: "none", minWidth: 70 } }, ""),
          h("span", { style: { flex: "none", minWidth: 30 } }, ""),
          h("span", { style: { flex: "none", minWidth: 42 } }, ""),
        ),
        (p.models || []).map(function (m, i) {
          return h(ModelRow, { key: i, m, providerId: origId || p.id, onChange: (partial) => updModel(i, partial), onRemove: () => { const models = (p.models || []).slice(); models.splice(i, 1); upd({ models }); } });
        }),
        h("div", { class: "row" },
          h("button", { class: "btn mini", onClick: () => { const models = (p.models || []).slice(); models.push({ id: '', label: '', contextWindow: 1000000 }); upd({ models }); } }, "+ 模型"),
        ),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存"),
          h("button", { class: "btn danger", onClick: remove }, "删除"),
        ),
      ) : null,
    );
  }

  function App() {
    const [providers, setProviders] = useState(null);
    const [closedSet, setClosedSet] = useState(null);
    const [err, setErr] = useState(null);
    // 2026-08-30 合并概览页：余额/用量按 provider 展示（取该 provider 下任一 agent 的 status）
    const [provStat, setProvStat] = useState({});

    function usageText(usage) {
      if (!usage || !Array.isArray(usage.periods) || usage.periods.length === 0) return null;
      const USAGE_LABEL = { '5h': '5h', weekly: '周', monthly: '月' };
      return usage.periods.map(function (p) {
        const label = USAGE_LABEL[p.label] || p.label;
        const pct = p.quota > 0 ? Math.round((p.used / p.quota) * 100) : 0;
        return label + pct + '%';
      }).join(' ');
    }
    function balanceText(b) {
      const cur = b && b.currency === 'CNY' ? '¥' : ((b && b.currency) || '');
      const amt = Number(b && b.total);
      const val = Number.isFinite(amt) ? amt.toFixed(2) : (b ? String(b.total) : '—');
      return cur + val;
    }
    async function refreshProvStat(providersList) {
      const ins = await api("/api/agents/installed");
      const installed = (ins.httpOk && ins.data && Array.isArray(ins.data.installed)) ? new Set(ins.data.installed) : null;
      const storeR = await api("/api/store");
      const agents = (storeR.httpOk && storeR.data && storeR.data.agents) || [];
      const picked = {};
      for (const pr of providersList) {
        const a = agents.find((x) => x.providerId === pr.id && (!installed || installed.has(x.id)));
        if (a) { picked[pr.id] = a.id; continue; }
        // 2026-08-30 兜底：provider 没有自己的 agent 时（如 ArkResp/GWResp/GWAnth 协议变体），
        // 共享同网关（origin 相同，路径 /v1 /v3 等差异忽略）的其他 provider 的额度数据
        const origin = (u) => { try { return new URL(u).origin; } catch (e) { return u; } };
        const twin = agents.find((x) => (!installed || installed.has(x.id)) && providersList.some((q) => q.id === x.providerId && origin(q.baseURL) === origin(pr.baseURL) && picked[x.providerId]));
        if (twin) picked[pr.id] = picked[twin.providerId];
      }
      for (const [pid, aid] of Object.entries(picked)) {
        try {
          const r = await api("/api/agents/" + encodeURIComponent(aid) + "/status");
          if (r.httpOk && r.data) setProvStat((prev) => Object.assign({}, prev, { [pid]: r.data }));
        } catch (e) { /* 单个失败不影响其他 */ }
      }
    }

    async function load() {
      const r = await api("/api/store");
      if (r.httpOk && r.data && Array.isArray(r.data.providers)) setProviders(r.data.providers);
      else setErr("加载失败: " + (r.data?.error || ""));
      const o = await api("/api/providers/open-state");
      if (o.httpOk && o.data && Array.isArray(o.data.closed)) setClosedSet(new Set(o.data.closed));
      else setClosedSet(new Set());
      if (r.httpOk && r.data && Array.isArray(r.data.providers)) refreshProvStat(r.data.providers);
    }
    // 点开某卡片 → 从收起列表清除；收起某卡片 → 加进收起列表；都写回后端持久化
    function onClosedChange(id, closed) {
      setClosedSet((prev) => {
        const s = new Set(prev || []);
        if (closed) s.add(id); else s.delete(id);
        api("/api/providers/open-state", "POST", { id, closed: !!closed });
        return s;
      });
    }
    useEffect(function () { load(); }, []);

    function addNew() {
      const p = { _new: true, id: 'p' + Date.now(), displayName: '新 Provider', plugin: 'llm-pi-ai', apiKeyEnv: '', api: 'openai-completions', models: [] };
      setProviders((prev) => (prev || []).concat([p]));
    }

    // 交换 Provider 顺序（保存前本地移动 + 调后端 /api/providers/reorder 持久化）；新增未保存的卡片跳过
    function moveProvider(from, dir) {
      setProviders((prev) => {
        const list = (prev || []).slice();
        const to = from + dir;
        if (to < 0 || to >= list.length) return list;
        const a = list[from], b = list[to];
        if (a._new || b._new) return list; // 未保存的新卡片不参与排序
        list[from] = b; list[to] = a;
        api("/api/providers/reorder", "POST", { ids: list.map((x) => x.id) });
        return list;
      });
    }

    if (!providers || !closedSet) {
      return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载 Provider 池…")));
    }

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " ☁️ 模型 / Provider 池",
      ),
      err ? h("div", { class: "card" }, h("div", { class: "err" }, err)) : null,
      h("div", { class: "toolbar" },
        h("button", { class: "btn primary", onClick: addNew }, "+ 新增 Provider"),
        h("span", { class: "dim" }, providers.length + " 个 Provider"),
      ),
      providers.map(function (p, i) {
        const st = provStat[p.id] || {};
        return h(ProviderCard, { key: p._new ? ('new-' + p.id) : p.id, isNew: !!p._new, init: p, index: i, total: providers.length, onMove: moveProvider, closedSet: closedSet, onClosedChange: onClosedChange, onSaved: load, onDeleted: load, usageLabel: usageText(st.usage), balanceLabel: st.balance ? balanceText(st.balance) : null });
      }),
      providers.length === 0 ? h("div", { class: "card" }, h("div", { class: "dim" }, "还没有 Provider，点「+ 新增 Provider」创建。")) : null,
    );
  }

  render(h(App, null), document.getElementById("root"));
})();