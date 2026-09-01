// 直接 HTTP 验证：飞书 API 到底能不能发 interactive 卡片
const appId = process.env.LARK_TEST_APP_ID || ''; // from env, never hardcode
const appSecret = process.env.LARK_TEST_APP_SECRET || ''; // from env, never hardcode

// 1. 拿 token
const authResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const auth = await authResp.json();
console.log('token code:', auth.code, 'msg:', auth.msg);
const token = auth.tenant_access_token;

// 2. 用 im/v1/messages 发 interactive 卡片（老 API 方式）
const card = {
  config: { wide_screen_mode: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: '测试卡片' } },
  elements: [{ tag: 'markdown', content: '**这是测试**' }],
};
const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({
    receive_id: 'oc_bb907084f5d95404e29d3f0bde5a768b',
    msg_type: 'interactive',
    content: JSON.stringify(card),
  }),
});
const json = await resp.json();
console.log('interactive create code:', json.code, 'msg:', json.msg);
if (json.data?.message_id) console.log('message_id:', json.data.message_id);
