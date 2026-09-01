/**
 * 插队卡 guard 回归测试（不依赖飞书/nssm，全 mock）：
 * 背景 bug：点按钮后插队卡"更新成功又还原成带按钮原卡"——根因是 busy 期间每条新消息都触发
 * sendInterruptCard 再发一张新卡。
 * 修复：enqueueChat 队列排空（busy 结束）时清 interruptCardMessages + autoInterruptTimers，
 * 让 guard 只覆盖「当前 busy 周期」。
 *
 * 本测试验证：
 *  1) 同一 busy 周期内，同 chat 多次触发 sendInterruptCard → 只发一张卡（防"还原"）
 *  2) busy 结束（队列排空）后，再次触发 → 允许发新卡（防"永不再发卡"）
 */
import { MessageEngine } from '../src/bridge/engine.js';
import { SessionManager } from '../src/bridge/session.js';

// 短自动插队延时，避免测试进程被定时器拖住
process.env.CTI_AUTO_INTERRUPT_MS = '100';

const sentCards: string[] = [];
let cardSeq = 0;

const fakeFeishu: any = {
  replyCardHttp: async () => {
    const id = `om_fakecard_${++cardSeq}`;
    sentCards.push(id);
    return id;
  },
  updateCardHttp: async () => true,
};

const fakeProvider: any = {
  name: 'fake',
  prepare: async () => {},
  interrupt: async () => {},
  streamChat: async function* () {},
  resetSession: async () => {},
  dispose: async () => {},
};

const sessions = new SessionManager({ defaultWorkdir: 'C:\\', onSessionReset: async () => {} });
const engine = new MessageEngine({
  feishu: fakeFeishu,
  provider: fakeProvider,
  sessions,
  botName: 'test',
  modelGroup: 'm',
  modelProvider: 'p',
  showToolCallCards: false,
  showAgentDivider: false,
} as any);

const chatId = 'oc_test_chat_0001';
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

console.log('=== 1. busy 周期内：同 chat 两条消息触发发卡 → 只发一张 ===');
await engine.enqueueChat(chatId, async () => {
  // 队列非空 = busy，模拟同周期内第二条新消息又触发发卡
  await engine.sendInterruptCard(chatId, 'om_msg_0001');
  await engine.sendInterruptCard(chatId, 'om_msg_0002');
});
check('busy 期间只发送了 1 张卡（第 2 次被 guard 拦下）', sentCards.length === 1);
check('这张卡是第一条消息的 reply', sentCards[0] === 'om_fakecard_1');

console.log('=== 2. busy 结束（队列排空）后：允许重新发卡 ===');
await engine.sendInterruptCard(chatId, 'om_msg_0003');
check('排空后新发卡成功（累计 2 张）', sentCards.length === 2 && sentCards[1] === 'om_fakecard_2');

// 等最后一个自动插队定时器走完，避免测试进程挂住
await new Promise((r) => setTimeout(r, 250));

console.log('=== 3. 按钮回调返回新卡（card:{type:raw}）——根因修复 ===');
// 先有一张在处理的插队卡（entry 存在，模拟点按钮时的状态）
await engine.sendInterruptCard(chatId, 'om_msg_0004');
const act = await engine.handleInterruptAction('yes', chatId, 'om_msg_0004');
check('yes 回调返回 card.type=raw', act.card?.type === 'raw');
const cardJson = JSON.stringify(act.card?.data ?? '');
check('回调卡为终态无按钮', cardJson.includes('已立即插队') && !cardJson.includes('button') && !cardJson.includes('column_set'));

console.log(fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
