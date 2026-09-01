/**
 * codex 端到端探针（2026-09-01）
 * 用途：验证 codex bot 用的 provider 真能跑通一轮对话，而不是等用户在飞书里试错。
 * 背景：共享 ~/.codex/config.toml 被 Cumora 改成 litellmchat（env_key=LITELLM_API_KEY），
 *       codex bot 环境里没有该 key → 每个 bot 一问就报 "Missing environment variable: LITELLM_API_KEY"。
 * 用法：node scripts/codex-probe.mjs [提示词]
 * 说明：会真实消耗一次极小的模型调用（默认提示词 8 个字）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ENV_FILE = 'C:/Users/oadan/.agents-to-feishu/config.codex.env';

// 1) 载入 bot 环境（与 nssm 服务一致）
const raw = fs.readFileSync(ENV_FILE, 'utf8');
for (const line of raw.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(line.trim());
  if (!m) continue;
  process.env[m[1]] = m[2];
}
process.env.CTI_BOT = 'codex';
process.env.CTI_HOME = 'C:/Users/oadan/.agents-to-feishu';

const { CodexAppServerClient } = await import('../src/providers/codex/codex-app-server-client.ts');

const prompt = process.argv[2] || '只回复两个字：收到';
const model = process.env.CTI_BOT_CODEX_MODEL || '';
const providerId = process.env.CTI_BOT_CODEX_PROVIDER_ID || '';
console.log(`[probe] provider=${providerId} model=${model}`);

const client = new CodexAppServerClient('codex');
const unsub = client.subscribe((msg) => {
  if (msg && typeof msg === 'object' && msg.method === 'item/agentMessage/delta') {
    const d = msg.params && typeof msg.params === 'object' ? msg.params.delta : '';
    if (typeof d === 'string') process.stdout.write(d);
  }
});

const t0 = Date.now();
try {
  await client.prepare();
  console.log(`[probe] app-server ready (${Date.now() - t0}ms)`);
  const thread = await client.call('thread/start', {
    experimentalRawEvents: true,
    persistExtendedHistory: true,
    cwd: process.env.CTI_DEFAULT_WORKDIR || 'C:/D/opt',
    ...(model ? { model } : {}),
  });
  const threadId = String(thread?.thread?.id || '');
  if (!threadId) throw new Error('thread/start: missing thread id');
  console.log(`[probe] thread=${threadId}`);
  await client.call('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt }],
    ...(process.env.CTI_DEFAULT_WORKDIR ? { cwd: process.env.CTI_DEFAULT_WORKDIR } : {}),
  });
  await new Promise((r) => setTimeout(r, 20000));
  console.log(`\n[probe] 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s —— 若上方有模型文字则 provider 正常`);
} catch (e) {
  console.log(`\n[probe] 失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  unsub();
  client.close();
}
