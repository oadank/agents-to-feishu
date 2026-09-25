/* 独立 React(pReact) 配置页：一页两部分 —— ① ⚡ 提示词优化(/p) ② 副驾回复预选(/de)。
   两块各自一套模型，全部走本仓引擎，不依赖 dsh。接口 /api/prompt-optimize 与 /api/de/test。 */
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
  const num = (v, dft) => { const n = Number(v); return Number.isFinite(n) && v !== "" ? n : dft; };

  /** 一套模型配置的行：地址/密钥/模型（可拉列表选）/温度/上限/思考开关 */
  function LlmForm(props) {
    const llm = props.llm;
    const [models, setModels] = useState(null);
    const [listing, setListing] = useState(false);
    const [lerr, setLerr] = useState("");
    const set = (k, v) => props.onChange({ ...llm, [k]: v });
    async function pull() {
      setListing(true); setLerr(""); setModels(null);
      const r = await api("/api/llm-models", "POST", { baseUrl: llm.baseUrl, apiKey: llm.apiKey });
      setListing(false);
      if (r.data && r.data.ok) { setModels(r.data.models || []); if (!(r.data.models || []).length) setLerr("这个 key 底下列表为空"); }
      else setLerr((r.data && r.data.error) || "拉取失败");
    }
    return h("div", { class: "row" },
      h("label", { class: "field" }, "接口地址 (OpenAI 兼容)",
        h("input", { type: "text", value: llm.baseUrl, placeholder: "https://api.deepseek.com/v1", onInput: (e) => set("baseUrl", e.target.value) })),
      h("label", { class: "field" }, "API Key",
        h("input", { type: "password", value: llm.apiKey, placeholder: "sk-…", onInput: (e) => set("apiKey", e.target.value) })),
      h("label", { class: "field" }, "模型（可手填，也可拉列表挑）",
        h("div", { style: { display: "flex", gap: 6 } },
          h("input", { type: "text", value: llm.model, placeholder: "deepseek-chat", style: { flex: 1 }, onInput: (e) => set("model", e.target.value) }),
          h("button", { class: "btn", type: "button", onClick: pull, disabled: listing }, listing ? "拉取中…" : "拉列表"),
        ),
        models ? h("select", {
          style: { marginTop: 4, width: "100%" },
          onChange: (e) => { if (e.target.value) set("model", e.target.value); },
          value: "",
        }, h("option", { value: "" }, `选择模型（${models.length} 个）`), models.map((m) => h("option", { key: m, value: m }, m))) : null,
        lerr ? h("span", { class: "err" }, lerr) : null,
      ),
      h("label", { class: "field", style: { maxWidth: 90 } }, "温度",
        h("input", { type: "number", step: "0.05", min: "0", max: "2", value: llm.temperature ?? "", onInput: (e) => set("temperature", e.target.value === "" ? undefined : num(e.target.value, 0.7)) })),
      h("label", { class: "field", style: { maxWidth: 110 } }, "最大 token",
        h("input", { type: "number", step: "50", min: "50", max: "8000", value: llm.maxTokens ?? "", onInput: (e) => set("maxTokens", e.target.value === "" ? undefined : num(e.target.value, 900)) })),
      h("label", { class: "field", style: { maxWidth: 130 } }, "深度思考",
        h("select", { value: llm.thinking || "default", onChange: (e) => set("thinking", e.target.value) },
          h("option", { value: "default" }, "跟着模型"),
          h("option", { value: "disabled" }, "关闭（快，实测 3.0s→0.8s）")),
        h("span", { class: "dim" }, "仅对 DeepSeek 生效")),
    );
  }

  function App() {
    const [po, setPo] = useState(null);
    const [de, setDe] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(null);
    const [err, setErr] = useState("");
    const [testText, setTestText] = useState("");
    const [optimized, setOptimized] = useState("");
    const [testing, setTesting] = useState(false);
    const [deIn, setDeIn] = useState("我: 那个截断的问题修好了吗\n助手: 改了 max_tokens，重启排好了\n");
    const [deRun, setDeRun] = useState(null);
    const [deTesting, setDeTesting] = useState(false);

    useEffect(function () {
      let dead = false;
      (async function () {
        const r = await api("/api/prompt-optimize");
        if (!dead) {
          if (r.httpOk) { setPo(r.data.promptOptimize); setDe(r.data.de); setErr(""); }
          else setErr("加载失败: " + ((r.data && r.data.error) || ""));
          setLoading(false);
        }
      })();
      return function () { dead = true; };
    }, []);

    async function save() {
      setSaving(true); setErr(null); setSaved(null);
      const r = await api("/api/prompt-optimize", "PUT", { enabled: po.enabled, engine: po.engine, endpoint: po.endpoint, prefixes: po.prefixes, tierA: po.tierA, tierB: po.tierB, llm: po.llm, de });
      setSaving(false);
      if (r.ok) { setPo(r.data.promptOptimize); setDe(r.data.de); setSaved(true); }
      else { setErr((r.data && r.data.error) || "保存失败"); setSaved(false); }
    }
    async function runP() {
      if (!testText.trim()) { setErr("先在 /p 试写区里写点东西"); return; }
      setTesting(true); setOptimized(""); setErr("");
      const r = await api("/api/prompt-optimize/test", "POST", { text: testText });
      setTesting(false);
      if (r.data && r.data.ok) setOptimized(r.data.optimized || ""); else setErr("优化失败：" + ((r.data && r.data.error) || ""));
    }
    function parseTurns(s) {
      return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = /^(我|用户|user)\s*[:：]\s*([\s\S]*)$/i.exec(l);
        if (m) return { role: "user", text: m[2] };
        const a = /^(助手|ai|assistant)\s*[:：]\s*([\s\S]*)$/i.exec(l);
        return a ? { role: "assistant", text: a[2] } : { role: "user", text: l };
      });
    }
    async function runDe() {
      const turns = parseTurns(deIn);
      if (turns.length < 1) { setErr("先在 /de 试跑区写几行对话（我: … / 助手: …）"); return; }
      setDeTesting(true); setDeRun(null); setErr("");
      const r = await api("/api/de/test", "POST", { turns });
      setDeTesting(false);
      if (r.data && r.data.ok) setDeRun(r.data); else setErr("/de 试跑失败：" + ((r.data && r.data.error) || ""));
    }

    if (loading) return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载配置…")));
    if (!po || !de) return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "err" }, err || "配置读不到")));

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn", style: { fontSize: 12 }, onClick: () => { location.href = "./"; } }, "←"),
        " ⚡ 提示词优化 与 副驾回复预选",
      ),
      err ? h("div", { class: "card" }, h("div", { class: "err" }, err)) : null,
      saved ? h("div", { class: "card" }, h("div", { class: "ok" }, "✅ 已保存（bot 5 秒内自动生效，不用重启）")) : null,
      h("div", { class: "card" }, h("div", { class: "dim" },
        "这两块都跑在 agents-to-feishu 自己身上，模型各配各的，不依赖 dsh（dsh 挂了这里照样能用）。填完点最下面的保存。")),

      // ── 第一部分：/p 提示词优化 ──
      h("div", { class: "card" },
        h("h2", { style: { margin: "0 0 8px", fontSize: 15 } }, "第一部分 · 用户提示词优化（/p）"),
        h("div", { class: "row" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" } },
            h("span", { class: "dim" }, "启用"), h(Switch, { checked: po.enabled, onChange: () => setPo({ ...po, enabled: !po.enabled }) })),
          h("span", { class: "dim" }, po.enabled ? "开着：飞书里命中前缀就先精炼再干活" : "关着：前缀原样发给 agent"),
        ),
        h("div", { class: "row" },
          h("label", { class: "field" }, "触发前缀（逗号分隔）",
            h("input", { type: "text", value: po.prefixes, onInput: (e) => setPo({ ...po, prefixes: e.target.value }) })),
          h("label", { class: "field" }, "引擎",
            h("select", { value: po.engine || "local", onChange: (e) => setPo({ ...po, engine: e.target.value }) },
              h("option", { value: "local" }, "本仓引擎（不依赖 dsh）"),
              h("option", { value: "endpoint" }, "外部端点（高级/兼容旧配置）"))),
          (po.engine === "endpoint") ? h("label", { class: "field" }, "外部端点地址",
            h("input", { type: "text", value: po.endpoint, onInput: (e) => setPo({ ...po, endpoint: e.target.value }) })) : null,
        ),
        h("div", { class: "row" },
          h("label", { class: "dim" }, h("input", { type: "checkbox", checked: po.tierA !== false, onChange: () => setPo({ ...po, tierA: !(po.tierA !== false) }) }), " 沟通/指令类充分精炼"),
          h("label", { class: "dim" }, h("input", { type: "checkbox", checked: po.tierB !== false, onChange: () => setPo({ ...po, tierB: !(po.tierB !== false) }) }), " 内容产出类充分精炼"),
        ),
        h("div", { class: "dim", style: { margin: "4px 0" } }, "↓ /p 用的模型"),
        h(LlmForm, { llm: po.llm || {}, onChange: (llm) => setPo({ ...po, llm }) }),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onClick: runP, disabled: testing }, testing ? "精炼中…（最长 60 秒）" : "试一下"),
          h("span", { class: "dim" }, "试一下只跑本引擎，不发消息"),
        ),
        h("textarea", { rows: 3, value: testText, placeholder: "例：帮我看看这个表格，把重复的行删掉，然后按时间排序", onInput: (e) => { setTestText(e.target.value); setOptimized(""); } }),
        optimized ? h("div", null, h("div", { class: "dim", style: { marginTop: 8 } }, "精炼后："), h("div", { class: "out" }, optimized)) : null,
      ),

      // ── 第二部分：/de 副驾回复预选 ──
      h("div", { class: "card" },
        h("h2", { style: { margin: "0 0 8px", fontSize: 15 } }, "第二部分 · 自动出 3 条「用户回给 AI」的候选（/de）"),
        h("div", { class: "dim", style: { marginBottom: 6 } },
          "你在飞书发 /de：机器人读这个会话最近若干条 → 判断你此刻的局面 → 写 3 条可直接发给对面 AI 的话 → 出一张三选一卡片。点哪条，就用你的身份把那句话原文发回本会话（不加水印）。"),
        h("div", { class: "row" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "none" } },
            h("span", { class: "dim" }, "启用 /de"), h(Switch, { checked: de.enabled, onChange: () => setDe({ ...de, enabled: !de.enabled }) })),
          h("label", { class: "field", style: { maxWidth: 110 } }, "触发词",
            h("input", { type: "text", value: de.command, onInput: (e) => setDe({ ...de, command: e.target.value }) })),
          h("label", { class: "field", style: { maxWidth: 130 } }, "读最近几条",
            h("input", { type: "number", min: "4", max: "60", value: de.historyTurns, onInput: (e) => setDe({ ...de, historyTurns: num(e.target.value, 15) }) }),
            h("span", { class: "dim" }, "建议 10~15，太多费 token")),
          h("label", { class: "dim" }, h("input", { type: "checkbox", checked: de.blockRiskySend !== false, onChange: () => setDe({ ...de, blockRiskySend: !(de.blockRiskySend !== false) }) }), " 高风险不许一键直发"),
        ),
        h("div", { class: "row" },
          h("label", { class: "dim" }, h("input", { type: "checkbox", checked: !!de.useOpenmem, onChange: () => setDe({ ...de, useOpenmem: !de.useOpenmem }) }), " 顺带读 openmem 画像/记忆（可选增强，不是 dsh）")),
          de.useOpenmem ? h("label", { class: "field" }, "openmem 地址",
            h("input", { type: "text", value: de.openmemUrl, onInput: (e) => setDe({ ...de, openmemUrl: e.target.value }) })) : null,
        ),
        h("div", { class: "dim", style: { margin: "4px 0" } }, "↓ /de 起草三条候选用的模型（要写得像你说话）"),
        h(LlmForm, { llm: de.draft || {}, onChange: (draft) => setDe({ ...de, draft }) }),
        h("div", { class: "dim", style: { margin: "4px 0" } }, "↓ 判断局面与排序用的模型（留空地址 = 复用上面那个；想省钱可填个便宜快的）"),
        h(LlmForm, { llm: de.judge || {}, onChange: (judge) => setDe({ ...de, judge }) }),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onClick: runDe, disabled: deTesting }, deTesting ? "试跑中…（最多 45 秒）" : "试跑 /de"),
          h("span", { class: "dim" }, "试跑用下面这几行假对话，不发消息、不进会话"),
        ),
        h("textarea", { rows: 4, value: deIn, onInput: (e) => { setDeIn(e.target.value); setDeRun(null); } }),
        deRun ? h("div", null,
          h("div", { class: "dim", style: { marginTop: 8 } }, "判断：" + JSON.stringify(deRun.judge) + " ｜ " + deRun.context.note),
          deRun.candidates.map((c, i) => h("div", { class: "out", key: i, style: { marginTop: 6 } },
            `[${c.role || ("第" + (i + 1) + "条")}] 拟用 ${(c.p * 100).toFixed(0)}% — ${c.text}`)),
          (deRun.degraded && (deRun.degraded.judge || deRun.degraded.rank)) ? h("div", { class: "dim", style: { marginTop: 4 } }, "注：判断或排序这次没成，已按降级出稿") : null,
        ) : null,
      ),

      h("div", { class: "card" },
        h("div", { class: "row" },
          h("button", { class: "btn primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存全部"),
          h("span", { class: "dim" }, "保存即生效（bot 侧 5 秒缓存轮询），不用重启"),
        ),
      ),
      h("div", { class: "tip" },
        "配置落盘文件：config-store.json 的 promptOptimize 与 de 两段；改完点「保存全部」，bot 5 秒内读到新值，不用重启。",
        h("br"), "密钥只存在你本机这个文件里，页面用密码框显示，不会回传到任何远端。",
      ),
    );
  }

  render(h(App, null), document.getElementById("root"));
})();
