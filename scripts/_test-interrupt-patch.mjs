import fs from 'node:fs';
const env = fs.readFileSync('C:\\Users\\oadan\\.agents-to-feishu\\config.claude.env','utf8');
const appId = env.match(/CTI_BOT_CLAUDE_APP_ID=(.+)/)?.[1].trim();
const appSecret = env.match(/CTI_BOT_CLAUDE_APP_SECRET=(.+)/)?.[1].trim();
const chatId = process.argv[2] || 'oc_7f7cfb8b27bf00659df8bf1d41120188';
(async () => {
  const t = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:appId,app_secret:appSecret})})).json();
  if(t.code!==0){ console.log('TOKEN FAIL', t); return; }
  const token = t.tenant_access_token;
  console.log('token ok');
  const card = { schema:'2.0', config:{wide_screen_mode:true}, body:{elements:[
    {tag:'markdown', content:'🗓 测试PATCH卡（发卡时）'},
    {tag:'column_set', columns:[{tag:'column', width:'auto', elements:[{tag:'button', text:{tag:'plain_text',content:'点我'}, type:'primary', value:{k:'v'}}]}]}
  ]}};
  const send = await (await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({receive_id:chatId,msg_type:'interactive',content:JSON.stringify(card)})})).json();
  console.log('SEND', send.code, send.msg, send.data?.message_id);
  const mid = send.data?.message_id;
  if(!mid){ return; }
  const newCard = { schema:'2.0', config:{wide_screen_mode:true, update_multi:true}, body:{elements:[{tag:'markdown', content:'✅ 已更新（PATCH后）无按钮'}]}};
  const p = await (await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${mid}`,{method:'PATCH',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({content:JSON.stringify(newCard)})})).json();
  console.log('PATCH', JSON.stringify(p));
})();
