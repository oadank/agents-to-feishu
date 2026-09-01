/* 独立 React(pReact) 语音设置页 —— 照 dsh-input-tools 布局交互，接口映射 agents-to-feishu /api/speech/* */
(function () {
  "use strict";
  const { h, render } = preact;
  const { useState, useEffect, useRef } = preactHooks;
  /* 是否在配置中心 iframe 内（内嵌时不显示"返回"箭头，防止 location.href 把 iframe 自己跳成主页造成嵌套） */
  const inIframe = (function () { try { return window.self !== window.top; } catch { return true; } })();

  const ENGINE_ORDER = ["edge", "xiaomi", "voicedesign", "voiceclone", "local", "audio8", "ali"];
  const ENGINE_LABEL = {
    edge: "微软 Edge（免费）", xiaomi: "小米 MiMo 预置", voicedesign: "小米·语音设计",
    voiceclone: "小米·语音克隆", local: "本地 MeloTTS", audio8: "Audio8 本地克隆", ali: "阿里 qwen3-tts",
  };
  const XIAOMI_VOICES = ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
  const AI_AGE_LABELS = { infant: "婴儿感", child: "幼儿感", teen: "少年感", young: "青年感", middle: "中年感", old: "老年感" };
  const DEFAULT_TTS_TEXT = "你好，这是一段语音试听。";
  const BUNDLED_CLONE_ID = "8da38fcc-b041-4f5b-86b9-901956016f89"; // 自带默认样本（小团团）：禁删

  async function api(url, method, body) {
    const opt = { method: method || "GET" };
    if (body !== undefined) { opt.headers = { "content-type": "application/json" }; opt.body = JSON.stringify(body); }
    try {
      const r = await fetch(url, opt);
      let d = {}; try { d = await r.json(); } catch {}
      return { httpOk: r.ok, ok: r.ok && d.ok !== false, data: d };
    } catch (e) { return { httpOk: false, ok: false, data: { error: String(e) } }; }
  }

  /* 兼容两种调用：Field({label}, child) 函数式与 h(Field, {label}, child) 组件式 */
  function Field(props, kid) {
    const children = kid !== undefined ? kid : props.children;
    return h("label", { class: "field" }, props.label, children);
  }
  // 密钥明文/密文
  function SecretInput(props) {
    const [show, setShow] = useState(false);
    return h("div", { style: { display: "flex", gap: 6 } },
      h("input", { type: show ? "text" : "password", value: props.value, onInput: props.onInput, placeholder: props.placeholder }),
      h("button", { type: "button", class: "btn", style: { flex: "none" }, onClick: () => setShow(!show) }, show ? "🙈" : "👁"),
    );
  }
  // 折叠卡片
  function Card(props) {
    const [open, setOpen] = useState(props.defaultOpen !== false);
    return h("div", { class: "card" },
      h("div", { class: "card-header", onClick: () => setOpen(!open) },
        h("span", { class: "title" }, props.title),
        h("span", { class: "chev" }, open ? "收起 ▴" : "展开 ▾"),
      ),
      open ? h("div", { class: "map" }, props.children) : null,
    );
  }

  function App() {
    const [config, setConfig] = useState(null);
    const [vdSamples, setVdSamples] = useState([]);
    // 初始引擎：null = 待配置加载后按 tts.defaultEngine 定（无则 edge）
    const [activeEngine, setActiveEngine] = useState(null);
    // 隐形试听：previewing=正在播放的 tag；previewRef=当前 Audio；tag 用于「再点=停止」
    const [previewing, setPreviewing] = useState(null);
    const previewRef = useRef(null);
    const previewTagRef = useRef(null);
    // 克隆
    const [cloneName, setCloneName] = useState("");
    const [cloneContext, setCloneContext] = useState("");
    const [cloneAddMsg, setCloneAddMsg] = useState(null);
    const [addingClone, setAddingClone] = useState(false);
    const cloneFileRef = useRef(null);
    // 试听文本
    const [ttsText, setTtsText] = useState(DEFAULT_TTS_TEXT);
    // 引擎参数编辑态：{ local: true } = 该引擎的 URL/CMD 正在改；其余时间输入框只读，防止手滑改坏路径
    const [editing, setEditing] = useState({});
    // Audio8 已注册音色（服务端读 voices 目录）
    const [a8Voices, setA8Voices] = useState([]);
    const [a8Registering, setA8Registering] = useState(false);
    const [a8Msg, setA8Msg] = useState(null);
    const a8FileRef = useRef(null);
    const [a8Name, setA8Name] = useState("");
    const [a8Text, setA8Text] = useState("");
    const [a8Busy, setA8Busy] = useState(null);      // 正在实时生成克隆声的音色名（生成中禁用按钮）
    const [a8CloneMsg, setA8CloneMsg] = useState(null);
    // 语音设计自定义
    const [vdCustomText, setVdCustomText] = useState("年轻的女性声音，普通话标准，语速适中");
    const [vdReadText, setVdReadText] = useState(DEFAULT_TTS_TEXT);
    // ASR
    const [asrSample, setAsrSample] = useState(null); // {url, base64}
    const [asrResult, setAsrResult] = useState(null);
    const [previewErr, setPreviewErr] = useState(null);
    const [previewDur, setPreviewDur] = useState(null); // 试听生成用时的实时秒表（按下即开始跳，出音频即停）
    const durTickerRef = useRef(null);

    /* 隐形播放：new Audio 直接播（页面不摆可见播放条），再点=停止，与 input-tools 一致 */
    function playAudio(dataUrl, tag) {
      if (previewTagRef.current === tag && previewRef.current) {
        try { previewRef.current.pause(); } catch {}
        previewRef.current = null; previewTagRef.current = null; setPreviewing(null);
        return;
      }
      if (previewRef.current) { try { previewRef.current.pause(); } catch {} previewRef.current = null; }
      if (previewErr) setPreviewErr(null);
      const audio = new Audio(dataUrl);
      previewRef.current = audio; previewTagRef.current = tag; setPreviewing(tag);
      audio.onended = () => { if (previewTagRef.current === tag) { previewRef.current = null; previewTagRef.current = null; setPreviewing(null); stopDurTicker(); } };
      audio.onerror = () => { if (previewTagRef.current === tag) { previewRef.current = null; previewTagRef.current = null; setPreviewing(null); setPreviewErr("音频加载失败"); stopDurTicker(); } };
      audio.play().catch((e) => { if (previewTagRef.current === tag) { previewRef.current = null; previewTagRef.current = null; setPreviewing(null); setPreviewErr("播放失败: " + String(e && e.message || e)); stopDurTicker(); } });
      // 出音频就算生成完了，秒表停
      stopDurTicker();
    }

    /* 实时秒表：按下试听即开始跳，音频回来/播放完即停 */
    function startDurTicker() {
      stopDurTicker();
      const t0 = Date.now();
      setPreviewDur("0.0s");
      durTickerRef.current = setInterval(function () {
        const ms = Date.now() - t0;
        setPreviewDur(ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");
      }, 100);
    }
    function stopDurTicker() {
      if (durTickerRef.current) { clearInterval(durTickerRef.current); durTickerRef.current = null; }
    }

    /* 统一试听按钮：正在播放显示 ⏹（再点停止），否则 ▶ */
    function PlayBtn(tag, onClick, label) {
      const active = previewing === tag;
      return h("button", {
        type: "button", class: "btn" + (label && label.primary ? " primary" : ""),
        style: { flex: "none" },
        onClick: () => onClick(),
      }, active ? "⏹ 停止" : (label && label.full ? label.text : "▶ " + ((label && label.text) || "试听")));
    }

    /* 加载配置 + 示例 */
    useEffect(function () {
      let dead = false;
      (async function () {
        const r = await api("/api/speech");
        if (!dead && r.httpOk) {
          setConfig(r.data.speech);
          // 初始引擎跟随 tts.defaultEngine（如 voiceclone=小团团），无则 edge
          const def = ((r.data.speech.tts || {}).defaultEngine) || "edge";
          setActiveEngine(ENGINE_ORDER.includes(def) ? def : "edge");
        }
        const vd = await api("/api/speech/voice-design-samples");
        if (!dead) setVdSamples(vd.data.samples || []);
        const as = await api("/api/speech/asr-sample");
        if (!dead && as.ok) setAsrSample({ url: "data:" + (as.data.mediaType || "audio/wav") + ";base64," + as.data.data, base64: as.data.data });
        const a8 = await api("/api/speech/audio8/voices");
        if (!dead && a8.ok) setA8Voices(a8.data.voices || []);
      })();
      return function () { dead = true; if (previewRef.current) { try { previewRef.current.pause(); } catch {} } };
    }, []);

    if (!config) {
      return h("div", { class: "wrap" }, h("div", { class: "card" }, h("div", { class: "dim" }, "加载语音配置中…")));
    }

    const tts = config.tts || {};
    const asr = config.asr || {};
    // 是否有关键（小米 key，供语音设计/克隆）
    const hasMimoKey = !!(tts.xiaomi && tts.xiaomi.apiKey);
    const cloneSamples = (tts.voiceclone && tts.voiceclone.samples) || [];

    /* 保存当前引擎 patch（写回 config + PUT） */
    function patch(engine, obj) {
      const next = Object.assign({}, config, { tts: Object.assign({}, config.tts, { [engine]: Object.assign({}, (config.tts && config.tts[engine]) || {}, obj) }) });
      setConfig(next);
      (async function () { await api("/api/speech", "PUT", next); })();
      setPreviewErr(null);
    }
    /* 上传一段参考音频 → ASR 转写 → 服务端注册成 Audio8 音色 */
    async function registerAudio8Voice() {
      const f = a8FileRef.current && a8FileRef.current.files ? a8FileRef.current.files[0] : null;
      if (!f) { setA8Msg({ ok: false, text: "请选择音频文件" }); return; }
      const data = await new Promise(function (res, rej) {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result).split(",")[1] || "");
        rd.onerror = rej;
        rd.readAsDataURL(f);
      });
      setA8Registering(true); setA8Msg(null);
      const r = await api("/api/speech/audio8/register", "POST", {
        name: a8Name.trim() || f.name.replace(/\.(mp3|wav|m4a|ogg)$/i, ""),
        audioBase64: data, mediaType: f.type || "audio/wav", text: a8Text.trim(),
      });
      setA8Registering(false);
      if (r.ok) {
        const v = await api("/api/speech/audio8/voices");
        if (v.ok) setA8Voices(v.data.voices || []);
        const s = await api("/api/speech"); if (s.httpOk) setConfig(s.data.speech);
        setA8Msg({ ok: true, text: "已注册音色「" + (r.data.voice || "") + "」" + (r.data.text ? "（逐字：" + r.data.text.slice(0, 30) + "…）" : "") });
        setA8Name(""); setA8Text("");
        if (a8FileRef.current) a8FileRef.current.value = "";
      } else {
        setA8Msg({ ok: false, text: r.data.error || "注册失败" });
      }
    }

    /* [2026-09-01] Audio8 卡照「语音克隆」模板：原音可点播 + 克隆声每次实时生成 + 可删自己注册的音色 */
    async function playAudio8Source(name) {
      const r = await api("/api/speech/audio8/source?voice=" + encodeURIComponent(name));
      if (r.ok) playAudio("data:" + (r.data.mediaType || "audio/wav") + ";base64," + r.data.data, "a8-src:" + name);
      else setPreviewErr(r.data.error || "读取原音失败");
    }
    /** 克隆声：点一次现算一次（服务端不落盘不缓存，测试垃圾不会堆积）；秒表按下即跳、出声即停 */
    async function playAudio8Clone(name) {
      if (a8Busy) return;
      setA8CloneMsg(null);
      setA8Busy(name);
      startDurTicker();
      const r = await api("/api/speech/audio8/preview", "POST", { voice: name, text: (ttsText || DEFAULT_TTS_TEXT) });
      setA8Busy(null);
      const ms = r.data && typeof r.data.elapsedMs === "number" ? r.data.elapsedMs : null;
      stopDurTicker();
      if (ms !== null) setPreviewDur(ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");
      if (r.ok && r.data.dataUrl) {
        playAudio(r.data.dataUrl, "a8-clone:" + name);
        setA8CloneMsg({ ok: true, text: "「" + name + "」已实时克隆（" + (ms !== null ? (ms / 1000).toFixed(1) + "s" : "—") + "）" });
      } else {
        setPreviewErr((r.data && r.data.error) || "克隆声生成失败");
      }
    }
    async function removeAudio8Voice(name) {
      if (!window.confirm("删除克隆音色「" + name + "」？它的参考语音与音色文件会一起删掉。")) return;
      const r = await api("/api/speech/audio8/delete", "POST", { voice: name });
      if (!r.ok) { setA8Msg({ ok: false, text: (r.data && r.data.error) || "删除失败" }); return; }
      const v = await api("/api/speech/audio8/voices");
      if (v.ok) setA8Voices(v.data.voices || []);
      const s = await api("/api/speech"); if (s.httpOk) setConfig(s.data.speech);
      setA8Msg({ ok: true, text: "已删除音色「" + name + "」" });
    }

    /* 保存 tts 顶层字段（如 defaultEngine）——不是某个引擎的子配置，patch() 管不到 */
    function patchTts(obj) {
      const next = Object.assign({}, config, { tts: Object.assign({}, config.tts, obj) });
      setConfig(next);
      (async function () { await api("/api/speech", "PUT", next); })();
      setPreviewErr(null);
    }
    function patchAsr(obj) {
      const next = Object.assign({}, config, { asr: Object.assign({}, config.asr || {}, obj) });
      setConfig(next);
      (async function () { await api("/api/speech", "PUT", next); })();
    }

    /* TTS 试听 */
    async function synthPreview(text, engine, voiceDesc, tag) {
      setPreviewErr(null);
      // 按下即开始跳秒（等待合成期间也能看到在动）；endpoint 出音频即停
      startDurTicker();
      const r = await api("/api/speech/tts-test", "POST", { text: text || ttsText, engine: engine, voiceDesc: voiceDesc });
      // 后端 elapsedMs 为准（含网络），比前端秒表准；出错也停秒表显示用时
      const ms = r.data && typeof r.data.elapsedMs === "number" ? r.data.elapsedMs : null;
      stopDurTicker();
      if (ms !== null) setPreviewDur(ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");
      if (r.ok && r.data.dataUrl) playAudio(r.data.dataUrl, tag);
      else setPreviewErr(r.data.error || "合成失败");
    }

    /* 克隆 */
    async function playCloneSource(id) {
      const r = await api("/api/speech/voice-clone/source?id=" + encodeURIComponent(id));
      if (r.ok) playAudio("data:" + (r.data.mediaType || "audio/wav") + ";base64," + r.data.data, "clone-src:" + id);
      else setPreviewErr(r.data.error || "读取失败");
    }
    async function playClonePreview(id) {
      const r = await api("/api/speech/voice-clone/preview?id=" + encodeURIComponent(id));
      if (r.ok) playAudio("data:" + (r.data.mediaType || "audio/mpeg") + ";base64," + r.data.data, "clone-baked:" + id);
      else setPreviewErr(r.data.error || "该克隆声未预生成");
    }
    async function removeCloneSample(id, name) {
      if (!window.confirm("删除克隆音色「" + name + "」？")) return;
      patch("voiceclone", { samples: cloneSamples.filter(function (x) { return x.id !== id; }) });
    }
    async function addCloneSample() {
      const f = cloneFileRef.current && cloneFileRef.current.files ? cloneFileRef.current.files[0] : null;
      if (!f) { setCloneAddMsg({ ok: false, text: "请选择音频文件" }); return; }
      if (!/\.(mp3|wav)$/i.test(f.name) && !/audio\/(mpeg|wav)/.test(f.type)) { setCloneAddMsg({ ok: false, text: "仅支持 mp3/wav" }); return; }
      if (f.size > 10 * 1024 * 1024) { setCloneAddMsg({ ok: false, text: "音频需 ≤10MB（参考语音建议 15-60 秒）" }); return; }
      const data = await new Promise(function (res, rej) {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result).split(",")[1] || "");
        rd.onerror = rej;
        rd.readAsDataURL(f);
      });
      setAddingClone(true);
      const r = await api("/api/speech/voice-clone/add", "POST", {
        name: cloneName.trim() || f.name.replace(/\.(mp3|wav)$/i, ""),
        audioBase64: data, mediaType: f.type || "audio/wav", context: cloneContext,
      });
      setAddingClone(false);
      if (r.ok) {
        setCloneAddMsg({ ok: true, text: "已添加克隆音色「" + (r.data.sample && r.data.sample.name || "") + "」" });
        setCloneName(""); setCloneContext("");
        if (cloneFileRef.current) cloneFileRef.current.value = "";
        const s = await api("/api/speech"); if (s.httpOk) setConfig(s.data.speech);
      } else {
        setCloneAddMsg({ ok: false, text: r.data.error || "添加失败" });
      }
    }

    /* ASR */
    async function asrRecognize() {
      if (!asrSample) { setAsrResult({ ok: false, text: "请先加载示例音频" }); return; }
      setAsrResult({ ok: false, busy: true, text: "识别中…" });
      const r = await api("/api/speech/asr-test", "POST", { audioBase64: asrSample.base64 });
      if (r.ok) setAsrResult({ ok: true, busy: false, text: r.data.text || "" });
      else setAsrResult({ ok: false, busy: false, text: r.data.error || "识别失败" });
    }

    /* ── 各引擎卡片内容 ── */
    function EngineContent(engine) {
      const e = tts[engine] || {};
      if (engine === "edge") {
        return h("div", null,
          h("div", { class: "row" },
            Field({ label: "音色" }, h("select", {
              value: e.voice || "zh-CN-XiaoxiaoNeural",
              onInput: (ev) => patch("edge", { voice: ev.target.value }),
            }, ["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunxiNeural", "zh-CN-YunyangNeural"].map(function (v) {
              return h("option", { value: v }, v);
            }))),
          ),
          h("div", { class: "row" }, PlayBtn("edge", () => synthPreview(DEFAULT_TTS_TEXT, "edge", undefined, "edge"))),
        );
      }
      if (engine === "xiaomi") {
        return h("div", null,
          h("div", { class: "row" },
            Field({ label: "API Key" }, h(SecretInput, { value: e.apiKey || "", onInput: (ev) => patch("xiaomi", { apiKey: ev.target.value }), placeholder: "小米 mimo TTS key" })),
            Field({ label: "音色" }, h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
              h("select", { value: e.voice || "冰糖", onInput: (ev) => patch("xiaomi", { voice: ev.target.value }) },
                XIAOMI_VOICES.map(function (v) { return h("option", { value: v }, v); })),
              h("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--dim)", cursor: "pointer", whiteSpace: "nowrap" } },
                h("input", { type: "checkbox", checked: !!e.singing, onChange: (ev) => patch("xiaomi", { singing: ev.target.checked }) }), " 唱歌"),
            )),
          ),
          h("div", { class: "row" }, Field({ label: "音色描述底嗓" }, h("input", { type: "text", value: e.context || "", onInput: (ev) => patch("xiaomi", { context: ev.target.value }), placeholder: "如：用标准播音腔，专业新闻播报" }))),
          h("div", { class: "row" }, PlayBtn("xiaomi", () => synthPreview(DEFAULT_TTS_TEXT, "xiaomi", undefined, "xiaomi"))),
        );
      }
      if (engine === "voicedesign") {
        const vd = e || {};
        return h("div", null,
          h("div", { class: "dim", style: { marginBottom: 8 } }, "语音设计：给一段音色描述，AI 生成对应人声（需小米 key" + (hasMimoKey ? " ✓" : " ✗ 未配置") + "）"),
          h("div", { class: "row" },
            Field({ label: "模式" }, h("select", { value: vd.mode || "ai", onInput: (ev) => patch("voicedesign", { mode: ev.target.value }) },
              [["ai", "AI 自动发挥"], ["fixed", "固定音色描述"]].map(function (p) { return h("option", { value: p[0] }, p[1]); }))),
          ),
          (vd.mode === "ai") ?
            h("div", null,
              h("div", { class: "row" },
                Field({ label: "固定性别" }, h("select", { value: vd.aiGender || "", onInput: (ev) => patch("voicedesign", { aiGender: ev.target.value }) },
                  [["", "不限"], ["male", "男"], ["female", "女"]].map(function (p) { return h("option", { value: p[0] }, p[1]); }))),
                Field({ label: "年龄段" }, h("select", { value: vd.aiAge || "young", onInput: (ev) => patch("voicedesign", { aiAge: ev.target.value }) },
                  Object.keys(AI_AGE_LABELS).map(function (k) { return h("option", { value: k }, AI_AGE_LABELS[k]); }))),
              ),
              h("div", { class: "row" },
                h("label", { style: { fontSize: 12, color: "var(--dim)" } }, h("input", { type: "checkbox", checked: !!vd.lockGender, onChange: (ev) => patch("voicedesign", { lockGender: ev.target.checked }) }), " 锁性别"),
                h("label", { style: { fontSize: 12, color: "var(--dim)" } }, h("input", { type: "checkbox", checked: !!vd.lockAge, onChange: (ev) => patch("voicedesign", { lockAge: ev.target.checked }) }), " 锁年龄"),
                h("label", { style: { fontSize: 12, color: "var(--dim)" } }, h("input", { type: "checkbox", checked: !!vd.lockTimbre, onChange: (ev) => patch("voicedesign", { lockTimbre: ev.target.checked }) }), " 锁音色"),
              ),
              h("div", { class: "row" }, PlayBtn("vd-ai", () => synthPreview(vdReadText || DEFAULT_TTS_TEXT, "voicedesign", undefined, "vd-ai"), { text: "试听 AI 音色" })),
            )
            :
            h("div", null,
              h("div", { class: "row" }, Field({ label: "音色描述指令" }, h("textarea", { rows: 3, value: vdCustomText, onInput: (ev) => setVdCustomText(ev.target.value), placeholder: "描述想要的音色（身份/质感/语气）" }))),
              h("div", { class: "row" }, Field({ label: "试听文本" }, h("input", { type: "text", value: vdReadText, onInput: (ev) => setVdReadText(ev.target.value) }))),
              h("div", { class: "row" },
                PlayBtn("vd-custom", () => synthPreview(vdReadText || DEFAULT_TTS_TEXT, "voicedesign", vdCustomText, "vd-custom"), { text: "试听自定义" }),
                h("button", { class: "btn", style: { flex: "none" }, onClick: () => patch("voicedesign", { context: vdCustomText }) }, "保存此描述"),
              ),
            ),
          h("div", { class: "divider" }),
          h("div", { class: "dim", style: { marginBottom: 6 } }, "官方示例（预生成，点击直接播放，下方为音色指令与试听文本）："),
          vdSamples.map(function (s) {
            return h("div", { class: "sample-row", key: s.key, style: { flexDirection: "column", alignItems: "stretch", gap: 4, padding: "8px 0" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                h("span", { class: "name" }, s.title),
                h("button", { type: "button", class: "btn", style: { flex: "none" }, onClick: function () {
                  if (previewing === "vd:" + s.key) { playAudio("", "vd:" + s.key); return; }
                  playAudio("data:" + (s.mediaType || "audio/wav") + ";base64," + s.data, "vd:" + s.key);
                  setVdCustomText(s.instruct || "");
                  setVdReadText(s.text && s.text.replace(/\[[^\]]*\]/g, "") || DEFAULT_TTS_TEXT);
                } }, previewing === "vd:" + s.key ? "⏹ 停止" : "▶ 播放"),
              ),
              s.instruct ? h("div", { class: "dim", style: { fontSize: 11.5 } }, "🎙 音色指令：" + s.instruct) : null,
              s.text ? h("div", { class: "dim", style: { fontSize: 11.5, color: "var(--text)" } }, "📝 试听文本：" + s.text.replace(/\[[^\]]*\]/g, "")) : null,
            );
          }),
        );
      }
      if (engine === "voiceclone") {
        const isBundled = (id) => id === BUNDLED_CLONE_ID;
        return h("div", null,
          h("div", { class: "dim", style: { marginBottom: 8 } }, "语音克隆：用一段参考语音克隆出人声（需小米 key" + (hasMimoKey ? " ✓" : " ✗ 未配置") + "；原音=参考语音，克隆声=预生成，不浪费额度）"),
          h("div", { class: "dim", style: { marginBottom: 6 } }, "已保存的克隆音色（默认语音引擎选「小米克隆」后用第一个音色）："),
          (cloneSamples.length === 0) ? h("div", { class: "dim" }, "暂无克隆音色，可在下方上传参考语音") :
            cloneSamples.map(function (sm) {
              return h("div", { class: "clone-row", key: sm.id },
                h("span", { class: "name" }, sm.name || sm.id.slice(0, 8)),
                h("button", { type: "button", class: "btn", title: "播放原始参考语音", onClick: () => playCloneSource(sm.id) }, previewing === "clone-src:" + sm.id ? "⏹" : "🔊 原音"),
                h("button", { type: "button", class: "btn", title: "播放预生成克隆声", onClick: () => playClonePreview(sm.id) }, previewing === "clone-baked:" + sm.id ? "⏹" : "🔊 克隆声"),
                isBundled(sm.id) ? null : h("button", { type: "button", class: "btn", title: "删除此克隆音色", style: { flex: "none", color: "#ff5f57" }, onClick: () => removeCloneSample(sm.id, sm.name || "样本") }, "✕"),
              );
            }),
          h("div", { class: "divider" }),
          h("div", { class: "dim", style: { marginBottom: 6 } }, "添加克隆音色（上传语音作参考，mp3/wav ≤10MB，建议 15-60 秒）："),
          h("div", { class: "row" }, h("input", { type: "file", accept: ".mp3,.wav,audio/mpeg,audio/wav", ref: cloneFileRef })),
          h("div", { class: "row" },
            Field({ label: "名称" }, h("input", { type: "text", value: cloneName, onInput: (ev) => setCloneName(ev.target.value), placeholder: "如：我的声音（留空用文件名）" })),
            Field({ label: "沟通指令（可选）" }, h("input", { type: "text", value: cloneContext, onInput: (ev) => setCloneContext(ev.target.value), placeholder: "如：用委屈撒娇的语气" })),
          ),
          h("div", { class: "row" },
            h("button", { class: "btn primary", onClick: addCloneSample, disabled: addingClone }, addingClone ? "添加中…" : "添加克隆音色"),
            cloneAddMsg ? h("span", { class: cloneAddMsg.ok ? "ok dim" : "err" }, cloneAddMsg.text) : null,
          ),
        );
      }
      if (engine === "local") {
        // [2026-09-01] 老大要求：URL/CMD 不是随手能改的输入框。默认锁定，点「修改」才解锁，
        // 按钮变「保存」，再点一下保存并重新锁定——一个按钮来回切。
        const ed = !!editing.local;
        const ro = ed ? {} : { disabled: true, style: { opacity: 0.65 } };
        return h("div", null,
          h("div", { class: "row" },
            Field({ label: "URL 服务" }, h("input", Object.assign({ type: "text", value: (e.url || ""), onInput: (ev) => patch("local", { url: ev.target.value }), placeholder: "http://本地 MeloTTS（优先）" }, ro))),
            Field({ label: "CMD 命令" }, h("input", Object.assign({ type: "text", value: (e.cmd || ""), onInput: (ev) => patch("local", { cmd: ev.target.value }), placeholder: "node C:\\D\\opt\\scripts\\local-tts.mjs" }, ro))),
          ),
          h("div", { class: "row" },
            h("button", { type: "button", class: "btn" + (ed ? " primary" : ""), style: { flex: "none" }, onClick: () => setEditing(Object.assign({}, editing, { local: !ed })) }, ed ? "保存" : "修改"),
            h("span", { class: "dim" }, ed ? "改完点保存（输入时已实时写入）" : "已锁定，点修改才能改"),
            PlayBtn("local", () => synthPreview(DEFAULT_TTS_TEXT, "local", undefined, "local"), { text: "试听本地 TTS" }),
            previewDur !== null ? h("span", { class: "dim" }, "生成用时 " + previewDur) : null,
          ),
        );
      }
      if (engine === "audio8") {
        // [2026-09-01] 照「语音克隆」模板重做（老大原话：明明有模板你咋不用）：
        //   ① 常驻服务直连（模型常驻内存，比 CMD 快）；URL 默认锁定，点「修改」才解锁
        //   ② 每个音色一行：点名字=设为默认，🔊 原音（参考语音点播）+ 🔊 克隆声（点一次实时生成一次）
        //   ③ 实时生成的音频不落盘不缓存，用完即弃——不会堆测试垃圾
        //   ④ 保底音色 xiaotuantuan 不给删除按钮（要删的是临时测试文件，不是它）
        const ed = !!editing.audio8;
        const ro = ed ? {} : { disabled: true, style: { opacity: 0.65 } };
        const BUNDLED = "xiaotuantuan";
        const cur = (e.voice || "") || (a8Voices[0] && a8Voices[0].name) || "";
        return h("div", null,
          h("div", { class: "dim", style: { marginBottom: 8 } },
            "本地零样本克隆：拿一段参考语音克隆人声，纯 CPU 常驻服务（模型常驻内存，短句 ~8s）。原音=你上传的参考语音，克隆声=点一次实时生成一次。"),
          h("div", { class: "row" },
            Field({ label: "常驻服务" }, h("input", Object.assign({
              type: "text", value: (e.url || "http://127.0.0.1:18795"),
              onInput: (ev) => patch("audio8", { url: ev.target.value }),
              placeholder: "http://127.0.0.1:18795",
              title: "Audio8 常驻服务地址（模型常驻内存，nssm 服务 audio8-tts 提供）",
            }, ro))),
            h("button", { type: "button", class: "btn" + (ed ? " primary" : ""), style: { flex: "none" }, onClick: () => setEditing(Object.assign({}, editing, { audio8: !ed })) }, ed ? "保存" : "修改"),
            h("span", { class: "dim" }, ed ? "改完点保存（输入时已实时写入）" : "已锁定，点修改才能改"),
          ),
          h("div", { class: "divider" }),
          h("div", { class: "dim", style: { marginBottom: 6 } }, "已保存的克隆音色（点名字=设为默认引擎音色）："),
          (a8Voices.length === 0) ? h("div", { class: "dim" }, "暂无音色，可在下方上传一段参考语音") :
            a8Voices.map(function (v) {
              const isCur = v.name === cur;
              const busy = a8Busy === v.name;
              return h("div", { class: "clone-row", key: v.name },
                h("button", { type: "button", class: "btn" + (isCur ? " primary" : ""), title: "设为默认音色", style: { flex: "none" }, onClick: () => patch("audio8", { voice: v.name }) }, (isCur ? "● " : "○ ") + v.name),
                h("button", { type: "button", class: "btn", title: "播放参考原音", disabled: !!a8Busy, onClick: () => playAudio8Source(v.name) }, previewing === "a8-src:" + v.name ? "⏹" : "🔊 原音"),
                h("button", { type: "button", class: "btn", title: "用这个音色实时克隆一段（每次都现算）", disabled: !!a8Busy, onClick: () => playAudio8Clone(v.name) }, busy ? "生成中…" : (previewing === "a8-clone:" + v.name ? "⏹" : "🔊 克隆声")),
                (v.name === BUNDLED) ? null : h("button", { type: "button", class: "btn", title: "删除这个音色", style: { flex: "none", color: "#ff5f57" }, disabled: !!a8Busy, onClick: () => removeAudio8Voice(v.name) }, "✕"),
              );
            }),
          a8CloneMsg ? h("div", { class: "dim", style: { marginTop: 4 } }, a8CloneMsg.text) : null,
          h("div", { class: "divider" }),
          h("div", { class: "dim", style: { marginBottom: 6 } }, "添加克隆音色（上传语音作参考，mp3/wav/m4a ≤20MB，建议 15-30 秒）："),
          h("div", { class: "row" }, h("input", { type: "file", accept: ".mp3,.wav,.m4a,audio/*", ref: a8FileRef })),
          h("div", { class: "row" },
            Field({ label: "名称" }, h("input", { type: "text", value: a8Name, onInput: (ev) => setA8Name(ev.target.value), placeholder: "如：我的声音（中文自动转编号）" })),
            Field({ label: "逐字文本（可空=自动转写）" }, h("input", { type: "text", value: a8Text, onInput: (ev) => setA8Text(ev.target.value), placeholder: "录音里说的原话，越准越像" })),
          ),
          h("div", { class: "row" },
            h("button", { class: "btn primary", onClick: registerAudio8Voice, disabled: a8Registering }, a8Registering ? "注册中…（约 10-40 秒）" : "添加克隆音色"),
            a8Msg ? h("span", { class: a8Msg.ok ? "ok dim" : "err" }, a8Msg.text) : null,
          ),
        );
      }
      if (engine === "ali") {
        return h("div", null,
          h("div", { class: "row" },
            Field({ label: "API Key" }, h(SecretInput, { value: (e.apiKey || ""), onInput: (ev) => patch("ali", { apiKey: ev.target.value }), placeholder: "dashscope key" })),
            Field({ label: "音色" }, h("input", { type: "text", value: (e.voice || "Cherry"), onInput: (ev) => patch("ali", { voice: ev.target.value }) })),
          ),
          h("div", { class: "row" }, PlayBtn("ali", () => synthPreview(DEFAULT_TTS_TEXT, "ali", undefined, "ali"))),
        );
      }
      return null;
    }

    // 显示引擎：activeEngine（用户选的）或 defaultEngine 兜底
    const shownEngine = activeEngine || (tts.defaultEngine && ENGINE_ORDER.includes(tts.defaultEngine) ? tts.defaultEngine : "edge");

    return h("div", { class: "wrap" },
      h("h1", null,
        inIframe ? null : h("button", { class: "btn-back", onClick: () => { location.href = "./"; } }, "←"),
        " 🗣 语音服务设置"),
      previewErr ? h("div", { class: "card" }, h("div", { class: "err" }, previewErr)) : null,

      h("div", { class: "cols" },
        h("div", { class: "card" },
          h("div", { class: "card-header", onClick: () => setActiveEngine(null) },
            // [2026-09-01] 一个下拉搞定：选中哪个引擎 = 它就是默认引擎（立刻 PUT 保存）+ 打开它的配置面板
            h("select", {
              value: shownEngine,
              onClick: (ev) => ev.stopPropagation(),
              onInput: (ev) => { const v = ev.target.value; setActiveEngine(v); patchTts({ defaultEngine: v }); },
              style: { minWidth: 180 },
              title: "选中即设为默认引擎，所有 bot 的语音回复都用它；同时展开这个引擎的配置",
            }, ENGINE_ORDER.map(function (en) { return h("option", { value: en }, ENGINE_LABEL[en]); })),
            h("span", { class: "chev" }, "选中即默认引擎"),
          ),
          h("div", { class: "map" }, EngineContent(shownEngine)),
        ),

        h(Card, { title: "语音识别 ASR", defaultOpen: true },
          h("div", { class: "row" }, Field({ label: "模式" }, h("select", { value: asr.mode || "service", onInput: (ev) => patchAsr({ mode: ev.target.value }) },
            [["service", "本地常驻服务"], ["cmd", "本地命令"], ["api", "在线 API"]].map(function (p) { return h("option", { value: p[0] }, p[1]); })))),
          asr.mode === "service" ? h("div", { class: "row" }, Field({ label: "服务地址" }, h("input", { type: "text", value: asr.url || "", onInput: (ev) => patchAsr({ url: ev.target.value }), placeholder: "http://127.0.0.1:18790" }))) : null,
          asr.mode === "cmd" ? h("div", { class: "row" }, Field({ label: "命令" }, h("input", { type: "text", value: asr.cmd || "", onInput: (ev) => patchAsr({ cmd: ev.target.value }), placeholder: "sherpa-onnx-offline.exe 参数…" }))) : null,
          asr.mode === "api" ? h("div", { class: "row" }, Field({ label: "API Key" }, h(SecretInput, { value: asr.apiKey || "", onInput: (ev) => patchAsr({ apiKey: ev.target.value }) }))) : null,
          h("div", { class: "divider" }),
          h("div", { class: "dim", style: { marginBottom: 6 } }, "识别测试："),
          h("div", { class: "row" },
            h("span", { class: "dim", style: { flex: "none" } }, "示例音频："),
            asrSample ? h("audio", { controls: true, preload: "none", src: asrSample.url, style: { maxWidth: 320, height: 32, flex: "none" } }) : h("span", { class: "dim" }, "示例音频加载中…"),
            h("button", { class: "btn", onClick: asrRecognize }, asrResult && asrResult.busy ? "识别中…" : "识别这段音频"),
          ),
          asrResult && asrResult.text ? h("div", { class: "row" }, h("span", { class: asrResult.ok ? "ok dim" : "err" }, asrResult.ok ? "✅ " + asrResult.text : asrResult.text)) : null,
        ),
      ),
      h("div", { class: "dim", style: { textAlign: "center", padding: "4px 0 16px" } }, "所有配置自动保存（无需点保存）；试听点击即播，再点停止"),
    );
  }

  render(h(App, null), document.getElementById("root"));
})();