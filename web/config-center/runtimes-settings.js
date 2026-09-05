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
    const { rt, store, onChanged } = props;
    const [path, setPath] = useState(rt.configured || (rt.kind === "service" ? (rt.resolvedPath || "") : ""));   // CLI 路径 / 服务地址
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState("");
    const [err, setErr] = useState(null);
    const pickerRef = {};

    // 启动参数：envMeta = 每键【真实生效值】（覆盖 > 实际解析 > provider 内部默认）。
    // secret=掩码显示（未改动不落覆盖）；readonly=随 Agent 上下文自动注入（纯展示行）。
    // 全部框直接填好真实值，无空白框（老大要求：显示真实配置供学习参观）。
    const initEnv = rt.env || {};
    const tpl = rt.envTpl || {};
    const flags = rt.envFlags || [];
    const labels = rt.envLabels || {};
    const meta = rt.envMeta || null;
    const keys = meta ? Object.keys(meta) : Object.keys(tpl);
    const [envValues, setEnvValues] = useState(function () {
      const v = {};
      for (const k of keys) {
        v[k] = meta ? meta[k].value : (initEnv[k] !== undefined ? initEnv[k] : (tpl[k] || ""));
      }
      return v;
    });
    const hasParams = keys.length > 0;

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
      // 穿透启动参数：readonly 键（跟随 Agent）跳过；secret 键掩码未改动跳过；其余 = 当前输入值（空 = 剔除覆盖回默认）
      const envBody = {};
      for (const k of keys) {
        const m = meta ? meta[k] : null;
        if (m && m.readonly) continue;                                   // 跟随 Agent 自动注入，不落覆盖
        if (m && m.secret && envValues[k] === m.value) continue;         // 掩码未改动 = 保持凭证层/默认
        if (flags.includes(k)) envBody[k] = envValues[k] ? envValues[k] : "";
        else envBody[k] = envValues[k] !== undefined ? envValues[k] : "";
      }
      if (rt.kind === "service" && rt.envKey) envBody[rt.envKey] = path; // 服务地址穿透给 agent 配置
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
        rt.kind === "service"
          ? (rt.detected ? h("span", { class: "tag ok" }, "✓ 服务在线") : h("span", { class: "tag err" }, "✗ 服务未响应"))
          : (rt.detected ? h("span", { class: "tag ok" }, "✓ 已检测到 CLI") : h("span", { class: "tag err" }, "✗ 未检测到")),
        path && path !== rt.resolvedPath ? h("span", { class: "tag info" }, "自定义") : null,
      ),
      rt.kind === "service" ? [
        // 服务型运行时: 服务地址可编辑 (存 cliPath + 穿透 env), 在线探测, 当前生效模型
        h("div", { class: "row kv" }, h("span", { class: "k" }, "服务地址:"),
          h("input", { type: "text", value: path, placeholder: rt.resolvedPath || "http://127.0.0.1:8001",
            onInput: function (e) { setPath(e.target.value); setSaved(""); setErr(null); },
            style: { minWidth: 260 } })),
        rt.activeModel ? h("div", { class: "row kv" }, h("span", { class: "k" }, "当前生效模型:"),
          h("span", { class: "v" }, h("b", null, rt.activeModel), h("span", { class: "dim" }, "（配置中心推送 · DeepTutor 设置内可切回）"))) : null,
      ] : [
        h("div", { class: "row kv" }, h("span", { class: "k" }, "对接 CLI:"),
          h("span", { class: "v" }, path || rt.resolvedPath || "—"),
          h("button", { class: "btn", onClick: openPicker }, "📁 浏览"),
          h("input", { ref: function (n) { pickerRef.current = n; }, type: "file", style: { display: "none" },
            accept: ".exe,.cmd,.bat,.cjs,.js,.ps1,.py", onChange: onFileChosen })),
      ],
      !rt.detected && rt.install ? h("div", { class: "row kv" }, h("span", { class: "k" }, "安装提示:"),
        h("span", { class: "v" }, rt.install)) : null,
      hasParams ? h("div", { class: "env-box" },
        h("div", { class: "env-title" }, "启动参数（框内为当前真实生效值；改动后保存自动重启生效）"),
        keys.map(function (k) {
          const isFlag = flags.includes(k);
          const label = labels[k] || k;
          const m = meta ? meta[k] : null;
          const noteEl = (m && m.note) ? h("span", { class: "dim", style: { fontSize: 11, marginLeft: 6 } }, m.note) : null;
          if (m && m.readonly) {
            // 配置中心自动管理 / 跟随 Agent 上下文：微微灰色、不可选（真实生效值展示）
            return h("div", { class: "row kv", key: k },
              h("span", { class: "k" }, label),
              h("input", { type: "text", value: envValues[k] || "（自动）", readOnly: true, disabled: true, tabIndex: -1,
                style: { minWidth: 260, background: "#f4f6f8", color: "#9aa2ad",
                         border: "1px solid #f0f2f5", cursor: "default",
                         userSelect: "none", WebkitUserSelect: "none", MozUserSelect: "none" } }),
              noteEl);
          }
          if (isFlag) {
            return h("div", { class: "row kv", key: k },
              h("span", { class: "k" }, label),
              h(Switch, { checked: !!envValues[k], onChange: function () { setEnvValues(Object.assign({}, envValues, { [k]: envValues[k] ? "" : (tpl[k] || "1") })); setSaved(""); setErr(null); } }),
              noteEl);
          }
          return h("div", { class: "row kv", key: k },
            h("span", { class: "k" }, label),
            h("input", { type: "text", value: envValues[k] || "", placeholder: tpl[k] || "",
              onInput: function (e) { setEnvValues(Object.assign({}, envValues, { [k]: e.target.value })); setSaved(""); setErr(null); },
              style: { minWidth: 260 } }),
            noteEl);
        }),
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
        "每个 runtime 的启动参数已预设正确默认值（装上对应 CLI 即可不报错启动），可在此微调。改完点「保存并应用」即自动重启对应 Agent 生效。"),
      runtimes.map(function (rt) { return h(RuntimeCard, { rt: rt, store: store, key: rt.runtime, onChanged: load }); }),
    );
  }

  render(h(App, null), document.getElementById("root"));
})();
