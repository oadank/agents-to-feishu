/**
 * 向指定 bot 的【私聊】发测试消息，确认真实对话是否正常。
 * ⚠️ 不发团队群！群聊 @ 会触发所有 bot 回复（群未设"仅@回复"），禁止再发群。
 * 用法：node scripts/feishu-verify.mjs <botName> [message]
 *   botName: claude/codex/mimo/gemini/hermes/openakita/reasonix/openclaw/opencode/dsh
 *   message: 默认 "只回复一句话：收到，连接正常。"
 * 发送身份：user（陈丹），--user-id 私聊直发，无需 @（私聊里只有目标 bot 收得到）
 * （发给其他 bot 必须 user 身份；bot 身份消息任何 bot 收不到）
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// 每个 bot 的 open_id（实际查询自 im +chat-members-list，勿凭记忆）
const OPEN_IDS = {
  claude:    'ou_406738ac0fe3c798603fe18a54216bda',
  codex:     'ou_90370090e13f91c0f70b124fd08e5d12',
  mimo:      'ou_50c0eb98529734e5d0f65d29705d69ee',
  gemini:    'ou_3d666bf313f6412d94622380d4c39eb2',
  hermes:    'ou_4039e3c0ec55cc507c50a0cc99f4d55a',
  openakita: 'ou_deb99befe2fc9e1e3554e5078b42d8b3',
  reasonix:  'ou_accc1f5827f5f4248fce951e648529e7',
  openclaw:  'ou_256578a0840e67ff4dd9fe37a5e52e9d',
  opencode:  'ou_5e9935ef9500223662a01f137acc2511',
  dsh:       'ou_92f917e7c68400546379591b91e49b5f',
};

const bot = process.argv[2];
const message = process.argv[3] || '只回复一句话：收到，连接正常。';
if (!OPEN_IDS[bot]) {
  console.error(`未知 bot: ${bot}。可选: ${Object.keys(OPEN_IDS).join('/')}`);
  process.exit(1);
}
const openId = OPEN_IDS[bot];

const runJs = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
const args = ['im', '+messages-send', '--user-id', openId, '--text', message, '--as', 'user'];
const r = spawnSync(process.execPath, [runJs, ...args], { encoding: 'utf8', timeout: 60000 });
console.log(`[send → DM ${bot}]`);
console.log(r.stdout);
if (r.stderr) console.error('STDERR:', r.stderr.slice(0, 400));
if (r.status !== 0) process.exit(r.status || 1);
