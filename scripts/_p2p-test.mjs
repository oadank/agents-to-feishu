// 临时脚本：按 open_id 直发（自动建私聊），只发 6 个失效 chat_id 的 bot。用完即删。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const OPEN_IDS = {
  mimo: 'ou_50c0eb98529734e5d0f65d29705d69ee',
  gemini: 'ou_3d666bf313f6412d94622380d4c39eb2',
  hermes: 'ou_4039e3c0ec55cc507c50a0cc99f4d55a',
  openakita: 'ou_deb99befe2fc9e1e3554e5078b42d8b3',
  opencode: 'ou_5e9935ef9500223662a01f137acc2511',
  openclaw: 'ou_256578a0840e67ff4dd9fe37a5e52e9d',
};
const text = '私聊巡检：收到请只回复一句话';
const runJs = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

for (const [bot, openId] of Object.entries(OPEN_IDS)) {
  const r = spawnSync(process.execPath, [runJs, 'im', '+messages-send', '--user-id', openId, '--text', text, '--as', 'user'], { encoding: 'utf8', timeout: 60000 });
  const ok = r.stdout.includes('"ok": true');
  const mid = r.stdout.match(/om_[a-z0-9]+/)?.[0] || '-';
  console.log(`${new Date().toISOString().slice(11, 19)} ${bot.padEnd(10)} ok=${ok} mid=${mid}`);
  await new Promise((res) => setTimeout(res, 12000));
}
