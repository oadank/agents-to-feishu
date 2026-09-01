/**
 * 逐个验证 agents-to-feishu 各 agent 在 config.<id>.env 配置下能真实对话。
 * 用法：node --import tsx/esm scripts/verify-all.mjs [agentId1 agentId2 ...]
 *   不带参数 = 全部 agents；也可单个/多个指定。
 * 每个 agent：加载 config.<id>.env → 创建对应 provider → streamChat 一句测试话 → 收集文字回复/错误。
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = 'C:\\Users\\oadan';
const ENV_DIR = path.join(HOME, '.agents-to-feishu');

// agentId -> 模块相对路径 + 工厂函数名 + runtime 类型
const FACTORIES = {
  claude:    { mod: '../src/providers/claude.js',    fn: 'createClaudeProvider' },
  codex:     { mod: '../src/providers/codex.js',     fn: 'createCodexProvider' },
  mimo:      { mod: '../src/providers/mimo.js',      fn: 'createMiMoProvider' },
  gemini:    { mod: '../src/providers/gemini.js',    fn: 'createGeminiProvider' },
  hermes:    { mod: '../src/providers/hermes.js',    fn: 'createHermesProvider' },
  openakita: { mod: '../src/providers/openakita.js', fn: 'createOpenAkitaProvider' },
  openclaw:  { mod: '../src/providers/openclaw.js',  fn: 'createOpenClawProvider' },
  opencode:  { mod: '../src/providers/opencode.js',  fn: 'createOpencodeProvider' },
  reasonix:  { mod: '../src/providers/reasonix.js',  fn: 'createReasonixProvider' },
  dsh:       { mod: '../src/providers/dsh.js',       fn: 'createDshProvider' },
};

function loadEnv(agentId) {
  const f = path.join(ENV_DIR, `config.${agentId}.env`);
  if (!fs.existsSync(f)) throw new Error(`env 文件不存在: ${f}`);
  const txt = fs.readFileSync(f, 'utf-8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      let v = m[2];
      const qm = v.match(/^"(.*)"$/s);
      if (qm) v = qm[1];
      else {
        // 配置中心用 JSON.stringify 编码（可能多行/含引号），尝试还原
        if (v.startsWith('"')) { try { v = JSON.parse(v); } catch {} }
      }
      process.env[m[1]] = v;
    }
  }
}

async function verifyOne(agentId) {
  const spec = FACTORIES[agentId];
  if (!spec) { console.log(`[SKIP] ${agentId}: 未知 runtime`); return false; }
  try {
    loadEnv(agentId);
    const { [spec.fn]: create } = await import(spec.mod);
    const p = create();
    console.log(`\n========== ${agentId} ==========`);
    console.log(`[prepare] ${agentId} ...`);
    await p.prepare();
    const gen = p.streamChat({
      text: '只回复一句话：收到，连接正常。',
      systemPrompt: process.env[`CTI_BOT_${agentId.toUpperCase()}_SYSTEM_PROMPT`] || '',
      sessionKey: `verify-${Date.now()}`,
      freshSession: true,
    });
    let gotText = false;
    for await (const ev of gen) {
      if (ev.type === 'text') { gotText = true; console.log('[TEXT]', (ev.text || '').slice(0, 200)); }
      else if (ev.type === 'thinking') console.log('[THINK]', (ev.text || '').slice(0, 60));
      else if (ev.type === 'error') console.log('[ERROR]', ev.message);
      else if (ev.type === 'done') console.log('[DONE]');
    }
    await p.dispose().catch(() => {});
    console.log(`[RESULT] ${agentId}: ${gotText ? 'PASS（有文字回复）' : 'FAIL（无文字回复）'}`);
    return gotText;
  } catch (e) {
    console.log(`[RESULT] ${agentId}: FAIL（异常 ${e instanceof Error ? e.message : String(e)}）`);
    return false;
  }
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FACTORIES);
let pass = 0, fail = 0;
for (const id of targets) {
  if (await verifyOne(id)) pass++; else fail++;
}
console.log(`\n===== 汇总: pass=${pass} fail=${fail} total=${targets.length} =====`);
