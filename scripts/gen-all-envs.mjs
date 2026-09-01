/**
 * 为 config-store.json 中所有 enabled agent 重新生成 config.<id>.env（writeAgentArtifacts）。
 * 用于 config-store 更新（如 systemPrompt 人设）后同步渲染，重启服务即生效。
 */
import { readStore, defaultStorePath } from '../src/config-center/store.js';
import { writeAgentArtifacts } from '../src/config-center/render.js';

// 2026-09-01 setup 参数化：store 路径走 defaultStorePath()（尊重 CTI_USER_HOME），
// 兼容 --store <路径> 显式指定
const storeFile = process.argv[2]?.match(/^--store=(.+)$/)?.[1]
  || process.env.CTI_SETUP_STORE || defaultStorePath();
const store = readStore(storeFile);
console.log(`store: ${storeFile}`);
let ok = 0, fail = 0;
for (const a of store.agents) {
  if (!a.enabled) continue;
  try {
    const out = writeAgentArtifacts(store, a, {});
    console.log(`[ok] ${a.id}: env=${out.configEnvPath}`);
    ok++;
  } catch (e) { console.log(`[FAIL] ${a.id}: ${e.message}`); fail++; }
}
console.log(`done: ok=${ok} fail=${fail}`);
