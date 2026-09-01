/* 独立 React(pReact) 技能库设置页 —— 显示/新增/删除/安装/搜索市场 + 启停开关，接口 /api/skills/* */
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

  function Field(props, kid) {
    const children = kid !== undefined ? kid : props.children;
    return h("label", { class: "field" }, props.label, children);
  }
  function Card(props) {
    const [open, setOpen] = useState(props.defaultOpen !== false);
    return h("div", { class: "card" },
      h("div", { class: "card-header", onClick: () => setOpen(!open) },
        h("span", { class: "title" }, props.title),
        props.badge ? h("span", { class: "tag" }, props.badge) : null,
        h("span", { class: "chev" }, open ? "收起 ▴" : "展开 ▾"),
      ),
      open ? h("div", { class: "map", style: { marginTop: 8 } }, props.children) : null,
    );
  }
  function Switch(props) {
    return h("label", { class: "switch", title: props.title || "" },
      h("input", { type: "checkbox", checked: !!props.checked, onChange: props.onChange }),
      h("span", { class: "slider" }),
    );
  }

  // 编辑器模态（新增 / 编辑共用）
  function EditorModal(props) {
    const [name, setName] = useState(props.name || "");
    const [content, setContent] = useState(props.content || "");
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState(null);
    const isNew = !props.name;
    const save = async () => {
      if (!name.trim()) { setErr("请填写技能名（字母/数字/-/_）"); return; }
      if (!content.trim()) { setErr("请填写 SKILL.md 内容"); return; }
      setSaving(true); setErr(null);
      const r = await api("/api/skills/save", "POST", { name: name.trim(), content });
      setSaving(false);
      if (r.ok) { props.onSaved(name.trim()); }
      else { setErr(r.data.error || "保存失败"); }
    };
    return h("div", { class: "modal-mask", onClick: () => props.onClose() },
      h("div", { class: "modal", onClick: function (e) { e.stopPropagation(); } },
        h("div", { class: "modal-head" },
          h("span", null, isNew ? "➕ 新增技能" : ("✏️ 编辑「" + props.name + "」")),
          h("span", { class: "close", onClick: () => props.onClose() }, "✕"),
        ),
        h("div", { class: "modal-body" },
          isNew ? h("div", { class: "row" },
            Field({ label: "技能名" }, h("input", { type: "text", value: name, onInput: function (e) { setName(e.target.value); }, placeholder: "如：my-skill" })),
          ) : h("div", { class: "dim", style: { marginBottom: 8 } }, "技能路径：skills/" + props.name + "/SKILL.md"),
          h("div", { class: "row" }, Field({ label: "SKILL.md 内容（Markdown）" }, h("textarea", { rows: 18, value: content, onInput: function (e) { setContent(e.target.value); }, placeholder: "# 技能名 | 当……时使用。" }))),
          err ? h("div", { class: "err" }, err) : null,
        ),
        h("div", { class: "modal-foot" },
          h("button", { class: "btn", onClick: () => props.onClose() }, "取消"),
          h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存"),
        ),
      ),
    );
  }

  function App() {
    const [data, setData] = useState(null);   // {skills, market, config}
    const [search, setSearch] = useState("");
    const [marketUrl, setMarketUrl] = useState("");
    const [msg, setMsg] = useState(null);     // {ok,text}
    const [editItem, setEditItem] = useState(null); // null | {name, content} 新增时 content=''
    const [busy, setBusy] = useState(false);
    const [remoteLoading, setRemoteLoading] = useState(false);
    const [remote, setRemote] = useState([]);

    /* 加载 */
    async function load() {
      const r = await api("/api/skills");
      if (r.httpOk && r.data.ok) {
        setData(r.data);
        setMarketUrl(r.data.config?.marketUrl || "");
      } else {
        setMsg({ ok: false, text: "加载失败: " + (r.data?.error || String(r.data)) });
      }
    }
    useEffect(function () { load(); }, []);

    /* 启停 */
    async function toggleSkill(name, on) {
      const r = await api("/api/skills/toggle", "POST", { name, enabled: on });
      if (r.ok) { const d = Object.assign({}, data, { config: Object.assign({}, data.config, { enabled: r.data.enabled }) }); setData(d); setMsg({ ok: true, text: "已" + (on ? "启用" : "停用") + "技能「" + name + "」" }); }
      else setMsg({ ok: false, text: (r.data?.error || "操作失败") });
    }
    /* 删除 */
    async function deleteSkill(skill) {
      if (!window.confirm("删除技能「" + skill.name + "」？将移除 skills/" + skill.name + "/SKILL.md，且不再挂载。")) return;
      const r = await api("/api/skills/delete", "POST", { name: skill.name });
      if (r.ok) { const d = Object.assign({}, data, { skills: (data.skills || []).filter(function (s) { return s.name !== skill.name; }) }); setData(d); setMsg({ ok: true, text: "已删除技能「" + skill.name + "」" }); }
      else setMsg({ ok: false, text: (r.data?.error || "删除失败") });
    }
    /* 安装 */
    async function installSkill(item, source, content) {
      setBusy(true);
      const r = await api("/api/skills/install", "POST", { name: item.name, source, content: content || undefined });
      setBusy(false);
      if (r.ok) { setMsg({ ok: true, text: "已安装技能「" + item.name + "」" }); await load(); }
      else setMsg({ ok: false, text: "安装失败: " + (r.data?.error || "") });
    }
    /* 拉取远程市场 */
    async function loadRemote() {
      if (!marketUrl.trim()) { setMsg({ ok: false, text: "请先在下方配置远程市场 URL" }); return; }
      setRemoteLoading(true);
      const r = await api("/api/skills/market");
      setRemoteLoading(false);
      if (r.ok && r.data.ok) {
        setRemote(r.data.remote || []);
        setMsg(r.data.remoteError ? { ok: false, text: r.data.remoteError } : { ok: true, text: "已拉取 " + (r.data.remote || []).length + " 个远程技能" });
      } else setMsg({ ok: false, text: (r.data?.error || "拉取失败") });
    }
    /* 保存市场 URL */
    async function saveMarketUrl() {
      const r = await api("/api/skills/save-market-url", "POST", { url: marketUrl.trim() });
      if (r.ok) { setMsg({ ok: true, text: "已保存市场 URL" }); }
      else setMsg({ ok: false, text: (r.data?.error || "保存失败") });
    }

    if (!data) {
      return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载技能库…")));
    }

    const skills = data.skills || [];
    const localMarket = (data.market || []);
    const remoteList = remote;
    const all = skills.concat(
      localMarket.filter(function (m) { return !skills.some(function (s) { return s.name === m.name; }); })
        .map(function (m) { return { name: m.name, installed: false, enabled: false, desc: m.desc, inMarket: true }; }),
    );
    const kw = search.trim().toLowerCase();
    const filtered = kw === "" ? all : all.filter(function (s) { return s.name.toLowerCase().includes(kw) || (s.desc || "").toLowerCase().includes(kw); });

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " 🛠 技能库",
      ),
      msg ? h("div", { class: "card" }, h("div", { class: msg.ok ? "ok" : "err" }, msg.text)) : null,

      h("Card", { title: "已安装技能", badge: skills.length + " 个" },
        (skills.length === 0) ? h("div", { class: "dim" }, "还没有安装技能，可在下方「技能市场」搜索安装，或点「新增技能」自建。") :
          skills.map(function (s) {
            return h("div", { class: "skill-row", key: s.name },
              h("div", { class: "skill-main" },
                h("div", { class: "skill-name" },
                  h("span", null, s.name),
                  s.enabled ? h("span", { class: "tag ok" }, "启用") : h("span", { class: "tag" }, "停用"),
                ),
                s.desc ? h("div", { class: "skill-desc" }, s.desc) : null,
              ),
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" } },
                h("div", { class: "dim" }, "挂载"),
                h(Switch, { checked: s.enabled, onChange: () => toggleSkill(s.name, !s.enabled), title: s.enabled ? "停用此技能" : "启用此技能" }),
                h("button", { class: "btn", onClick: () => setEditItem({ name: s.name, content: s.content || "" }) }, "编辑"),
                h("button", { class: "btn danger", onClick: () => deleteSkill(s) }, "删除"),
              ),
            );
          }),
        h("div", { class: "divider" }),
        h("div", { class: "row" }, h("button", { class: "btn primary", onClick: () => setEditItem({ name: "", content: "" }) }, "➕ 新增技能")),
      ),

      h("Card", { title: "🔍 技能市场", badge: (localMarket.length + remoteList.length) + " 个可安装", defaultOpen: true },
        h("input", { class: "search-box", type: "text", value: search, onInput: (e) => setSearch(e.target.value), placeholder: "搜索技能名 / 说明…" }),
        h("div", { class: "divider" }),
        h("div", { class: "dim", style: { marginBottom: 6 } }, "搜索结果（含已安装）"),
        (filtered.length === 0) ? h("div", { class: "dim" }, "未找到匹配技能") :
          filtered.map(function (s) {
            if (s.installed) {
              return h("div", { class: "market-item", key: s.name },
                h("div", { class: "skill-main" },
                  h("div", { class: "skill-name" }, h("span", null, s.name), h("span", { class: "tag ok" }, "已安装")),
                  s.desc ? h("div", { class: "skill-desc" }, s.desc) : null,
                ),
              );
            }
            const src = s.inMarket ? "local" : "remote";
            return h("div", { class: "market-item", key: s.name },
              h("div", { class: "skill-main" },
                h("div", { class: "skill-name" }, h("span", null, s.name), h("span", { class: "tag" }, src === "local" ? "本地" : "远程")),
                s.desc ? h("div", { class: "skill-desc" }, s.desc) : null,
              ),
              h("button", { class: "btn primary", disabled: busy, onClick: () => installSkill(s, src, s.content) }, "安装"),
            );
          }),
      ),

      h("Card", { title: "⚙️ 远程市场配置", defaultOpen: false },
        h("div", { class: "row" },
          Field({ label: "远程市场索引 URL" }, h("input", { type: "text", value: marketUrl, onInput: (e) => setMarketUrl(e.target.value), placeholder: "https://example.com/skills-index.json（含 skills:[{name,content}]）" })),
        ),
        h("div", { class: "row" },
          h("button", { class: "btn", onClick: loadRemote, disabled: remoteLoading }, remoteLoading ? "拉取中…" : "拉取远程市场"),
          h("button", { class: "btn", onClick: saveMarketUrl }, "保存市场 URL"),
        ),
        h("div", { class: "dim", style: { marginTop: 6 } }, "市场索引 JSON 格式：{ \"skills\": [ { \"name\": \"xxx\", \"content\": \"# SKILL.md 全文\" } ] }"),
      ),

      editItem ? h(EditorModal, {
        name: editItem.name,
        content: editItem.content,
        onClose: () => setEditItem(null),
        onSaved: async function (name) { setEditItem(null); setMsg({ ok: true, text: "已保存「" + name + "」" }); await load(); },
      }) : null,
    );
  }

  render(h(App, null), document.getElementById("root"));
})();