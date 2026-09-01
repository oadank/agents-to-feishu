// 私聊巡检：按 open_id 直发（自动建私聊），逐个间隔 12s 避开飞书限流。
// 只发纯文本（不走群），用于验证各 bot 的接收/解析/回复链路。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const TARGETS = {
  codex: 'ou_90370090e13f91c0f70b124fd08e5d12',
  gemini: 'ou_3d666bf313f6412d94622380d4c39eb2',
  hermes: 'ou_4039e3c0ec55cc507c50a0cc99f4d55a',
  mimo: 'ou_50c0eb98529734e5d0f65d29705d69ee',
  openakita: 'ou_deb99befe2fc9e1e3554e5078b42d8b3',
  opencode: 'ou_5e9935ef9500223662a01f137acc2511',
  openclaw: 'ou_256578a0840e67ff4dd9fe37a5e52e9d',
  reasonix: 'ou_accc1f5827f5f4248fce951e648529e7',
};
const text = process.argv[2] || '私聊巡检：收到请只回复一句话（收到，连接正常）';
const runJs = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

for (const [bot, openId] of Object.entries(TARGETS)) {
  const r = spawnSync(process.execPath, [runJs, 'im', '+messages-send', '--user-id', openId, '--text', text, '--as', 'user'], { encoding: 'utf8', timeout: 60000 });
  const ok = r.stdout.includes('"ok": true');
  const mid = r.stdout.match(/om_[a-z0-9]+/)?.[0] || '-';
  console.log(`${new Date().toISOString().slice(11, 19)} ${bot.padEnd(10)} ok=${ok} mid=${mid}`);
  await new Promise((res) => setTimeout(res, 12000));
}
console.log('done');
