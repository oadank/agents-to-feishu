// 验证：reply 接口（引用用户消息）能否发 interactive 卡片
const appId = process.env.LARK_TEST_APP_ID || ''; // from env, never hardcode
const appSecret = process.env.LARK_TEST_APP_SECRET || ''; // from env, never hardcode
const userMsgId = 'om_x100b678629c1d0a4c00b1c4e1060c28'; // 之前测试发的卡片 id（用它当"用户消息"引用）

const auth = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
})).json();
const token = auth.tenant_access_token;

const card = {
  schema: '2.0',
  config: { wide_screen_mode: true },
  body: { elements: [{ tag: 'markdown', content: '**回复引用测试**\n这条卡片应显示为回复' }] },
};
const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${userMsgId}/reply`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) }),
});
const json = await resp.json();
console.log('reply interactive code:', json.code, 'msg:', json.msg, json.data?.message_id ? 'msgId=' + json.data.message_id : '');
