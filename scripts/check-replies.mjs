// 干净版：逐个查 9 个 bot 私聊，提取每条 sender_type=app 的回复正文，判断是否"收到连接正常"
import { execFileSync } from 'node:child_process';

const map = {
  claude: 'oc_7f7cfb8b27bf00659df8bf1d41120188',
  codex: 'oc_5373b412323c2f5ed384244870fae5f2',
  mimo: 'oc_136c904df443d621a4c48',
  gemini: 'oc_99d9c5f91c43ca8de80a7',
  hermes: 'oc_8be2bbd3272fab1e99e76',
  openakita: 'oc_fff6094e0be868be026c5',
  reasonix: 'oc_d8a3abf10296551ffeb332381bc26e96',
  openclaw: 'oc_e383d84b7ba48a529ff27',
  opencode: 'oc_09998955bd822cfd297fb',
};

function run(args) {
  try { return execFileSync('cmd.exe', ['/c', 'lark-cli', ...args], { encoding: 'utf8' }); }
  catch (e) { return e.stdout || e.message || ''; }
}

for (const [name, cid] of Object.entries(map)) {
  let out = run(['im', '+chat-messages-list', '--chat-id', cid]);
  // 拆成消息对象：按 "message_id" 切块
  const blocks = out.split('"message_id":');
  const appReplies = [];
  for (const b of blocks) {
    if (!b.includes('"sender_type": "app"')) continue;
    // 抓该块 content
    const cm = b.match(/"content":\s*"([\s\S]*?)",\s*\n\s*"create_time"/);
    const sm = b.match(/"sender_type":\s*"([^"]+)"/);
    if (!cm ) continue;
    let content = cm[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\\n/g, ' ')
      .replace(/\\(u003c|u003e)/g, char => char.includes('u003c') ? '<' : '>')
      .replace(/\s+/g, ' ').trim();
    appReplies.push(content.slice(0, 120));
  }
  const latest = appReplies[0] || '(无 app 回复)';
  const pass = latest.includes('收到') && latest.includes('连接正常');
  console.log(`\n== ${name}: ${pass ? 'PASS' : 'CHECK'}`);
  console.log(`   newest app: ${latest}`);
}
