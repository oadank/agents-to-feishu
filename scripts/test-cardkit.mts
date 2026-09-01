/**
 * CardKit 全链路自测（不依赖服务）：
 * create 卡片实体 → 引用用户消息发送 → cardElement.content 增量 → settings summary
 */
import lark from '@larksuiteoapi/node-sdk';

const appId = process.env.LARK_TEST_APP_ID || ''; // from env, never hardcode
const appSecret = process.env.LARK_TEST_APP_SECRET || ''; // from env, never hardcode
const userMsgId = 'om_x100b678629c1d0a4c00b1c4e1060c28'; // 引用这条（用户消息）

const client = new lark.Client({ appId, appSecret });

const STREAM_ELEMENT_ID = 'stream_content';
const skeleton = {
  schema: '2.0',
  config: { wide_screen_mode: true, update_multi: true, streaming_mode: true, summary: { content: '🤖 努力回答中...' } },
  body: { elements: [{ tag: 'markdown', content: '🤖 努力回答中...', element_id: STREAM_ELEMENT_ID }] },
};

// 1. create 卡片实体
console.log('=== 1. cardkit create ===');
const created = await client.cardkit.v1.card.create({ data: { type: 'card_json' as never, data: JSON.stringify(skeleton) } });
console.log('code:', created?.code, 'msg:', created?.msg, 'card_id:', created?.data?.card_id);
const cardId = created?.data?.card_id;
if (!cardId) process.exit(1);

// 2. 引用用户消息发送
console.log('\n=== 2. reply 发送 card_id ===');
const tokenResp = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
})).json();
const token = tokenResp.tenant_access_token;
const sendResp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${userMsgId}/reply`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }) }),
});
const sendJson = await sendResp.json();
console.log('code:', sendJson.code, 'msg:', sendJson.msg, 'message_id:', sendJson.data?.message_id);

// 3. cardElement.content 增量更新
console.log('\n=== 3. cardElement.content 更新 ===');
const upd1 = await client.cardkit.v1.cardElement.content({
  path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
  data: { content: '**第一段正文**\n1+1=2', sequence: 1 },
});
console.log('seq=1 code:', upd1?.code, 'msg:', upd1?.msg);

// 4. settings 更新 summary
console.log('\n=== 4. card.settings 更新 summary ===');
const set1 = await client.cardkit.v1.card.settings({
  path: { card_id: cardId },
  data: { settings: JSON.stringify({ summary: { content: '✅ 回答完成' } }), sequence: 2 },
});
console.log('code:', set1?.code, 'msg:', set1?.msg);

console.log('\n✅ CardKit 链路自测完成（请去飞书看那张卡片）');
