/* 运行时管理页 —— 每个 Agent 真实对接的 CLI 程序/路径 + 检测状态 + 启动参数开关（自动推导 + 可点开关） */
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
    const { rt, store, onChanged } = props;
    const [path, setPath] = useState(rt.configured || "");   // 自定义 CLI 路径（浏览选；空=系统探测）
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState("");
    const [err, setErr] = useState(null);
    const pickerRef = {};

    // 开关状态：初始化自当前生效 env（rt.env），可点
    const initEnv = rt.env || {};
    const [permOn, setPermOn] = useState(!!initEnv.ANTHROPIC_PERMISSION_MODE && initEnv.ANTHROPIC_PERMISSION_MODE !== '');
    const [silenceOn, setSilenceOn] = useState(initEnv.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT === '1');

    // 只对该 runtime 有可点开关的（claude）；其他 runtime 无特殊启动参数
    const hasToggles = rt.runtime === 'claude';

    function openPicker() {
      if (window.showOpenFilePicker) {
        window.showOpenFilePicker({ types: [{ description: "可执行/脚本文件",
          accept: { "application/octet-stream": [".exe", ".cmd", ".bat", ".cjs", ".js", ".ps1", ".py"] } }] })
          .then(function (handles) { if (handles && handles[0]) handles[0].getFile().then(function (f) { setPath(f.path || f.webkitRelativePath || f.name || ""); setSaved(""); setErr(null); }); },
               function () { /* 取消 */ });
      } else if (pickerRef.current) pickerRef.current.click();
    }
    function onFileChosen(e) {
      const f = e.target && e.target.files && e.target.files[0];
      if (f) { setPath(f.path || f.webkitRelativePath || f.name || ""); setSaved(""); setErr(null); }
      e.target.value = "";
    }

    async function saveAll() {
      setSaving(true); setSaved(""); setErr(null);
      // 这里只写"启动参数开关"（claude 的权限/告警两个），
      // baseURL / 模型 / 上下文 由后端 render 自动注入（取自 Agent 分配置），不在运行时页手填。
      var envBody = {};
      if (hasToggles) {
        envBody.ANTHROPIC_PERMISSION_MODE = permOn ? 'bypassPermissions' : '';
        envBody.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = silenceOn ? '1' : '';
        // 清掉旧版可能残留的手填 env（避免覆盖 render 自动注入）
        envBody.ANTHROPIC_BASE_URL = '';
        envBody.ANTHROPIC_MODEL = '';
        envBody.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '';
      }
      // 保存（写 config-open runtimeEnv/cliPath）
      const r = await api("/api/runtimes", "POST", { runtime: rt.runtime, cliPath: path, env: envBody });
      if (!r.ok) { setSaving(false); setErr(r.data?.error || "保存失败"); return; }
      // 穿透应用：对该 runtime 所有 agent 重新生成配置+重启，让改动真正生效
      const rr = await api("/api/agents-by-runtime/" + encodeURIComponent(rt.runtime), "POST", {});
      setSaving(false);
      if (rr.ok) setSaved("已保存并应用 ✓ " + ((rr.data.applied || []).join(", ")) + " 已重启生效");
      else setErr("保存成功，但应用重启失败: " + (rr.data?.error || ""));
      onChanged();
    }

    return h("div", { class: "card" },
      h("div", { class: "rthead" },
        h("span", { class: "rt-name" }, rt.display),
        rt.detected ? h("span", { class: "tag ok" }, "✓ 已检测到 CLI") : h("span", { class: "tag err" }, "✗ 未检测到"),
        path && path !== rt.resolvedPath ? h("span", { class: "tag info" }, "自定义路径") : null,
      ),
      h("div", { class: "row kv" }, h("span", { class: "k" }, "对接 CLI:"),
        h("span", { class: "v" }, path || rt.resolvedPath || "—"),
        h("button", { class: "btn", onClick: openPicker }, "📁 浏览"),
        h("input", { ref: function (n) { pickerRef.current = n; }, type: "file", style: { display: "none" },
          accept: ".exe,.cmd,.bat,.cjs,.js,.ps1,.py", onChange: onFileChosen })),
      hasToggles ? h("div", { class: "env-box" },
        h("div", { class: "env-title" }, "启动参数（打勾 = 启用，保存后自动重启生效）"),
        h("div", { class: "row kv" },
          h("span", { class: "k" }, "自动跳过审批 / 最大权限运行"),
          h(Switch, { checked: permOn, onChange: function () { setPermOn(!permOn); setSaved(""); setErr(null); } })),
        h("div", { class: "row kv" },
          h("span", { class: "k" }, "消除未知模型告警"),
          h(Switch, { checked: silenceOn, onChange: function () { setSilenceOn(!silenceOn); setSaved(""); setErr(null); } })),
      ) : null,
      h("div", { class: "divider" }),
      h("div", { class: "row" },
        h("button", { class: "btn primary", disabled: saving, onClick: saveAll },
          saving ? "保存应用中…" : "保存并应用（自动重启）"),
      ),
      saved ? h("div", { class: "ok", style: { marginTop: 6 } }, saved) : null,
      err ? h("div", { class: "err", style: { marginTop: 6 } }, err) : null,
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
        "这里只管「对接哪个 CLI」和「启动参数开关」。改完点「保存并应用」即自动重启对应 Agent 生效。"),
      runtimes.map(function (rt) { return h(RuntimeCard, { rt: rt, store: store, key: rt.runtime, onChanged: load }); }),
    );
  }

  render(h(App, null), document.getElementById("root"));
})();
