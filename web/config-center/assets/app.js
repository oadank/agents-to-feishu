/* agents-to-feishu 配置中心前端逻辑（Vue3 Composition） */

const { createApp, reactive, ref, computed, onMounted } = Vue;

const app = createApp({
  setup() {
    // ── 状态 ──
    // 记住上次所在的 tab（刷新后不回概览）
    const tab = ref(localStorage.getItem('ctf_tab') || 'overview');
    function setTab(k) { tab.value = k; try { localStorage.setItem('ctf_tab', k); } catch {} }
    // 左侧栏折叠：手机/窄屏默认收起（只留图标），可展开；状态由 localStorage 记住
    const storedSide = localStorage.getItem('ctf_sidebar') || (window.innerWidth < 768 ? 'collapsed' : '');
    const sidebarCollapsed = ref(storedSide === 'collapsed');
    function toggleSidebar() {
      sidebarCollapsed.value = !sidebarCollapsed.value;
      try { localStorage.setItem('ctf_sidebar', sidebarCollapsed.value ? 'collapsed' : ''); } catch {}
    }
    const loading = ref(false);
    const store = reactive({ version: 1, providers: [], mcps: [], agents: [] });
    const runtime = reactive({});       // agentId -> runtime state
    const applying = ref('');
    const restarting = ref('');
    const activeProvider = ref([]);
    const activeMcp = ref([]);
    const vision = ref(null);
    const visionTest = reactive({ source: 'sample', localPath: '', task: 'describe', extra: '', loading: false, result: '' });
    const speech = ref(null);
    const ttsTest = reactive({ text: '你好，这是一段语音试听。', loading: false, dataUrl: '', error: '' });
    // 全局原生 audio：所有试听点击后立即播放（不二次点击）
    const audioRef = ref(null);
    function playAudio(dataUrl) {
      if (audioRef.value) {
        audioRef.value.src = dataUrl;
        audioRef.value.play().catch(() => {});
      }
    }
    // 语音设计官方示例（pre-generated）
    const vdSamples = ref([]);
    const vdCustom = reactive({ instruct: '', text: '你好，这是一段语音试听。' });
    // 克隆上传表单
    const cloneFileRef = ref(null);
    const cloneForm = reactive({ name: '', context: '', file: null, loading: false, msg: null });
    // ASR 识别测试（示例音频试听 + 识别）
    const asrTest = reactive({ loading: false, sampleUrl: '', sampleBase64: '', sampleText: '', result: '', error: '' });
    const edgeVoices = ['zh-CN-XiaoxiaoNeural','zh-CN-XiaoyiNeural','zh-CN-YunxiNeural','zh-CN-YunjianNeural','zh-CN-YunyangNeural','zh-CN-XiaochenNeural','zh-CN-XiaohanNeural','zh-CN-XiaomengNeural','zh-CN-XiaomoNeural','zh-CN-XiaoqiuNeural','zh-CN-XiaoruiNeural','zh-CN-XiaoshuangNeural','zh-CN-XiaoxuanNeural','zh-CN-XiaoyanNeural','zh-CN-XiaoyouNeural','en-US-AriaNeural','en-US-JennyNeural','ja-JP-NanamiNeural'];
    const xiaomiVoices = ['冰糖','茉莉','苏打','白桦','Mia','Chloe','Milo','Dean'];
    const aiAgeLabels = { infant: '婴儿感', child: '幼儿感', teen: '少年感', young: '青年感', middle: '中年感', old: '老年感' };
    // ComfyUI 生图测试
    const comfyTest = reactive({
      templates: [], loadingTpl: false, templateNote: '',
      template: '', prompt: '',
      width: 1024, height: 1024, seed: -1, steps: 20, cfg: 7, denoise: 1,
      generating: false, runningMsg: '', result: null, resultText: '', error: '',
    });
    // 注入配置（统一注入 + 每 agent 独立注入；config-store.json 唯一真相源）
    const injection = reactive({ enabled: true, global: '', saving: false });

    // Agent 编辑对话框
    const agentDlg = reactive({ show: false, isNew: false, saving: false, form: null });

    // ── API 封装 ──
    async function api(method, url, body) {
      const opt = { method, headers: { 'content-type': 'application/json' } };
      if (body !== undefined) opt.body = JSON.stringify(body);
      const res = await fetch(url, opt);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    }

    async function reloadAll() {
      loading.value = true;
      try {
        const s = await api('GET', '/api/store');
        Object.assign(store, s);
        // 加载内建看图配置
        try {
          const vs = await api('GET', '/api/vision');
          if (!vision.value) vision.value = vs.vision || {};
          else Object.assign(vision.value, vs.vision || {});
        } catch {}
        // 加载内建语音配置
        try {
          const sp = await api('GET', '/api/speech');
          if (!speech.value) speech.value = sp.speech || {};
          else Object.assign(speech.value, sp.speech || {});
        } catch {}
        // 自动加载语音设计官方示例 + ASR 示例音频（试听即点即放，无需手动加载）
        syncVdSamples();
        loadAsrSample();
        // 加载注入配置（统一注入）
        loadInjection();
        // 刷新所有 agent 运行时状态
        for (const a of store.agents) {
          refreshRuntime(a.id);
        }
      } catch (e) {
        ElMessage.error('加载配置失败: ' + e.message);
      } finally {
        loading.value = false;
      }
    }

    async function refreshRuntime(id) {
      try {
        const st = await api('GET', `/api/agents/${encodeURIComponent(id)}/status`);
        runtime[id] = st;
      } catch {
        runtime[id] = null;
      }
    }

    // ── 派生 ──
    const pageTitle = computed(() => ({
      overview: '📊 Agent 概览',
      agents: '🤖 Agent 分配置',
      runtimes: '🧩 运行时管理',
      providers: '🏭 总配置 · 模型/Provider',
      mcps: '🔌 总配置 · MCP',
      vision: '👁 看图配置',
      speech: '🗣 语音能力',
      skills: '🛠 技能库',
      comfy: '🎨 生图',
      inject: '💉 注入',
    }[tab.value]));

    function providerName(a) {
      const p = store.providers.find((x) => x.id === a.providerId);
      return p ? p.displayName : a.providerId;
    }
    function modelLabel(a) {
      const p = store.providers.find((x) => x.id === a.providerId);
      const m = p?.models.find((x) => x.id === a.modelId);
      return m ? (m.label || m.id) : a.modelId;
    }
    function fmtK(n) {
      if (n == null) return '—';
      return n >= 1000 ? (n / 1000).toFixed(0) + 'K' : String(n);
    }
    // 余额格式化：保留小数点后 2 位（去除尾随 0；余额极小(<0.01)用 4 位避免失真为 0.00）
    function fmtBalance(n) {
      if (n == null || n === '') return '—';
      const v = Number(n);
      if (Number.isNaN(v)) return String(n);
      const abs = Math.abs(v);
      if (abs > 0 && abs < 0.01) return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') || '0';
    }

    const currentProviderModels = computed(() => {
      if (!agentDlg.form) return [];
      const p = store.providers.find((x) => x.id === agentDlg.form.providerId);
      return p ? p.models : [];
    });

    // ── Agent 操作 ──
    function newAgent() {
      agentDlg.isNew = true;
      agentDlg.form = {
        id: '', displayName: '', appId: '', appSecret: '',
        providerId: store.providers[0]?.id || '', modelId: '',
        mcps: [], port: 13600, workdir: 'C:\\D\\opt', enabled: true, systemPrompt: '',
      };
      agentDlg.show = true;
    }
    function openAgent(a) {
      agentDlg.isNew = false;
      agentDlg.form = {
        id: a.id, displayName: a.displayName, appId: a.appId, appSecret: a.appSecret,
        providerId: a.providerId, modelId: a.modelId, mcps: [...a.mcps],
        port: a.port, workdir: a.workdir, enabled: a.enabled, systemPrompt: a.systemPrompt || '',
      };
      agentDlg.show = true;
    }
    function onProviderChange() {
      const p = store.providers.find((x) => x.id === agentDlg.form.providerId);
      agentDlg.form.modelId = p?.models[0]?.id || '';
    }
    async function saveAgent() {
      const f = agentDlg.form;
      if (!f.id) { ElMessage.warning('内部 ID 必填'); return; }
      agentDlg.saving = true;
      try {
        if (agentDlg.isNew) {
          await api('POST', '/api/agents', f);
          ElMessage.success(`Agent ${f.id} 已创建`);
        } else {
          await api('PUT', `/api/agents/${encodeURIComponent(f.id)}`, f);
          ElMessage.success(`Agent ${f.id} 已保存`);
        }
        agentDlg.show = false;
        await reloadAll();
      } catch (e) {
        ElMessage.error(e.message);
      } finally {
        agentDlg.saving = false;
      }
    }
    async function closeAgentDlg() { agentDlg.form = null; }
    async function deleteAgent(a) {
      try {
        await ElMessageBox.confirm(`确认删除 Agent ${a.displayName}?`, '删除', { type: 'warning' });
      } catch { return; }
      await api('DELETE', `/api/agents/${encodeURIComponent(a.id)}`);
      delete runtime[a.id];
      ElMessage.success('已删除');
      reloadAll();
    }
    async function applyAgent(id) {
      applying.value = id;
      try {
        const r = await api('POST', `/api/agents/${encodeURIComponent(id)}/apply`);
        if (r.ok) {
          ElMessage.success(`Agent ${id} 已应用${r.cordisYmlPath ? '（配置已写入）' : ''}`);
          refreshRuntime(id);
        } else {
          ElMessage.error('应用失败: ' + (r.error || ''));
        }
      } catch (e) {
        ElMessage.error('应用失败: ' + e.message);
      } finally {
        applying.value = '';
      }
    }

    async function restartAgent(id) {
      restarting.value = id;
      try {
        const r = await api('POST', `/api/agents/${encodeURIComponent(id)}/restart`);
        if (r.ok) {
          ElMessage.success(r.skipped ? `Agent ${id} 重启已跳过（测试模式）` : `Agent ${id} 服务已重启`);
          refreshRuntime(id);
        } else {
          ElMessage.error('重启失败: ' + (r.error || ''));
        }
      } catch (e) {
        ElMessage.error('重启失败: ' + e.message);
      } finally {
        restarting.value = '';
      }
    }

    // ── Provider 操作 ──
    function newProvider() {
      const p = { id: 'p' + Date.now(), displayName: '新 Provider', plugin: 'llm-pi-ai', apiKeyEnv: '', api: 'openai-completions', models: [] };
      activeProvider.value = [p.id];
      // 直接插入 store 并让用户编辑保存
      store.providers.push(p);
    }
    async function saveProvider(p) {
      try {
        try {
          await api('PUT', `/api/providers/${encodeURIComponent(p.id)}`, p);
        } catch (e) {
          // 新建的 provider 尚未落盘（PUT 404）→ 转 POST 创建
          if (e.status === 404) await api('POST', '/api/providers', p);
          else throw e;
        }
        ElMessage.success('Provider 已保存');
      } catch (e) { ElMessage.error(e.message); }
    }
    async function deleteProvider(p) {
      try {
        await ElMessageBox.confirm(`确认删除 Provider ${p.displayName}? 引用它的 Agent 会失效。`, '删除', { type: 'warning' });
      } catch { return; }
      await api('DELETE', `/api/providers/${encodeURIComponent(p.id)}`);
      ElMessage.success('已删除');
      reloadAll();
    }

    // ── MCP 操作 ──
    function newMcp() {
      const m = { id: 'm' + Date.now(), displayName: '新 MCP', transport: 'streamable-http', serverName: '', url: '', failOnStartupError: false, argsText: '' };
      activeMcp.value = [m.id];
      store.mcps.push(m);
    }
    async function saveMcp(m) {
      try {
        try {
          await api('PUT', `/api/mcps/${encodeURIComponent(m.id)}`, m);
        } catch (e) {
          // 新建的 mcp 尚未落盘（PUT 404）→ 转 POST 创建
          if (e.status === 404) await api('POST', '/api/mcps', m);
          else throw e;
        }
        ElMessage.success('MCP 已保存');
      } catch (e) { ElMessage.error(e.message); }
    }
    async function deleteMcp(m) {
      try {
        await ElMessageBox.confirm(`确认删除 MCP ${m.displayName}?`, '删除', { type: 'warning' });
      } catch { return; }
      await api('DELETE', `/api/mcps/${encodeURIComponent(m.id)}`);
      ElMessage.success('已删除');
      reloadAll();
    }

    // ── 看图配置 ──
    async function saveVision() {
      try {
        await api('PUT', '/api/vision', vision.value || {});
        ElMessage.success('看图配置已保存');
      } catch (e) { ElMessage.error('保存失败: ' + e.message); }
    }
    async function testVision() {
      const imagePath = visionTest.source === 'local' ? String(visionTest.localPath || '').trim() : '__sample__';
      if (!imagePath) { ElMessage.warning('请填图片路径'); return; }
      visionTest.loading = true;
      visionTest.result = '';
      try {
        const r = await api('POST', '/api/vision/test', {
          imagePath: imagePath, task: visionTest.task, extra: visionTest.extra,
        });
        visionTest.result = r.ok ? `✅ 识别成功 (${r.model || ''})\n\n${r.text}` : `❌ ${r.error || '识别失败'}`;
      } catch (e) {
        visionTest.result = '❌ 调用失败: ' + e.message;
      } finally {
        visionTest.loading = false;
      }
    }

    // ── 语音能力（ASR / TTS）──
    async function saveSpeech() {
      try {
        await api('PUT', '/api/speech', speech.value || {});
        ElMessage.success('语音配置已保存');
      } catch (e) { ElMessage.error('保存失败: ' + e.message); }
    }
    // 通用 TTS 试听：用当前默认引擎合成 → 立即播放
    async function testTts() {
      if (!ttsTest.text) { ElMessage.warning('请填文本'); return; }
      ttsTest.loading = true;
      ttsTest.error = '';
      try {
        const r = await api('POST', '/api/speech/tts-test', { text: ttsTest.text });
        if (r.ok && r.dataUrl) playAudio(r.dataUrl);
        else { ttsTest.error = (r.engine ? '[' + r.engine + '] ' : '') + (r.error || '合成失败'); ElMessage.error(ttsTest.error); }
      } catch (e) { ElMessage.error('调用失败: ' + e.message); }
      finally { ttsTest.loading = false; }
    }
    // 语音设计官方示例：加载 + 播放 + 应用到自定义
    async function syncVdSamples() {
      try { const r = await api('GET', '/api/speech/voice-design-samples'); vdSamples.value = r.samples || []; } catch {}
    }
    function playVdSample(s) {
      playAudio('data:' + (s.mediaType || 'audio/wav') + ';base64,' + s.data);
    }
    function applyVdInstruct(s) {
      vdCustom.instruct = s.instruct || '';
      if (speech.value) speech.value.tts.voicedesign.context = s.instruct || '';
      ElMessage.success('已应用官方示例到自定义指令');
    }
    // 语音设计自定义试听：合成后立即播放
    async function testVdCustom() {
      const text = (vdCustom.text || '').trim() || ttsTest.text;
      if (!text) { ElMessage.warning('请填试听文本'); return; }
      ttsTest.loading = true;
      try {
        const r = await api('POST', '/api/speech/tts-test', { text, engine: 'voicedesign', voiceDesc: vdCustom.instruct || undefined });
        if (r.ok && r.dataUrl) playAudio(r.dataUrl);
        else ElMessage.error(r.error || '合成失败');
      } catch (e) { ElMessage.error('调用失败: ' + e.message); }
      finally { ttsTest.loading = false; }
    }
    // 克隆：原音试听 / 预生成克隆声试听（不实时合成，读文件返回）→ 点击即播
    async function playCloneSource(id) {
      try {
        const r = await api('GET', '/api/speech/voice-clone/source?id=' + encodeURIComponent(id));
        if (r.ok) playAudio('data:' + (r.mediaType || 'audio/wav') + ';base64,' + r.data);
        else ElMessage.error(r.error || '读取失败');
      } catch (e) { ElMessage.error(e.message); }
    }
    async function playClonePreview(id) {
      try {
        const r = await api('GET', '/api/speech/voice-clone/preview?id=' + encodeURIComponent(id));
        if (r.ok) playAudio('data:' + (r.mediaType || 'audio/mpeg') + ';base64,' + r.data);
        else ElMessage.error(r.error || '该克隆声未预生成');
      } catch (e) { ElMessage.error(e.message); }
    }
    // 克隆上传：选文件 → 命名 → 添加
    function onCloneFileChange(ev) {
      cloneForm.file = (ev.target && ev.target.files) ? ev.target.files[0] : null;
      cloneForm.msg = null;
    }
    async function addCloneSample() {
      const file = cloneForm.file;
      if (!file) { ElMessage.warning('请先选择音频文件'); return; }
      if (!/\.(mp3|wav)$/i.test(file.name) && !/audio\/(mpeg|wav)/.test(file.type)) { cloneForm.msg = { ok: false, text: '仅支持 mp3/wav 格式' }; return; }
      if (file.size > 10 * 1024 * 1024) { cloneForm.msg = { ok: false, text: '音频需 ≤10MB（参考语音建议 15-60 秒）' }; return; }
      const reader = new FileReader();
      const data = await new Promise((res, rej) => { reader.onload = () => res(String(reader.result).split(',')[1] || ''); reader.onerror = rej; reader.readAsDataURL(file); });
      cloneForm.loading = true;
      cloneForm.msg = null;
      try {
        const r = await api('POST', '/api/speech/voice-clone/add', { name: cloneForm.name, audioBase64: data, mediaType: file.type || 'audio/wav', context: cloneForm.context });
        if (r.ok) {
          cloneForm.msg = { ok: true, text: '已添加克隆音色「' + (r.sample.name || '') + '」' };
          // 刷新 store + speech（含新样本）
          const st = await api('GET', '/api/store'); Object.assign(store, st);
          const sp = await api('GET', '/api/speech'); if (speech.value) Object.assign(speech.value, sp.speech || {});
          cloneForm.name = ''; cloneForm.context = ''; cloneForm.file = null;
          if (cloneFileRef.value) cloneFileRef.value.value = '';
        } else { cloneForm.msg = { ok: false, text: r.error || '添加失败' }; }
      } catch (e) { cloneForm.msg = { ok: false, text: e.message }; }
      finally { cloneForm.loading = false; }
    }
    // ASR 识别测试：加载示例音频（自动，edge TTS 生成并缓存）
    async function loadAsrSample() {
      asrTest.loading = true;
      asrTest.error = '';
      asrTest.result = '';
      try {
        const r = await api('GET', '/api/speech/asr-sample');
        if (!r.ok) { asrTest.error = r.error || '示例音频加载失败'; return; }
        asrTest.sampleBase64 = r.data || '';
        asrTest.sampleUrl = 'data:' + (r.mediaType || 'audio/wav') + ';base64,' + r.data;
        asrTest.sampleText = r.text || '';
      } catch (e) { asrTest.error = '加载失败: ' + e.message; }
      finally { asrTest.loading = false; }
    }
    // ASR 识别测试：识别已加载的示例音频
    async function testAsr() {
      if (!asrTest.sampleBase64) { ElMessage.warning('请先加载示例音频'); return; }
      asrTest.loading = true;
      asrTest.error = '';
      asrTest.result = '';
      try {
        const r = await api('POST', '/api/speech/asr-test', { audioBase64: asrTest.sampleBase64 });
        if (r.ok) asrTest.result = r.text || '';
        else asrTest.error = '识别失败: ' + (r.error || '未知');
      } catch (e) { asrTest.error = '调用失败: ' + e.message; }
      finally { asrTest.loading = false; }
    }

    // ── ComfyUI 生图 ──
    async function loadComfyTemplates() {
      comfyTest.loadingTpl = true;
      try {
        const r = await fetch('/api/comfy/templates');
        const d = await r.json();
        if (!r.ok || !d.ok) { comfyTest.templateNote = '加载模板失败: ' + (d.error || r.status); return; }
        comfyTest.templates = d.templates || [];
        if (!comfyTest.template && comfyTest.templates.length) {
          comfyTest.template = comfyTest.templates[0].file;
        }
        comfyTest.templateNote = '共 ' + comfyTest.templates.length + ' 个模板；带 ✓ 的可直接文生图，反推模板留空 prompt 自动反推';
      } catch (e) {
        comfyTest.templateNote = '加载模板失败: ' + e.message;
      } finally {
        comfyTest.loadingTpl = false;
      }
    }
    function comfyOutputUrl(taskId) {
      return '/api/comfy/output/' + encodeURIComponent(taskId);
    }
    async function runComfyGenerate() {
      if (!comfyTest.prompt && !/反推/.test(comfyTest.template || '')) {
        ElMessage.warning('请填写提示词（非反推模板）');
        return;
      }
      comfyTest.generating = true;
      comfyTest.runningMsg = '生成中（跑 XDN 远程，可能需数十秒~几分钟）…';
      comfyTest.error = '';
      comfyTest.result = null;
      comfyTest.resultText = '';
      try {
        const r = await fetch('/api/comfy/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            template: comfyTest.template || undefined,
            prompt: comfyTest.prompt,
            width: comfyTest.width, height: comfyTest.height,
            seed: comfyTest.seed, steps: comfyTest.steps, cfg: comfyTest.cfg, denoise: comfyTest.denoise,
          }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) { comfyTest.error = '生成失败: ' + (d.error || r.status); return; }
        comfyTest.runningMsg = '';
        comfyTest.result = d;
        comfyTest.resultText = 'task_id=' + d.task_id + ' · type=' + d.type + ' · t_total=' + d.t_total + 's' +
          (d.template ? '\ntemplate=' + d.template : '') +
          (d.xdn_file ? '\nxdn_file=' + d.xdn_file : '');
        ElMessage.success('生图成功，耗时 ' + d.t_total + 's');
      } catch (e) {
        comfyTest.error = '调用失败: ' + e.message;
      } finally {
        comfyTest.generating = false;
        comfyTest.runningMsg = '';
      }
    }

    // ── 注入配置 ──
    async function loadInjection() {
      try {
        const r = await api('GET', '/api/injection');
        injection.enabled = r.enabled !== false;
        injection.global = r.global || '';
      } catch {}
    }
    async function saveInjection() {
      injection.saving = true;
      try {
        const r = await api('PUT', '/api/injection', { enabled: injection.enabled, global: injection.global });
        injection.enabled = r.enabled !== false;
        injection.global = r.global || '';
        ElMessage.success('统一注入已保存（agent 重新 apply 后新会话生效）');
      } catch (e) {
        ElMessage.error('保存失败: ' + e.message);
      } finally {
        injection.saving = false;
      }
    }

    onMounted(reloadAll)
    // 监听独立配置页 iframe 的跳转请求（如概览页点「编辑」→ 切到 Agent 分配置 tab）
    window.addEventListener('message', function (e) {
      try {
        if (e.data && e.data.type === 'gotoTab' && typeof e.data.tab === 'string') setTab(e.data.tab);
      } catch { /* 忽略非 JSON 消息 */ }
    });

    return {
      tab, setTab, loading, store, runtime, applying, restarting, activeProvider, activeMcp,
      vision, visionTest, speech, ttsTest, edgeVoices, xiaomiVoices, aiAgeLabels,
      comfyTest, loadComfyTemplates, runComfyGenerate, comfyOutputUrl,
      agentDlg, pageTitle, providerName, modelLabel, fmtK, fmtBalance, currentProviderModels,
      reloadAll, newAgent, openAgent, onProviderChange, saveAgent, closeAgentDlg,
      deleteAgent, applyAgent, restartAgent, newProvider, saveProvider, deleteProvider,
      newMcp, saveMcp, deleteMcp, saveVision, testVision, saveSpeech, testTts, audioRef,
      vdSamples, vdCustom, syncVdSamples, playVdSample, applyVdInstruct, testVdCustom,
      cloneFileRef, cloneForm, onCloneFileChange, addCloneSample, playCloneSource, playClonePreview,
      asrTest, loadAsrSample, testAsr,
      injection, loadInjection, saveInjection,
      sidebarCollapsed, toggleSidebar,
    };
  },
});

app.use(ElementPlus);
app.mount('#app');

// 放大预览的图片本体点击 = 缩小一级（Element Plus image viewer 支持滚轮缩放：
// 在预览大图上派发一个向下滚轮事件即可触发缩小，避免"只能点关闭缩小"）。
document.addEventListener('click', (ev) => {
  const img = ev.target && ev.target.closest ? ev.target.closest('.el-image-viewer__img') : null;
  if (!img) return;
  const canvas = img.closest('.el-image-viewer__canvas');
  if (canvas) {
    // deltaY>0 = 缩小（对齐 wheel 缩放语义）
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
  }
}, true);
