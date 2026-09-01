/**
 * engine 全链路自测（不依赖 nssm 服务）：
 * 真实 DSH provider + engine.handleText，发到飞书 chat，引用一条真实消息。
 * 验证：CardKit 创建 → 引用发送 → 思考代码块 → 正文流式 → 最终分割线。
 */
import { loadConfig } from '../src/config.js';
import { FeishuClient } from '../src/feishu/client.js';
import { SessionManager } from '../src/bridge/session.js';
import { MessageEngine } from '../src/bridge/engine.js';
import { createDshProvider } from '../src/providers/dsh.js';

const chatId = 'oc_bb907084f5d95404e29d3f0bde5a768b';
const replyTo = 'om_x100b678629c1d0a4c00b1c4e1060c28'; // 引用的"用户消息"

const { bot } = loadConfig();
const feishu = new FeishuClient({ appId: bot.appId, appSecret: bot.appSecret });
const provider = createDshProvider();
await provider.prepare();
const sessions = new SessionManager({ defaultWorkdir: bot.defaultWorkdir, onSessionReset: async () => {} });
const engine = new MessageEngine({
  feishu, provider, sessions,
  botName: bot.agentName,
  modelGroup: bot.modelGroup,
  modelProvider: bot.modelProvider,
  showToolCallCards: true,
  showAgentDivider: true,
});

console.log(`=== handleText(引用 ${replyTo.slice(0, 12)}): 1+1=? ===`);
await engine.handleText(chatId, '1+1=?', replyTo);
console.log('=== handleText 完成 ===');
await provider.dispose();
console.log('✅ 自测完成（去飞书看卡片）');
