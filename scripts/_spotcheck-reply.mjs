// 抽测回复轮询：node scripts/_spotcheck-reply.mjs <botName> [sinceHHMM]
// 读取 bot 私聊里 sender_type=app 的新回复正文（含卡片纯文本提取），只打印，不做判断。
import { execFileSync } from 'node:child_process';

const CHATS = {
  claude: 'oc_7f7cfb8b27bf00659df8bf1d41120188',
  codex: 'oc_5373b412323c2f5ed384244870fae5f2',
  mimo: 'oc_136c904df443d621a4c48a43fe11505b', // 2026-09-01 用发送回执补全
  gemini: 'oc_99d9c5f91c43ca8de80a765c838a7b04', // 2026-09-01 用发送回执补全
  hermes: 'oc_8be2bbd3272fab1e99e76d17bf111aae', // 2026-09-01 用发送回执补全
  openakita: 'oc_fff6094e0be868be026c56be98352e1e', // 2026-09-01 修正：原来少了尾部 6be98352e1e
  reasonix: 'oc_d8a3abf10296551ffeb332381bc26e96',
  openclaw: 'oc_e383d84b7ba48a529ff270fde9b9e344', // 2026-09-01 用发送回执补全
  opencode: 'oc_09998955bd822cfd297fb746764c974a', // 2026-09-01 用发送回执补全
  dsh: 'oc_bb907084f5d95404e29d3f0bde5a768b',
};

const bot = process.argv[2];
const cid = process.argv[3] && process.argv[3].startsWith('oc_') ? process.argv[3] : CHATS[bot];
if (!cid) { console.error(`未知 bot: ${bot}`); process.exit(1); }

let out = '';
try {
  out = execFileSync('cmd.exe', ['/c', 'lark-cli', 'im', '+chat-messages-list', '--chat-id', cid, '--as', 'user'], { encoding: 'utf8', timeout: 60000 });
} catch (e) { out = e.stdout || e.message || ''; }

const blocks = out.split('"message_id":');
for (const b of blocks) {
  if (!b.includes('"sender_type": "app"') && !b.includes('"sender_type":"app"')) continue;
  const tm = b.match(/"create_time":\s*"([\d\- :]+)"/);
  const cm = b.match(/"content":\s*"([\s\S]*?)",\s*\n\s*"create_time"/) || b.match(/"content":\s*"([\s\S]*?)"/);
  if (!cm) continue;
  let content = cm[1]
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .trim();
  if (content.length > 800) content = content.slice(0, 800) + ' …(截断)';
  console.log(`[${tm ? tm[1] : '??'}] ${content}`);
  console.log('---');
}
