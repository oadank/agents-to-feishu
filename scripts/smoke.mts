/**
 * 冒烟测试：验证配置加载 + 会话管理（不连飞书）
 * 运行：npx tsx scripts/smoke.mts
 */
import { loadConfig, parseEnvFile } from '../src/config.js';
import { SessionManager } from '../src/bridge/session.js';

// 1. parseEnvFile 单测
const parsed = parseEnvFile(`
# 注释
CTI_BOT_DSH_APP_ID=cli_a93fe9c803b89cc8
CTI_FEISHU_ALLOWED_USERS=*
EMPTY=
"QUOTED"="hello world"
`);
console.log('[1] parseEnvFile:', JSON.stringify(parsed));
if (parsed.CTI_BOT_DSH_APP_ID !== 'cli_a93fe9c803b89cc8') throw new Error('parseEnvFile APP_ID failed');
if (parsed.QUOTED !== 'hello world') throw new Error('parseEnvFile QUOTED failed');

// 2. loadConfig 用临时 env
const { bot, botName } = loadConfig({
  env: {
    CTI_HOME: 'C:\\D\\opt\\agents-to-feishu',
    CTI_BOT: 'dsh',
    CTI_BOT_DSH_APP_ID: 'cli_a93fe9c803b89cc8',
    CTI_BOT_DSH_APP_SECRET: 'test-secret',
    CTI_BOT_DSH_RUNTIME: 'dsh',
    CTI_BOT_DSH_AGENT_NAME: 'DSH',
    CTI_BOT_DSH_MODEL_GROUP: 'deepseek-v4-flash',
    CTI_DSH_HARNESS_PATH: 'C:\\D\\opt\\deepseek-harness\\deepseek-harness',
  },
});
console.log('[2] loadConfig:', JSON.stringify(bot));
if (bot.appId !== 'cli_a93fe9c803b89cc8') throw new Error('loadConfig appId failed');
if (botName !== 'dsh') throw new Error('loadConfig botName failed');

// 3. SessionManager 单测：/new 真正新建空会话
let resetCalls = 0;
const sm = new SessionManager({
  defaultWorkdir: 'C:\\D\\opt',
  onSessionReset: async () => { resetCalls++; },
});
const s1 = sm.getOrCreate('chat-1');
s1.context.push({ role: 'user', content: '旧上下文' });
s1.usage.inputTokens = 100;
const oldId = s1.id;
const s2 = await sm.reset('chat-1');
console.log('[3] /new reset: oldId=', oldId.slice(0, 8), 'newId=', s2.id.slice(0, 8), 'fresh=', sm.consumeFresh(s2), 'resetCalls=', resetCalls);
if (s2.id === oldId) throw new Error('/new 没有生成新 id！');
if (s2.context.length !== 0) throw new Error('/new 没有清空上下文！');
if (s2.usage.inputTokens !== 0) throw new Error('/new 没有重置 usage！');
if (resetCalls !== 1) throw new Error('/new 没有触发 provider reset！');

console.log('\n✅ 全部冒烟测试通过');
