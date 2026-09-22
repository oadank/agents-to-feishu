// transcribe_audio.mjs — 通用「本地音频 → 飞书妙记逐字稿」一步（复刻流水线环节②）
// 用法: node transcribe_audio.mjs <目录> [音频文件名=audio.mp3] 
// 产物: <目录>/transcript.飞书妙记.md + 打印 minute_url
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const DIR = process.argv[2];
const AUDIO = process.argv[3] || 'audio.mp3';
if (!DIR || !existsSync(join(DIR, AUDIO))) { console.error('用法: node transcribe_audio.mjs <目录> [音频名]，且目录里要有该音频'); process.exit(2); }

function run(args, cwd = DIR) {
  // lark-cli 是 .cmd 垫片，必须 shell:true（照抄 video_kb.mjs 的姿势）
  return execFileSync('lark-cli', args, { cwd, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
}
function jsonOf(s) {
  // 非贪婪：行首{ 到最近的行首}，防吞尾随日志（video_kb 踩过的坑）
  const m = String(s).match(/^\{[\s\S]*?^\}/m);
  if (!m) throw new Error('no JSON in output:\n' + String(s).slice(0, 800));
  return JSON.parse(m[0]);
}

console.log('① 上传音频到云空间…');
const up = jsonOf(run(['drive', '+upload', '--file', AUDIO, '--name', 'kb-arcane-thief-01.mp3', '--as', 'user', '--format', 'json']));
const fileToken = up.data.file_token;
console.log('   file_token =', fileToken);

console.log('② 生成妙记…');
const mi = jsonOf(run(['minutes', '+upload', '--file-token', fileToken, '--as', 'user', '--format', 'json']));
const minuteToken = mi.data.minute_token, minuteUrl = mi.data.minute_url;
console.log('   妙记 =', minuteUrl);

console.log('③ 等转写完成并拉逐字稿/关键词/总结（可能要几分钟）…');
const dt = jsonOf(run(['minutes', '+detail', '--minute-tokens', minuteToken, '--wait-ready', '--transcript', '--keyword', '--summary', '--as', 'user', '--format', 'json']));
const art = dt.data.minutes[0].artifacts || {};
let transcript = art.transcript || '';
if (!transcript) { // +detail 可能只落盘到 cwd/minutes/<token>/transcript.txt
  const f = join(DIR, 'minutes', minuteToken, 'transcript.txt');
  if (existsSync(f)) transcript = readFileSync(f, 'utf8');
}
if (!transcript) { console.error('!! 没拿到逐字稿，妙记链接已打印，稍后手动重试③'); process.exit(6); }

const md = `# 逐字稿（飞书妙记）\n\n> 妙记：${minuteUrl}\n> 关键词：${(art.keywords || []).join('、')}\n\n${transcript}\n\n## AI 总结\n\n${art.summary || '（无）'}\n`;
writeFileSync(join(DIR, 'transcript.飞书妙记.md'), md, 'utf8');
try { rmSync(join(DIR, 'minutes'), { recursive: true, force: true }); } catch {}
console.log('✅ transcript.飞书妙记.md 已落盘，字数', transcript.length);
console.log('MINUTE_TOKEN=' + minuteToken);
