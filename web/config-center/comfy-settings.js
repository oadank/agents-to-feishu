/* 独立 React(pReact) 生图配置页 —— 迁移自 Vue 版，接口 /api/comfy/* */
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
  function loraLabel(t) {
    // lora 可能是 {name,strength} 或 [{name,strength},...]，只取文件名（去路径后缀 .safetensors）
    function short(l) {
      if (!l) return "";
      const n = typeof l === "string" ? l : (l.name || "");
      const base = n.replace(/\\/g, "/").split("/").pop() || n;
      return base.replace(/\.safetensors$/i, "");
    }
    const lo = t.lora;
    if (!lo) return "";
    const arr = Array.isArray(lo) ? lo : [lo];
    if (!arr.length) return "";
    const names = arr.map(short).filter(Boolean);
    return names.length ? " · lora=" + names.join(" + ") : "";
  }
  function Field(props, kid) {
    const children = kid !== undefined ? kid : props.children;
    return h("label", { class: "field" }, props.label, children);
  }
  function NumField(props) {
    return h("input", { type: "number", class: "inline-num", value: props.value, min: props.min, max: props.max, step: props.step, onInput: (e) => props.onChange(Number(e.target.value)) });
  }

  function App() {
    const [templates, setTemplates] = useState([]);
    const [template, setTemplate] = useState("");
    const [templateNote, setTemplateNote] = useState("");
    const [prompt, setPrompt] = useState("");
    const [width, setWidth] = useState(1024);
    const [height, setHeight] = useState(1024);
    const [seed, setSeed] = useState(-1);
    const [steps, setSteps] = useState(20);
    const [cfg, setCfg] = useState(7);
    const [denoise, setDenoise] = useState(1);
    const [loadingTpl, setLoadingTpl] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [runningMsg, setRunningMsg] = useState("");
    const [result, setResult] = useState(null);   // {task_id, type, t_total, template, xdn_file}
    const [resultText, setResultText] = useState("");
    const [err, setErr] = useState(null);

    async function loadTemplates() {
      setLoadingTpl(true);
      const r = await api("/api/comfy/templates");
      setLoadingTpl(false);
      if (r.ok && Array.isArray(r.data.templates)) {
        setTemplates(r.data.templates);
        if (!template && r.data.templates.length) setTemplate(r.data.templates[0].file);
        setTemplateNote("共 " + r.data.templates.length + " 个模板；带 ✓ 的可直接文生图，反推模板留空 prompt 自动反推");
      } else {
        setTemplateNote("加载模板失败: " + (r.data?.error || ""));
      }
    }
    useEffect(function () { loadTemplates(); }, []);

    function outputUrl(taskId) {
      return "/api/comfy/output/" + encodeURIComponent(taskId);
    }
    async function generate() {
      if (!prompt && !/反推/.test(template || "")) { setErr("请填写提示词（非反推模板）"); return; }
      setGenerating(true); setRunningMsg("生成中（跑 XDN 远程，可能需数十秒~几分钟）…"); setErr(null); setResult(null); setResultText("");
      const r = await api("/api/comfy/generate", "POST", {
        template: template || undefined, prompt, width, height, seed, steps, cfg, denoise,
      });
      setGenerating(false); setRunningMsg("");
      if (r.ok && r.data.ok) {
        const d = r.data;
        setResult(d);
        setResultText("task_id=" + d.task_id + " · type=" + d.type + " · t_total=" + d.t_total + "s" +
          (d.template ? "\ntemplate=" + d.template : "") +
          (d.xdn_file ? "\nxdn_file=" + d.xdn_file : ""));
      } else {
        setErr("生成失败: " + (r.data?.error || ""));
      }
    }

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " 🎨 生图",
        h("span", { class: "dim", style: { fontWeight: 400, fontSize: 12 } }, "内建 /api/comfy/*，同时暴露为 MCP：/mcp/comfy 供 agent 勾选"),
      ),

      h("div", { class: "cols" },
        h("div", { class: "card" },
          h("div", { class: "row" },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, width: "100%" } },
              h("select", { style: { flex: 1 }, value: template, onInput: (e) => setTemplate(e.target.value), placeholder: "选模板" },
                templates.map(function (t) { return h("option", { key: t.file, value: t.file }, (t.name || t.file) + loraLabel(t)); }),
              ),
              h("button", { class: "btn", onClick: loadTemplates, disabled: loadingTpl }, loadingTpl ? "刷新中…" : "刷新模板"),
            ),
          ),
          templateNote ? h("div", { class: "dim" }, templateNote) : null,
          h("div", { class: "row" }, Field({ label: "提示词" }, h("textarea", { rows: 4, value: prompt, onInput: (e) => setPrompt(e.target.value), placeholder: "英文/中文正向提示词（反推模板可留空自动反推）" }))),
          h("div", { class: "row" },
            h("span", { class: "dim", style: { flex: "none" } }, "尺寸"),
            h(NumField, { value: width, min: 256, max: 2048, step: 128, onChange: setWidth }),
            h("span", { style: { flex: "none" } }, "×"),
            h(NumField, { value: height, min: 256, max: 2048, step: 128, onChange: setHeight }),
          ),
          h("div", { class: "row" },
            h("span", { class: "dim", style: { flex: "none" } }, "种子"),
            h(NumField, { value: seed, min: -1, onChange: setSeed }),
            h("span", { class: "dim", style: { flex: "none" } }, "步数"),
            h(NumField, { value: steps, min: 1, max: 60, onChange: setSteps }),
            h("span", { class: "dim", style: { flex: "none" } }, "CFG"),
            h(NumField, { value: cfg, min: 0, max: 20, step: 0.5, onChange: setCfg }),
            h("span", { class: "dim", style: { flex: "none" } }, "Denoise"),
            h(NumField, { value: denoise, min: 0, max: 1, step: 0.1, onChange: setDenoise }),
          ),
          h("div", { class: "row" },
            h("button", { class: "btn primary", onClick: generate, disabled: generating }, generating ? "生成中…" : "生成"),
            generating && runningMsg ? h("span", { class: "dim" }, h("span", { class: "spin" }), " " + runningMsg) : null,
          ),
        ),

        h("div", { class: "card" },
          h("div", { style: { fontWeight: 600, fontSize: 14, marginBottom: 8 } }, "生成结果"),
          err ? h("div", { class: "err" }, err) : null,
          result ? h("div", null,
            result.type === "video" ? h("div", { class: "dim" }, "视频产物已生成（type=video），task_id=《" + result.task_id + "》") :
              h("img", { class: "preview", src: outputUrl(result.task_id), alt: "生成结果" }),
            resultText ? h("div", { style: { marginTop: 8 } }, h("pre", { class: "meta" }, resultText)) : null,
          ) : h("div", { class: "dim" }, "尚未生成。填好参数点「生成」，结果图和元信息显示在这里。"),
        ),
      ),

      h("div", { class: "dim", style: { textAlign: "center", padding: "4px 0 16px" } }, "生成走 XDN 远程引擎；输出代理 /api/comfy/output/:task_id"),
    );
  }

  render(h(App, null), document.getElementById("root"));
})();