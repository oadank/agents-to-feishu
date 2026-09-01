/* 独立 React(pReact) Agent 分配置页 —— 迁移自 Vue 版，接口 /api/agents/* */
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
    return h("label", { class: "field" + (props.wide ? " wide" : "") }, props.label, children);
  }
  function Switch(props) {
    return h("label", { class: "switch", title: props.title || "" },
      h("input", { type: "checkbox", checked: !!props.checked, onChange: props.onChange }),
      h("span", { class: "slider" }),
    );
  }
  function SecretInput(props) {
    const [show, setShow] = useState(false);
    return h("div", { style: { display: "flex", gap: 6 } },
      h("input", { type: show ? "text" : "password", value: props.value, onInput: props.onInput, placeholder: props.placeholder }),
      h("button", { type: "button", class: "btn", style: { flex: "none" }, onClick: () => setShow(!show) }, show ? "🙈" : "👁"),
    );
  }

  // ── 编辑模态 ──
  function AgentModal(props) {
    const isNew = !props.agent;
    // 内部 ID 不再暴露给用户：新增时由显示名自动生成（英文/数字转小写），显示名改变时联动
    function autoId(name) {
      const base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      return base ? base : '';
    }
    const [f, setF] = useState(function () {
      if (props.agent) {
        return {
          id: props.agent.id, displayName: props.agent.displayName, appId: props.agent.appId || "", appSecret: props.agent.appSecret || "",
          providerId: props.agent.providerId, modelId: props.agent.modelId, mcps: (props.agent.mcps || []).slice(),
          port: props.agent.port, workdir: props.agent.workdir, enabled: props.agent.enabled !== false,
          systemPrompt: props.agent.systemPrompt || "",
          showToolCallCards: props.agent.showToolCallCards !== false,
          showThinkingCards: props.agent.showThinkingCards !== false,
          showAgentDivider: props.agent.showAgentDivider !== false,
        };
      }
      return {
        id: "", displayName: "", appId: "", appSecret: "", providerId: (props.providers[0] && props.providers[0].id) || "", modelId: "",
        mcps: [], port: 13600, workdir: "C:\\D\\opt", enabled: true, systemPrompt: "",
        showToolCallCards: true, showThinkingCards: true, showAgentDivider: true,
      };
    });
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState(null);
    function upd(partial) { setF(Object.assign({}, f, partial)); setErr(null); }
    function curProviderModels() {
      const p = props.providers.find((x) => x.id === f.providerId);
      return p ? (p.models || []) : [];
    }
    function onProviderChange(newProviderId) {
      const p = props.providers.find((x) => x.id === newProviderId);
      const models = p ? (p.models || []) : [];
      upd({ providerId: newProviderId, modelId: (models[0] && models[0].id) || "" });
    }
    function toggleMcp(id) {
      const cur = f.mcps || [];
      upd({ mcps: cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat([id]) });
    }
    async function save() {
      if (!String(f.displayName || '').trim()) { setErr("显示名必填"); return; }
      const finalId = String(f.id || autoId(f.displayName) || '').trim();
      if (!finalId) { setErr("无法自动生成内部 ID（显示名需含英文/数字），请调整显示名"); return; }
      setSaving(true); setErr(null);
      let r;
      if (isNew) r = await api("/api/agents", "POST", Object.assign({}, f, { id: finalId }));
      else r = await api("/api/agents/" + encodeURIComponent(f.id), "PUT", f);
      if (r.ok) {
        // 保存成功后自动应用（渲染配置 + 重启进程），不用再手动点"应用"
        const ap = await api("/api/agents/" + encodeURIComponent(finalId) + "/apply", "POST");
        setSaving(false);
        if (ap.ok) {
          props.onSaved();
        } else {
          setErr("已保存，但应用失败：" + (ap.data?.error || "未知错误") + "（可稍后手动点「应用」重试）");
        }
        return;
      }
      setSaving(false);
      setErr(r.data?.error || "保存失败");
    }
    return h("div", { class: "mask" },
      h("div", { class: "modal" },
        h("span", { class: "close", onClick: () => props.onClose() }, "✕"),
        h("h2", null, isNew ? "➕ 新增 Agent" : "✏️ 编辑 Agent"),
        err ? h("div", { class: "err", style: { marginBottom: 6 } }, err) : null,
        h("div", { class: "row" },
          Field({ label: "显示名（Agent:）" }, h("input", { type: "text", value: f.displayName, onInput: (e) => upd({ displayName: e.target.value, id: isNew ? autoId(e.target.value) : f.id }), placeholder: "如 Gemini" })),
        ),
        h("div", { class: "row" },
          Field({ label: "飞书 AppId" }, h("input", { type: "text", value: f.appId, onInput: (e) => upd({ appId: e.target.value }) })),
          Field({ label: "飞书 AppSecret" }, h(SecretInput, { value: f.appSecret, onInput: (e) => upd({ appSecret: e.target.value }) })),
        ),
        h("div", { class: "row" },
          Field({ label: "Provider" }, h("select", { value: f.providerId, onInput: (e) => onProviderChange(e.target.value) },
            props.providers.map(function (p) { return h("option", { value: p.id }, p.displayName); }))),
          Field({ label: "模型" }, h("select", { value: f.modelId, onInput: (e) => upd({ modelId: e.target.value }) },
            curProviderModels().map(function (m) { return h("option", { value: m.id }, (m.label || m.id) + " (" + m.id + ")"); }))),
        ),

        h("div", { class: "row" },
          Field({ label: "状态栏样式" }, h("select", { value: f.dividerMode || "full", onInput: (e) => upd({ dividerMode: e.target.value }) },
            h("option", { value: "full" }, "默认（图标 + 文字）"),
            h("option", { value: "text" }, "文字"),
            h("option", { value: "icon" }, "图标"),
            h("option", { value: "value" }, "仅数值"))),
          Field({ label: "思考深度" }, h("select", { value: f.thinkingLevel || "default", onInput: (e) => upd({ thinkingLevel: e.target.value }) },
            h("option", { value: "default" }, "默认"),
            h("option", { value: "off" }, "关闭（干活快）"),
            h("option", { value: "high" }, "高（深度思考）"))),
        ),
        h("div", { class: "row" },
          Field({ label: "端口" }, h("input", { type: "number", value: f.port, min: 10000, max: 19999, onInput: (e) => upd({ port: Number(e.target.value) || 13600 }) })),
          Field({ label: "工作目录" }, h("input", { type: "text", value: f.workdir, onInput: (e) => upd({ workdir: e.target.value }), placeholder: "C:\\D\\opt" })),
        ),
        h("div", { class: "row" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { class: "dim" }, "启用"),
            h(Switch, { checked: f.enabled, onChange: () => upd({ enabled: !f.enabled }) }),
          ),
        ),
        // 2026-09-01 卡片显示开关：工具层 / 思考层 / 状态栏（关 = 流式与最终卡片都不出现对应区块）
        h("div", { class: "row" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" } },
            h("span", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("span", { class: "dim", title: "回复卡片里的 🔧 工具执行代码块" }, "工具层"),
              h(Switch, { checked: f.showToolCallCards, onChange: () => upd({ showToolCallCards: !f.showToolCallCards }) }),
            ),
            h("span", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("span", { class: "dim", title: "回复卡片里的 💭 思考引用块" }, "思考层"),
              h(Switch, { checked: f.showThinkingCards, onChange: () => upd({ showThinkingCards: !f.showThinkingCards }) }),
            ),
            h("span", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("span", { class: "dim", title: "卡片底部的 Agent|Model|Provider|Session|Cache 状态行" }, "状态栏"),
              h(Switch, { checked: f.showAgentDivider, onChange: () => upd({ showAgentDivider: !f.showAgentDivider }) }),
            ),
          ),
        ),
        h("div", { class: "row" }, h("div", { style: { width: "100%" } },
          h("div", { class: "dim", style: { marginBottom: 4 } }, "MCP（勾选）"),
          h("div", { class: "checks" },
            props.mcps.length === 0 ? h("span", { class: "dim" }, "暂无 MCP（去「总配置 · MCP」新增）") :
              props.mcps.map(function (m) {
                return h("label", { key: m.id },
                  h("input", { type: "checkbox", checked: (f.mcps || []).includes(m.id), onChange: () => toggleMcp(m.id) }),
                  m.displayName,
                );
              }),
          ),
        )),
        h("div", { class: "row" }, Field({ label: "独立注入 systemPrompt", wide: true },
          h("textarea", { rows: 5, value: f.systemPrompt, onInput: (e) => upd({ systemPrompt: e.target.value }), placeholder: "该 agent 专属追加注入（拼在统一注入之后）" }))),
        h("div", { class: "row" },
          isNew ? null : h("button", { class: "btn danger", onClick: () => props.onDelete(props.agent) }, "删除此 Agent"),
          h("span", { style: { flex: 1 } }),
          h("button", { class: "btn", onClick: () => props.onClose() }, "取消"),
          h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存（自动应用）"),
        ),
      ),
    );
  }

  // ── 主页面 ──
  function App() {
    const [store, setStore] = useState(null);   // {agents, providers, mcps}
    const [caps, setCaps] = useState({ vision: false, speech: false });
    const [installed, setInstalled] = useState(null); // Set<string> | null（null=未探测完）
    const [svcStatus, setSvcStatus] = useState({});    // { [id]: "running"|"stopped" } —— 服务运行健康度
    const [applying, setApplying] = useState("");
    const [restarting, setRestarting] = useState("");
    const [editAgent, setEditAgent] = useState(null); // null | agent 对象（null=关闭）
    const [isNew, setIsNew] = useState(false);
    const [err, setErr] = useState(null);
    const [gsettings, setGsettings] = useState({ groupMentionOnly: true });
    const [userAuth, setUserAuth] = useState("");
    const [authListLabel, setAuthListLabel] = useState(""); // P1 修复：登录状态按钮独立 state（原与更换用户共用 userAuth，文案串台）

    async function load() {
      const r = await api("/api/store");
      if (r.httpOk && r.data && Array.isArray(r.data.agents)) {
        setStore(r.data);
        // 只显示系统上真实安装的服务（探测 /api/agents/installed）
        const ins = await api("/api/agents/installed");
        setInstalled((ins.httpOk && Array.isArray(ins.data.installed)) ? new Set(ins.data.installed) : null);
        setSvcStatus((ins.data && ins.data.status) || {});
        const gs = await api("/api/settings");
        if (gs.httpOk && gs.data) setGsettings(gs.data);
        const v = await api("/api/vision");
        const s = await api("/api/speech");
        setCaps({ vision: !!(v.data && v.data.vision && v.data.vision.enabled), speech: !!(s.data && s.data.speech && s.data.speech.enabled) });
        // 2026-08-30 合并概览页：余额/用量数据源（原 overview-settings）
        if (installed) for (const a of r.data.agents) { if (installed.has(a.id)) refreshRuntime(a.id); }
      } else {
        setErr("加载失败: " + (r.data?.error || ""));
      }
    }
    const [runtime, setRuntime] = useState({});
    async function refreshRuntime(id) {
      const r = await api("/api/agents/" + encodeURIComponent(id) + "/status");
      if (r.httpOk) setRuntime((prev) => Object.assign({}, prev, { [id]: r.data || null }));
    }
    useEffect(function () { load(); }, []);

    // 2026-08-30 修复：此前只在挂载时拉一次 store，页面切走/隐藏后回来仍是旧数据 ⇒
    // "Provider 页新增的模型，回到分配页下拉里没有"。切回前台 / 聚焦 / 后退缓存还原时重拉。
    useEffect(function () {
      function onWake() { if (document.visibilityState !== 'hidden') load(); }
      document.addEventListener('visibilitychange', onWake);
      window.addEventListener('focus', onWake);
      window.addEventListener('pageshow', onWake);
      return function () {
        document.removeEventListener('visibilitychange', onWake);
        window.removeEventListener('focus', onWake);
        window.removeEventListener('pageshow', onWake);
      };
    }, []);

    const USAGE_LABEL = { '5h': '5h', weekly: '周', monthly: '月' };
    function usageText(usage) {
      if (!usage || !Array.isArray(usage.periods) || usage.periods.length === 0) return null;
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
    function providerName(a) {
      const p = store.providers.find((x) => x.id === a.providerId);
      return p ? (p.displayName || p.id) : a.providerId;
    }
    function modelLabel(a) {
      const p = store.providers.find((x) => x.id === a.providerId);
      const m = p && p.models && p.models.find((x) => x.id === a.modelId);
      return m ? (m.label || m.id) : a.modelId;
    }
    async function applyAgent(id) {
      setApplying(id);
      const r = await api("/api/agents/" + encodeURIComponent(id) + "/apply", "POST");
      setApplying("");
      if (!r.ok) setErr("应用失败: " + (r.data?.error || ""));
    }
    async function restartAgent(id) {
      setRestarting(id);
      const r = await api("/api/agents/" + encodeURIComponent(id) + "/restart", "POST");
      setRestarting("");
      if (!r.ok) setErr("重启失败: " + (r.data?.error || ""));
    }
    async function deleteAgent(a) {
      if (!window.confirm("确认删除 Agent " + (a.displayName || a.id) + "?")) return;
      await api("/api/agents/" + encodeURIComponent(a.id), "DELETE");
      load();
    }
    function openNew() { setIsNew(true); setEditAgent({}); }
    function openEdit(a) { setIsNew(false); setEditAgent(a); }

    if (!store || !installed) {
      return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载 Agent 分配置…")));
    }
    const agents = (store.agents || []).filter((a) => installed.has(a.id));

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " 🤖 Agent 分配置",
        h("span", { class: "dim", style: { fontWeight: 400, fontSize: 12 } }, "从总配置选择模型 / Provider / MCP"),
      ),
      err ? h("div", { class: "card" }, h("div", { class: "err" }, err)) : null,
      h("div", { class: "card" },
        h("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
          h("b", null, "用户身份（传话通道）"),
          h("span", { class: "dim", style: { fontSize: 12 } }, "由本机 lark-cli 管理登录（token 存本机，不进 git/配置文件），换机器需重新登录"),
          h("button", { class: "btn", style: { fontSize: 12 }, onClick: async () => {
            setUserTest("查询中…");
            const r = await api("/api/tools/user-auth-list", "POST", {});
            try {
              const arr = JSON.parse(String(r.data?.data || "[]"));
              const u = arr[0];
              setAuthListLabel(u ? `✅ ${u.userName} 已登录` : "❌ 未登录（点右侧更换用户）");
            } catch { setAuthListLabel("❌ 解析失败"); }
          } }, authListLabel || "登录状态"),
          h("button", { class: "btn", style: { fontSize: 12 }, onClick: async () => {
            if (!confirm("重新登录将打开设备流授权（约 2 分钟内完成浏览器确认）。继续？")) return;
            setUserAuth("授权中…（请在弹出的链接里完成确认）");
            const r = await api("/api/tools/user-auth-login", "POST", {});
            setUserAuth(r.httpOk && r.data && r.data.ok ? "✅ 重新登录成功" : "输出：" + String(r.data && (r.data.data || r.data.error)).replace(/\s+/g, " ").slice(0, 300));
          } }, userAuth || "更换用户"),
        ),
      ),
      h("div", { class: "card" },
        h("div", { class: "dim", style: { marginBottom: 4, cursor: "pointer" }, onClick: (e) => {
            const box = e.target.nextElementSibling;
            if (box) box.style.display = box.style.display === "none" ? "block" : "none";
          } }, "飞书内置能力（每个 Agent 默认全部拥有，无需配置；点此查看明细）"),
        h("div", { style: { display: "none", fontSize: 12, lineHeight: "20px" } },
          h("div", null, "📋 会话列表 —— 查看本 bot 所在的全部会话（通讯录入口）"),
          h("div", null, "💬 聊天记录 —— 拉取某会话最近的聊天记录"),
          h("div", null, "✉️ 发消息 —— 以本 bot 身份发文本"),
          h("div", null, "🖼 发图片 —— 以本 bot 身份发本地图片"),
          h("div", null, "📝 发富文本 —— 多段落 + @人 + 标题"),
          h("div", null, "👥 群成员 —— 查群内成员 open_id（@ 人必用，防 @ 错人）"),
          h("div", null, "📖 Bot 目录 —— 全部 bot 的名单（bot 间互发用）"),
          h("div", null, "👤 传话(用户身份) —— 以你的名义给其他 bot 发消息（派活/回执闭环）"),
          h("div", null, "📄 建文档 / 读文档 —— 飞书文档创建与读取"),
        ),
      ),
      h("div", { class: "toolbar" },
        h("button", { class: "btn primary", onClick: openNew }, "+ 新增 Agent"),
        h("span", { class: "dim" }, agents.length + " 个 Agent"),
      ),
      h("div", { class: "grid" },
          agents.map(function (a) {
            return h("div", { class: "acard" + (a.enabled !== false ? "" : " off"), key: a.id },
              h("div", { class: "ahead" },
                h("span", null, a.displayName),
                (svcStatus[a.id] === 'installed')
                  ? h("span", { class: "tag ok", title: "已检测到该 agent 的 CLI，可用" }, "● 已安装")
                  : h("span", { class: "tag off", title: "未检测到该 agent 的 CLI" }, "○ 未安装"),
                h("span", { style: { flex: 1 } }),
                a.enabled !== false ? h("span", { class: "tag ok" }, "启用") : h("span", { class: "tag off" }, "停用"),
              ),
              h("div", { class: "line" }, h("span", { class: "line-k" }, "⚙️ 模型:"), h("b", null, modelLabel(a))),
              h("div", { class: "line" }, h("span", { class: "line-k" }, "☁️ Provider:"), h("b", null, providerName(a))),
              h("div", { class: "line" }, h("span", { class: "line-k" }, "🔌 MCP:"),
                (a.mcps || []).length ? a.mcps.map(function (m) { return h("span", { class: "tag", key: m }, m); }) : h("span", null, "无"),
              ),
              h("div", { class: "line" }, h("span", { class: "line-k" }, "🧩 内建:"),
                caps.vision ? h("span", { class: "tag ok" }, "👁 看图") : null,
                caps.speech ? h("span", { class: "tag ok" }, "🗣 语音") : null,
                !caps.vision && !caps.speech ? h("span", null, "无") : null,
              ),
              h("div", { class: "line" }, h("span", { class: "line-k" }, "🔢 端口:"), h("b", null, a.port)),
              h("div", { class: "line" }, h("span", { class: "line-k" }, "📁 工作区:"), h("b", null, a.workdir || "—")),
              h("div", { class: "actions" },
                h("button", { class: "btn primary", onClick: () => openEdit(a) }, "编辑"),
                h("button", { class: "btn warn", onClick: () => restartAgent(a.id), disabled: restarting === a.id }, restarting === a.id ? "重启中…" : "重启服务"),
              ),
            );
          }),
      ),
      agents.length === 0 ? h("div", { class: "card" }, h("div", { class: "dim" }, "还没有 Agent，点「+ 新增 Agent」创建。")) : null,

      editAgent ? h(AgentModal, {
        agent: isNew ? null : editAgent,
        providers: store.providers,
        mcps: store.mcps,
        onClose: () => setEditAgent(null),
        onDelete: function (a) {
          if (!window.confirm("确认删除 Agent " + (a.displayName || a.id) + "? 删除后此 Agent 不再运行。")) return;
          setEditAgent(null);
          api("/api/agents/" + encodeURIComponent(a.id), "DELETE").then(function (r) {
            if (!r.ok) setErr("删除失败: " + (r.data?.error || ""));
            load();
          });
        },
        onSaved: function () { setEditAgent(null); load(); },
      }) : null,
    );
  }

  render(h(App, null), document.getElementById("root"));
})();