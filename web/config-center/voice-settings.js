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
  // [2026-09-01] 对齐 dsh-web：年龄感只留 3 档（少年/中年/老年）；旧值归并（婴儿/幼儿→少年，青年→中年）
  const AI_AGE_LABELS = { teen: "少年感", middle: "中年感", old: "老年感" };
  function normAiAge(v) {
    if (v === "teen" || v === "middle" || v === "old") return v;
    if (v === "young") return "middle";
    return "teen";
  }
  const DEFAULT_TTS_TEXT = "你好，这是一段语音试听。";
  const BUNDLED_CLONE_ID = "8da38fcc-b041-4f5b-86b9-901956016f89"; // 自带默认样本（小团团）：禁删
  // [2026-09-01 #29] 语音设计三选一（对齐 dsh-web）：examples=官方示例 / custom=设计音色 / ai=AI 自由发挥。
  // 官方示例三条全文抄 dsh-input-tools client.js（instruct=音色指令，选中即写入 context；text=试听文本，仅作展示）
  const VD_KEYS = ["asmr", "docu", "elder"];
  const VOICE_DESIGN_EXAMPLES = [
    {
      key: "asmr", title: "ASMR 双耳女声",
      instruct: "年轻的女性声音，近距离的聆听效果，带有双耳刺激的ASMR感。可以听到她的呼吸声、轻微的吞咽声，以及轻柔的自然唇音。她的说话速度非常慢，营造出一种极度放松且沉浸式的体验。",
      text: "[在你耳边低语] 嘘……放松点，再靠近一点吧。我现在就在你身边。慢慢、轻柔地呼吸，让思绪随着水流轻轻流淌，就像沉浸在温暖的水中一样。",
    },
    {
      key: "docu", title: "纪录片旁白",
      instruct: "一位中年男性，说标准普通话，嗓音低沉有磁性，带有轻微的沙哑质感，像纪录片旁白解说员，沉稳而有感染力。",
      text: "当最后一缕阳光消失在地平线之下，这片沉睡了亿万年的大地开始显露它真正的面貌。在这寂静的荒野中，每一块岩石都记录着时间的流逝，每一阵风都在诉说着古老的故事。",
    },
    {
      key: "elder", title: "年迈老先生旁白",
      instruct: "一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。",
      text: "我这辈子啊，走南闯北六十多年。见过最热闹的集市，也见过最安静的戈壁。到头来才明白一个道理——这人哪，不在走了多远的路，在于记住了多少风景。年轻人，别光顾着赶路，偶尔也停下来看看天。",
    },
  ];
  // 「设计音色」模式的内置默认描述（从官方示例切过来时自动填，用户自写的保留）——抄 dsh-web
  const CUSTOM_VOICE_DEFAULT = "一位知性温柔的青年女性，说字正腔圆的普通话，声音沉稳放松，像深夜电台主播在耳边娓娓道来，气息平稳，尾音带着若有若无的笑意";

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
  // [2026-09-01 #29] 「？」帮助提示（对齐 dsh-web helpTip）：点一下展开/收起，弹层浮在按钮下方
  function HelpTip(props) {
    const [open, setOpen] = useState(false);
    return h("span", { style: { position: "relative", display: "inline-flex", alignItems: "center", flex: "none" } },
      h("button", {
        type: "button", "aria-label": "帮助", title: "帮助",
        style: {
          border: "none", borderRadius: "999px", width: 16, height: 16, padding: 0,
          background: open ? "var(--accent)" : "rgba(128,128,128,.25)", color: "inherit", cursor: "pointer",
          fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center",
        },
        onClick: () => setOpen(!open),
      }, "?"),
      open ? h("div", {
        style: {
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 60,
          background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8,
          padding: "10px 12px", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
          fontSize: 12, lineHeight: 1.7, minWidth: 280, maxWidth: 420,
          color: "var(--dim)", textAlign: "left", whiteSpace: "normal",
        },
      }, props.text) : null,
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
    // 克隆（[2026-09-01] 对齐 dsh-web：名称=文件名、指令/试听文本后端内置，删除名称与沟通指令输入框）
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
    const [a8Dur, setA8Dur] = useState(null);        // 克隆声秒表（毫秒）：点按钮即跳，出声即停
    const a8TickerRef = useRef(null);
    // [2026-09-01 #29] 语音设计三选一改造：custom 面板直接读写 config 的 context（改动即保存），
    // 不再需要 vdCustomText/vdReadText 本地草稿 state（已删）
    // ASR
    const [asrSample, setAsrSample] = useState(null); // {url, base64}
    const [asrResult, setAsrResult] = useState(null);
    const [previewErr, setPreviewErr] = useState(null);
    const [previewDur, setPreviewDur] = useState(null); // 试听生成用时的实时秒表（按下即开始跳，出音频即停）
    const durTickerRef = useRef(null);

    /* 隐形播放：new Audio 直接播（页面不摆可见播放条），再点=停止，与 input-tools 一致
       2026-09-01：onStart 回调 = 真正开始出声的那一刻（Audio8 克隆声用它停秒表） */
    function playAudio(dataUrl, tag, onStart) {
      if (previewTagRef.current === tag && previewRef.current) {
        try { previewRef.current.pause(); } catch {}
        previewRef.current = null; previewTagRef.current = null; setPreviewing(null);
        return;
      }
      if (previewRef.current) { try { previewRef.current.pause(); } catch {} previewRef.current = null; }
      if (previewErr) setPreviewErr(null);
      const audio = new Audio(dataUrl);
      previewRef.current = audio; previewTagRef.current = tag; setPreviewing(tag);
      if (onStart) audio.onplaying = () => { if (previewTagRef.current === tag) onStart(); };
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
        if (!dead && a8.ok) setA8Voices(normA8Voices(a8.data.voices));
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
    function patch(engine, obj, makeDefault) {
      const next = Object.assign({}, config, { tts: Object.assign({}, config.tts, { [engine]: Object.assign({}, (config.tts && config.tts[engine]) || {}, obj) }) });
      // [2026-09-01] 对齐 dsh-web「选中即生效」：某引擎卡内选中/改动可联动默认引擎（makeDefault=引擎 key）
      if (makeDefault) next.tts.defaultEngine = makeDefault;
      setConfig(next);
      (async function () { await api("/api/speech", "PUT", next); })();
      setPreviewErr(null);
    }
    /* 音色列表归一化：兼容旧格式（字符串数组），并保证 display 有值（中文显示名，缺省用 id） */
    function normA8Voices(list) {
      return (list || []).map(function (v) {
        const name = typeof v === "string" ? v : v.name;
        return { name: name, display: (typeof v === "string" ? name : (v.display || v.name || name)) };
      });
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
        if (v.ok) setA8Voices(normA8Voices(v.data.voices));
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
    /* Audio8 克隆声专用秒表（2026-09-01）：点「克隆声」那一瞬间开始跳秒，
       合成期间一直跳，音频真正出声（onplaying）才停——秒数就显示在按钮后面那一行 */
    function startA8Ticker() {
      if (a8TickerRef.current) clearInterval(a8TickerRef.current);
      const t0 = Date.now();
      setA8Dur(0);
      a8TickerRef.current = setInterval(function () { setA8Dur(Date.now() - t0); }, 100);
    }
    function stopA8Ticker(ms) {
      if (a8TickerRef.current) { clearInterval(a8TickerRef.current); a8TickerRef.current = null; }
      setA8Dur(typeof ms === "number" ? ms : null);
    }
    /** 秒表文案：跟在「🔊 克隆声」按钮后面同一行显示（老大：不要放第二行） */
    function fmtA8Dur(ms) {
      if (ms === null || ms === undefined) return "";
      return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
    }
    /** 克隆声：点一次现算一次（服务端不落盘不缓存，测试垃圾不会堆积） */
    async function playAudio8Clone(name) {
      if (a8Busy) return;
      setA8CloneMsg(null);
      setA8Busy(name);
      startA8Ticker();
      const t0 = Date.now();
      const r = await api("/api/speech/audio8/preview", "POST", { voice: name, text: (ttsText || DEFAULT_TTS_TEXT) });
      setA8Busy(null);
      const ms = r.data && typeof r.data.elapsedMs === "number" ? r.data.elapsedMs : (Date.now() - t0);
      if (r.ok && r.data.dataUrl) {
        // 出声那一刻才停表（onplaying 回调），不是接口返回就停
        playAudio(r.data.dataUrl, "a8-clone:" + name, () => stopA8Ticker(ms));
      } else {
        stopA8Ticker(ms);
        setPreviewErr((r.data && r.data.error) || "克隆声生成失败");
      }
    }
    async function removeAudio8Voice(name) {
      if (!window.confirm("删除克隆音色「" + name + "」？它的参考语音与音色文件会一起删掉。")) return;
      const r = await api("/api/speech/audio8/delete", "POST", { voice: name });
      if (!r.ok) { setA8Msg({ ok: false, text: (r.data && r.data.error) || "删除失败" }); return; }
      const v = await api("/api/speech/audio8/voices");
      if (v.ok) setA8Voices(normA8Voices(v.data.voices));
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
        // [2026-09-01] 对齐 dsh-web：名字=文件名（去扩展名）；context/previewText 不传，后端内置默认
        name: f.name.replace(/\.(mp3|wav)$/i, ""),
        audioBase64: data, mediaType: f.type || "audio/wav",
      });
      setAddingClone(false);
      if (r.ok) {
        setCloneAddMsg({ ok: true, text: "已添加克隆音色「" + (r.data.sample && r.data.sample.name || "") + "」" });
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
        // [2026-09-01 #29] 三选一（对齐 dsh-web vdMode 逻辑）：旧数据迁移——
        // mode 非法/缺失（含旧 fixed）按 context 反推：=官方指令→对应示例；非空→custom；空→ai
        const vdMode = (function () {
          const m = vd.mode;
          if (VD_KEYS.includes(m) || m === "custom" || m === "ai") return m;
          const ctx = (vd.context || "").trim();
          if (!ctx) return "ai";
          const hit = VOICE_DESIGN_EXAMPLES.findIndex(function (ex) { return ex.instruct === ctx; });
          return hit >= 0 ? VD_KEYS[hit] : "custom";
        })();
        const vdGroup = VD_KEYS.includes(vdMode) ? "examples" : vdMode; // 官方示例组在下拉归为一项
        // 选中官方示例某条 = 音色指令写入 context + 模式切到该示例（第 3 参联动默认引擎，选中即生效）
        const pickVdMode = function (key) {
          const ex = VOICE_DESIGN_EXAMPLES[VD_KEYS.indexOf(key)];
          patch("voicedesign", { mode: key, context: ex.instruct }, "voicedesign");
        };
        const pickVdGroup = function (g) {
          if (g === "examples") { pickVdMode(VD_KEYS.includes(vdMode) ? vdMode : "asmr"); return; }
          if (g === "custom") {
            // 从官方示例切过来（context=官方指令）必须换成默认描述，不能拿非空当保留依据；用户自写的才保留
            const ctx = (vd.context || "").trim();
            const isOfficial = VOICE_DESIGN_EXAMPLES.some(function (ex) { return ex.instruct === ctx; });
            patch("voicedesign", { mode: "custom", context: (!ctx || isOfficial) ? CUSTOM_VOICE_DEFAULT : vd.context }, "voicedesign");
            return;
          }
          patch("voicedesign", { mode: "ai" }, "voicedesign");
        };
        return h("div", null,
          h("div", { class: "dim", style: { marginBottom: 8 } }, "语音设计：给一段音色描述，AI 生成对应人声（需小米 key" + (hasMimoKey ? " ✓" : " ✗ 未配置") + "）"),
          h("div", { class: "row" },
            // [2026-09-01 #29] 模式下拉三选一：选中哪个才显示哪个的配置项（对齐 dsh-web vdGroup）
            Field({ label: "模式" }, h("select", { value: vdGroup, onInput: (ev) => pickVdGroup(ev.target.value) },
              [["examples", "官方示例"], ["custom", "设计音色"], ["ai", "AI 自由发挥"]].map(function (p) { return h("option", { value: p[0] }, p[1]); }))),
          ),
          vdGroup === "examples" ? h("div", null,
            h("div", { class: "dim", style: { marginBottom: 6 } }, "点单选框选中该音色（选中即生效，音色指令自动写入）；🔊 播预生成音频，不耗额度："),
            VOICE_DESIGN_EXAMPLES.map(function (ex, i) {
              const key = VD_KEYS[i];
              const active = vdMode === key;
              const s = vdSamples.find(function (x) { return x.key === key; });
              return h("div", { key: key, class: "sample-row", style: { gap: 8, padding: "6px 8px", borderRadius: 6, border: active ? "1px solid var(--accent)" : "1px solid transparent", background: active ? "rgba(75,111,255,.14)" : "transparent" } },
                h("input", { type: "radio", name: "vd-mode", checked: active, onChange: () => pickVdMode(key), title: "选中即用这个音色", style: { accentColor: "var(--accent)", cursor: "pointer", flex: "none", width: 14, height: 14, margin: 0 } }),
                h("span", { style: { fontWeight: active ? 600 : 400, cursor: "pointer", flex: "none" }, onClick: () => pickVdMode(key) }, ex.title),
                h("span", { style: { flex: 1 } }),
                h(HelpTip, { text: h("div", null,
                  h("div", null, h("b", { style: { color: "var(--text)" } }, "音色指令："), ex.instruct),
                  h("div", { style: { marginTop: 6 } }, h("b", { style: { color: "var(--text)" } }, "试听文本："), ex.text.replace(/\[[^\]]*\]/g, "")),
                ) }),
                s ? h("button", { type: "button", class: "btn", style: { flex: "none" }, onClick: function () {
                  if (previewing === "vd:" + key) { playAudio("", "vd:" + key); return; }
                  playAudio("data:" + (s.mediaType || "audio/wav") + ";base64," + s.data, "vd:" + key);
                } }, previewing === "vd:" + key ? "⏹ 停止" : "🔊 试听") : h("span", { class: "dim", style: { flex: "none" } }, "音频未生成"),
              );
            }),
          )
          : vdGroup === "custom" ? h("div", null,
            h("div", { class: "row" }, Field({ label: "设计音色（音色描述指令，改动即保存）" }, h("textarea", { rows: 3, value: vd.context || "", onInput: (ev) => patch("voicedesign", { context: ev.target.value }, "voicedesign"), placeholder: CUSTOM_VOICE_DEFAULT }))),
            h("div", { class: "row" },
              PlayBtn("vd-custom", () => synthPreview(DEFAULT_TTS_TEXT, "voicedesign", undefined, "vd-custom"), { text: "试听设计音色" }),
              h("span", { class: "dim" }, "切到其它选项会保留这段描述"),
            ),
          )
          : h("div", null,
            // [2026-09-01 #29] 老大：性别/年龄下拉本身就是锁（后端已改为选择即硬锚点），锁 checkbox 删掉
            h("div", { class: "row" },
              Field({ label: "性别" }, h("select", { value: vd.aiGender || "", onInput: (ev) => patch("voicedesign", { aiGender: ev.target.value }, "voicedesign") },
                [["", "不限"], ["male", "男"], ["female", "女"]].map(function (p) { return h("option", { value: p[0] }, p[1]); }))),
              Field({ label: "年龄感" }, h("select", { value: normAiAge(vd.aiAge), onInput: (ev) => patch("voicedesign", { aiAge: ev.target.value }, "voicedesign") },
                Object.keys(AI_AGE_LABELS).map(function (k) { return h("option", { value: k }, AI_AGE_LABELS[k]); }))),
            ),
            h("div", { class: "row" }, PlayBtn("vd-ai", () => synthPreview(DEFAULT_TTS_TEXT, "voicedesign", undefined, "vd-ai"), { text: "试听 AI 音色" })),
          ),
        );
      }
      if (engine === "voiceclone") {
        const isBundled = (id) => id === BUNDLED_CLONE_ID;
        // [2026-09-01] 对齐 dsh-web 一行式：克隆列表 [下拉] 🔊原音 🔊克隆声 ✕（选中即合成用该样本，sampleId 后端优先读取）
        const cloneCfg = (config.tts && config.tts.voiceclone) || {};
        const curId = cloneSamples.some(function (s) { return s.id === (cloneCfg.sampleId || ""); }) ? cloneCfg.sampleId : (cloneSamples[0] && cloneSamples[0].id) || "";
        const cur = cloneSamples.find(function (s) { return s.id === curId; });
        return h("div", null,
          h("div", { class: "dim", style: { marginBottom: 8 } }, "语音克隆：用一段参考语音克隆出人声（需小米 key" + (hasMimoKey ? " ✓" : " ✗ 未配置") + "；原音=参考语音，克隆声=预生成，不浪费额度）"),
          h("div", { class: "row", style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("span", { class: "dim", style: { flexShrink: 0 } }, "克隆列表："),
            h("select", { value: curId, style: { flex: "0 0 200px", width: 200 },
              onChange: (ev) => patch("voiceclone", { sampleId: ev.target.value }) },
              cloneSamples.map(function (sm) {
                return h("option", { key: sm.id, value: sm.id }, sm.name || sm.id.slice(0, 8));
              }),
            ),
            h("button", { type: "button", class: "btn", title: "播放选中样本的原始参考语音", onClick: () => playCloneSource(curId) }, previewing === "clone-src:" + curId ? "⏹" : "🔊 原音"),
            h("button", { type: "button", class: "btn", title: "播放预生成克隆声", onClick: () => playClonePreview(curId) }, previewing === "clone-baked:" + curId ? "⏹" : "🔊 克隆声"),
            (cur && !isBundled(cur.id)) ? h("button", { type: "button", class: "btn", title: "删除选中的克隆音色", style: { flex: "none", color: "#ff5f57" }, onClick: () => removeCloneSample(cur.id, cur.name || "样本") }, "✕") : null,
          ),
          (cloneSamples.length === 0) ? h("div", { class: "dim" }, "暂无克隆音色，可在下方上传参考语音") : null,
          h("div", { class: "divider" }),
          h("div", { class: "dim", style: { marginBottom: 6 } }, "添加克隆音色：名字用上传文件的文件名，沟通指令与试听文本内置默认（mp3/wav ≤10MB，建议 15-60 秒）"),
          h("div", { class: "row" },
            h("input", { type: "file", accept: ".mp3,.wav,audio/mpeg,audio/wav", ref: cloneFileRef, style: { display: "none" },
              onChange: () => { if (cloneFileRef.current && cloneFileRef.current.files && cloneFileRef.current.files[0]) addCloneSample(); } }),
            h("button", { type: "button", class: "btn primary", onClick: () => { if (cloneFileRef.current) cloneFileRef.current.click(); }, disabled: addingClone }, addingClone ? "上传中…" : "📤 上传克隆音色"),
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
        // 下拉只列一个音色也行（老大：现在就小团团一个，下拉显示 1 个就行）；显示中文 display，value 用英文 id
        const selName = a8Voices.length === 0 ? "" : (a8Voices.some(function (v) { return v.name === cur; }) ? cur : a8Voices[0].name);
        const disp = function (v) { return v.display || v.name; };
        return h("div", null,
          h("div", { class: "row" },
            h("label", { class: "field", style: { flex: "0 1 320px", minWidth: "220px" } }, "常驻服务",
              h("input", Object.assign({
                type: "text", value: (e.url || "http://127.0.0.1:18795"),
                onInput: (ev) => patch("audio8", { url: ev.target.value }),
                placeholder: "http://127.0.0.1:18795",
                title: "Audio8 常驻服务地址（模型常驻内存，nssm 服务 audio8-tts 提供）",
              }, ro))),
            h("button", { type: "button", class: "btn" + (ed ? " primary" : ""), style: { flex: "none" }, onClick: () => setEditing(Object.assign({}, editing, { audio8: !ed })) }, ed ? "保存" : "修改"),
          ),
          h("div", { class: "divider" }),
          (a8Voices.length === 0)
            ? h("div", { class: "dim" }, "克隆列表：暂无音色，可在下方上传一段参考语音")
            : h("div", { class: "row", style: { margin: "6px 0" } },
                h("span", { class: "dim", style: { flex: "none" } }, "克隆列表："),
                h("select", {
                  value: selName, title: "选中即默认音色",
                  onChange: (ev) => patch("audio8", { voice: ev.target.value }),
                  style: { flex: "none", width: "150px" },
                }, a8Voices.map(function (v) {
                  return h("option", { key: v.name, value: v.name }, disp(v));
                })),
                h("button", { type: "button", class: "btn", title: "播放参考原音", style: { flex: "none" }, disabled: !!a8Busy, onClick: () => playAudio8Source(selName) }, previewing === "a8-src:" + selName ? "⏹" : "🔊 原音"),
                h("button", { type: "button", class: "btn", title: "用这个音色实时克隆一段（每次都现算）", style: { flex: "none" }, disabled: !!a8Busy, onClick: () => playAudio8Clone(selName) }, (a8Busy === selName) ? "生成中…" : (previewing === "a8-clone:" + selName ? "⏹" : "🔊 克隆声")),
                // 秒表跟在克隆声按钮后面同一行：点下去就跳，音频出声才停
                h("span", { class: "dim", style: { flex: "none", fontVariantNumeric: "tabular-nums" }, title: "克隆声生成耗时（点到出声）" }, fmtA8Dur(a8Dur)),
                (selName === BUNDLED) ? null : h("button", { type: "button", class: "btn", title: "删除这个音色", style: { flex: "none", color: "#ff5f57" }, disabled: !!a8Busy, onClick: () => removeAudio8Voice(selName) }, "✕"),
              ),
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
              style: { flex: "0 0 180px", width: 180 },
              title: "选中即设为默认引擎，所有 bot 的语音回复都用它；同时展开这个引擎的配置",
            }, ENGINE_ORDER.map(function (en) { return h("option", { value: en }, ENGINE_LABEL[en]); })),
            h("span", { class: "chev", style: { whiteSpace: "nowrap", flexShrink: 0 } }, "选中即默认引擎"),
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