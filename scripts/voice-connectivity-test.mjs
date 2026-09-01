// 连通性测试：给 9 个 bot 私聊发测试语，等待，拉取各自回复，判断是否回"收到，连接正常"
import { execFileSync } from 'node:child_process';

const BOTS = [
  ['claude', 'ou_406738ac0fe3c798603fe18a54216bda'],
  ['codex', 'ou_90370090e13f91c0f70b124fd08e5d12'],
  ['mimo', 'ou_50c0eb98529734e5d0f65d29705d69ee'],
  ['gemini', 'ou_3d666bf313f6412d94622380d4c39eb2'],
  ['hermes', 'ou_4039e3c0ec55cc507c50a0cc99f4d55a'],
  ['openakita', 'ou_deb99befe2fc9e1e3554e5078b42d8b3'],
  ['reasonix', 'ou_accc1f5827f5f4248fce951e648529e7'],
  ['openclaw', 'ou_256578a0840e67ff4dd9fe37a5e52e9d'],
  ['opencode', 'ou_5e9935ef9500223662a01f137acc2511'],
];

function run(cmd) {
  try {
    return execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', shell: false });
  } catch (e) {
    return e.stdout || e.message || '';
  }
}

// 发消息，拿 chat_id + message_id
const chats = {};
const PROMPT = '只回复一句话：收到，连接正常。';
for (const [name, uid] of BOTS) {
  const out = run(['lark-cli', 'im', '+messages-send', '--user-id', uid, '--text', PROMPT, '--as', 'user']);
  const m = out.match(/"chat_id":\s*"([^"]+)"/);
  chats[name] = m ? m[1] : null;
  console.log(`[send] ${name} chat=${chats[name] ? chats[name].slice(0,20) : '???'}`);
}

// 等待回复
await new Promise(r => setTimeout(r, 25000));

// 拉每个私聊最新消息，找 bot 的回复
for (const [name] of BOTS) {
  const cid = chats[name];
  if (!cid) { console.log(`\n== ${name}: 无法拿到 chat_id`); continue; }
  const out = run(['lark-cli', 'im', '+chat-messages-list', '--chat-id', cid]);
  // 提取所有消息：sender name + content 摘要
  const lines = out.split('\n');
  let botReply = '';
  // 简单解析：找 sender_type app 的消息和 text/card 内容
  let buf = '';
  const blocks = out.split(/\n\s*\n/);
  // 每个消息对象在 "msg_type": 附近
  const msgs = out.match(/"msg_type":\s*"([^"]+)",\s*\n\s*"content":\s*"([\s\S]*?)",/g) || [];
  let firstBotText='';
  for (const blk of out.match(/sender_type":\s*"app"[\s\S]*?"content":\s*"([\s\S]*?)",\s*\n\s*"create_time"/g) || []) {
    const c = blk.match(/"content":\s*"(.*)",\s*\n\s*"create_time"/);
    if (c) { firstBotText = c[1].slice(0,150); break; }
  }
  console.log(`\n== ${name} (chat ${cid.slice(0,16)}):`);
  console.log(`   bot 回复: ${firstBotText || '(无 app 回复)'}`);
}
