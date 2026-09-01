/* 独立 React(pReact) 看图配置页 —— 迁移自 Vue 版，接口 /api/vision/* */
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
  function Switch(props) {
    return h("label", { class: "switch", title: props.title || "" },
      h("input", { type: "checkbox", checked: !!props.checked, onChange: props.onChange }),
      h("span", { class: "slider" }),
    );
  }
  function Segment(props) {
    return h("div", { class: "segment" },
      props.options.map(function (o) {
        return h("button", { key: o[0], class: props.value === o[0] ? "active" : "", onClick: () => props.onChange(o[0]) }, o[1]);
      }),
    );
  }
  function SecretInput(props) {
    const [show, setShow] = useState(false);
    return h("div", { style: { display: "flex", gap: 6 } },
      h("input", { type: show ? "text" : "password", value: props.value, onInput: props.onInput, placeholder: props.placeholder }),
      h("button", { type: "button", class: "btn", style: { flex: "none" }, onClick: () => setShow(!show) }, show ? "🙈" : "👁"),
    );
  }

  function App() {
    const [v, setV] = useState(null);   // {enabled,provider,baseUrl,apiKey,model,timeoutMs,prompts}
    const [src, setSrc] = useState("sample"); // sample | local
    const [localPath, setLocalPath] = useState("");
    const [task, setTask] = useState("describe");
    const [extra, setExtra] = useState("");
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState("");
    const [saved, setSaved] = useState(null);
    const [err, setErr] = useState(null);
    const [zoom, setZoom] = useState(false); // 点击样例图放大

    async function load() {
      const r = await api("/api/vision");
      if (r.httpOk) setV(r.data.vision || {});
      else setErr("加载失败: " + (r.data?.error || ""));
    }
    useEffect(function () { load(); }, []);

    function upd(patch) { setV(Object.assign({}, v, patch)); setErr(null); setSaved(null); }
    async function save() {
      const r = await api("/api/vision", "PUT", v || {});
      if (r.ok) { setSaved(true); setErr(null); }
      else { setErr(r.data?.error || "保存失败"); setSaved(false); }
    }
    async function test() {
      const imagePath = src === "local" ? String(localPath || "").trim() : "__sample__";
      if (!imagePath) { setResult("⚠ 请填写本地图片路径"); return; }
      setTesting(true); setResult("");
      const r = await api("/api/vision/test", "POST", { imagePath, task, extra });
      setTesting(false);
      if (r.ok && r.data.ok && r.data.text) { setResult("✅ 识别成功 (" + (r.data.model || "") + ")\n\n" + r.data.text); }
      else { setResult("❌ " + (r.data?.error || r.data?.text || "识别失败")); }
    }

    if (!v) {
      return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载看图配置…")));
    }

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " 👁 看图配置",
      ),
      err ? h("div", { class: "card" }, h("div", { class: "err" }, err)) : null,
      saved ? h("div", { class: "card" }, h("div", { class: "ok" }, "✅ 看图配置已保存")) : null,

      h("div", { class: "cols" },
        h("div", { class: "card" },
          h("div", { class: "row" },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" } },
              h("span", { class: "dim" }, "启用"),
              h(Switch, { checked: v.enabled, onChange: () => upd({ enabled: !v.enabled }) }),
            ),
            Field({ label: "后端 Provider" }, h("select", { value: v.provider || "online", onInput: (e) => upd({ provider: e.target.value }) },
              [["online", "online（OpenAI 兼容在线）"], ["local", "local（本机 Ollama）"]].map(function (p) { return h("option", { value: p[0] }, p[1]); }))),
          ),
          h("div", { class: "row" },
            Field({ label: "BaseURL" }, h("input", { type: "text", value: v.baseUrl || "", onInput: (e) => upd({ baseUrl: e.target.value }), placeholder: "https://apihub.agnes-ai.cn/v1" })),
            Field({ label: "视觉模型" }, h("input", { type: "text", value: v.model || "", onInput: (e) => upd({ model: e.target.value }), placeholder: "agnes-2.5-flash（免费，反应快）" })),
          ),
          h("div", { class: "row" },
            Field({ label: "API Key" }, h(SecretInput, { value: v.apiKey || "", onInput: (e) => upd({ apiKey: e.target.value }), placeholder: "留空则读取凭证文件 VISION_API_KEY" })),
            Field({ label: "超时(ms)" }, h("input", { type: "number", value: v.timeoutMs || 240000, onInput: (e) => upd({ timeoutMs: Number(e.target.value) || 240000 }) })),
          ),
          h("div", { class: "row" }, h("button", { class: "btn primary", onClick: save }, "保存配置")),
        ),

        h("div", { class: "card" },
          h("div", { style: { fontWeight: 600, fontSize: 14, marginBottom: 8 } }, "测试看图"),
          h("div", { class: "row" },
            h("span", { class: "dim", style: { flex: "none" } }, "图片来源"),
            h(Segment, { value: src, onChange: setSrc, options: [["sample", "内置样例图"], ["local", "本地图片"]] }),
          ),
          src === "local" ? h("div", { class: "row" }, Field({ label: "图片路径" }, h("input", { type: "text", value: localPath, onInput: (e) => setLocalPath(e.target.value), placeholder: "本机图片绝对路径" }))) : null,
          src === "sample" ? h("div", { class: "row" },
            h("div", { style: { width: "100%" } },
              h("img", { class: "preview", src: "/api/vision/sample-image", style: { maxHeight: 220, cursor: "zoom-in" }, title: "点击放大", onClick: function () { setZoom(true); } }),
              h("div", { class: "dim", style: { marginTop: 4 } }, "项目内置样例图（点击可放大）"),
            ),
          ) : h("div", { class: "dim" }, "本地图片暂不预览，直接点「测试」调用看图"),
          h("div", { class: "divider" }),
          h("div", { class: "row" },
            h("span", { class: "dim", style: { flex: "none" } }, "任务"),
            h(Segment, { value: task, onChange: setTask, options: [["describe", "描述"], ["reverse", "反推提示词"], ["text", "提取文字"]] }),
          ),
          h("div", { class: "row" }, Field({ label: "附加要求" }, h("input", { type: "text", value: extra, onInput: (e) => setExtra(e.target.value), placeholder: "可选" }))),
          h("div", { class: "row" }, h("button", { class: "btn primary", onClick: test, disabled: testing }, testing ? "测试中…" : "测试")),
          result ? h("div", { class: "row" }, h("div", { style: { width: "100%" } }, h("pre", { class: "result" }, result))) : null,
        ),
      ),

      h("div", { class: "dim", style: { textAlign: "center", padding: "4px 0 16px" } }, "保存即写 config-store；测试调用内建 look_image"),

      zoom ? h("div", {
        class: "img-viewer",
        style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, cursor: "zoom-out" },
        onClick: function () { setZoom(false); },
      },
        h("img", { src: "/api/vision/sample-image", style: { maxWidth: "92vw", maxHeight: "88vh", borderRadius: 6, boxShadow: "0 6px 30px rgba(0,0,0,.6)" } }),
      ) : null,
    );
  }

  render(h(App, null), document.getElementById("root"));
})();