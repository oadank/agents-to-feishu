// 一条命令出「高质量三件套」：最高画质视频 + 单独音频 + 逐字稿。
//   node video_kb.mjs "<视频页URL>" [子目录名]
// 步骤：① sniff_download.mjs 抓最高清晰度（时长锚点防下错片）
//      ② 转写：**默认本地 ASR**（SenseVoice :18790，零飞书额度）
//      ③ 合成 transcript.<引擎>.md 落在同一个视频目录，回填 info.json
// 【口径变更 2026-09-21 老大手令】原默认走飞书妙记，但妙记转写烧老大账号额度
//   （免费 300 分钟/月，红线见 openmem d626c302），改为**默认本地**。
//   妙记只当老大点名才走：MINUTE=1 强制上传；MINUTE_TOKEN=xxx 复用已有妙记。
//   质量权衡老大知情选择：本地无标点/无说话人分离、技术词偶错听（当年弃本地用
//   妙记的原因），后继者**别自作主张改回妙记默认**。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.argv[2];
const NAME = process.argv[3];
if (!URL_) { console.error('用法: node video_kb.mjs "<视频URL>" [子目录名]'); process.exit(2); }
const ENV = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: true, env: ENV, maxBuffer: 64e6, ...opts });
  if (r.error) throw new Error(r.error.message);
  return String(r.stdout || '') + String(r.stderr || '');
}
function jsonOf(out) {
  // lark-cli 会把 [xxx +detail] 这类进度行混在 JSON 前后，必须按「行首 { 到行首 }」抠出完整 JSON 块，
  // 不能从第一个 { 一路取到结尾（那会把尾随日志也吞进来，报 Unexpected non-whitespace after JSON）
  const m = String(out).match(/^\{[\s\S]*?^\}/m);
  if (!m) throw new Error('没有 JSON：' + String(out).slice(0, 200));
  return JSON.parse(m[0]);
}

const OUT_ROOT = 'C:\\Users\\oadan\\Videos\\VideoExtract';
// 复用优先：同一条源链接已有 video.mp4 + audio.m4a 就别再下一遍（省流量也避免重复件）
function isReady(d) {
  if (!existsSync(join(d, 'audio.m4a')) || !existsSync(join(d, 'video.mp4'))) return false;
  try { return JSON.parse(readFileSync(join(d, 'info.json'), 'utf8')).source_url === URL_; } catch { return false; }
}
let DIR = '';
if (NAME && isReady(join(OUT_ROOT, NAME))) {
  DIR = join(OUT_ROOT, NAME);
  console.log('① 目录里已有同一来源的视频+音频，**跳过下载**，直接进妙记环节');
} else {
  console.log('① 抓最高清晰度…');
  const sn = run(process.execPath, [join(HERE, 'sniff_download.mjs'), URL_, ...(NAME ? [NAME] : [])]);
  process.stdout.write(sn);
  const dirLine = sn.split('\n').reverse().find((l) => l.startsWith('目录:'));
  if (!dirLine) { console.error('!! 抓流失败，看上面输出'); process.exit(4); }
  DIR = dirLine.replace('目录:', '').trim().replace(/\//g, '\\');
}
const audio = join(DIR, 'audio.m4a');
if (!existsSync(audio)) { console.error('!! 没有 audio.m4a，无法走妙记'); process.exit(5); }

let minuteToken = process.env.MINUTE_TOKEN || '';
const USE_MINUTE = process.env.MINUTE === '1' || !!minuteToken; // 老大点名才走妙记
let fileToken = '', minuteUrl = '', art = { keywords: [], summary: '' }, tc = '';

if (USE_MINUTE) {
  if (minuteToken) {
    minuteUrl = 'https://ci8kmed4rie.feishu.cn/minutes/' + minuteToken;
    console.log('②③ 复用已存在的妙记 ' + minuteToken + '（不重复上传音频、不建第二条妙记）');
  } else {
    console.log('② 上传音频到飞书云空间…');
    // lark-cli 只收 cwd 下的相对路径，绝对路径会被判 unsafe file path
    const up = jsonOf(run('lark-cli', ['drive', '+upload', '--file', 'audio.m4a', '--name', `kb-${basenameOf(DIR)}.m4a`, '--as', 'user', '--format', 'json'], { cwd: DIR }));
    if (!up.ok) throw new Error('上传失败: ' + JSON.stringify(up.error || up).slice(0, 300));
    fileToken = up.data.file_token;
    console.log('   file_token = ' + fileToken);
    console.log('③ 生成妙记（云端转写，消耗老大妙记额度）…');
    const mi = jsonOf(run('lark-cli', ['minutes', '+upload', '--file-token', fileToken, '--as', 'user', '--format', 'json']));
    if (!mi.ok) throw new Error('建妙记失败: ' + JSON.stringify(mi.error || mi).slice(0, 300));
    minuteToken = mi.data.minute_token;
    minuteUrl = mi.data.minute_url;
    console.log('   妙记 = ' + minuteUrl);
  }
  console.log('④ 等转写完成并拉产物…');
  const dt = jsonOf(run('lark-cli', ['minutes', '+detail', '--minute-tokens', minuteToken, '--wait-ready', '--transcript', '--keyword', '--summary', '--as', 'user', '--format', 'json'], { cwd: DIR }));
  if (!dt.ok) throw new Error('取产物失败: ' + JSON.stringify(dt.error || dt).slice(0, 300));
  art = dt.data.minutes[0].artifacts || {};
  const trRel = art.transcript_file || '';
  const trPath = trRel ? join(DIR, trRel.replace(/\//g, '\\')) : '';
  tc = trPath && existsSync(trPath) ? readFileSync(trPath, 'utf8') : '';
  if (!tc) throw new Error('逐字稿没落地，检查 ' + trRel);
} else {
  console.log('② 本地 ASR 转写（SenseVoice :18790，零飞书额度）…');
  // wav 必须落英文路径：视频目录常带中文标题，sherpa-onnx 吃中文路径直接退出码 -1
  const wav = join(process.env.TEMP || 'C:\\Windows\\TEMP', `vkasr-${process.pid}.wav`);
  run('ffmpeg', ['-y', '-v', 'error', '-i', 'audio.m4a', '-ar', '16000', '-ac', '1', '-vn', wav], { cwd: DIR });
  if (!existsSync(wav)) throw new Error('m4a→wav 转码失败');
  let payload;
  try {
    const resp = await fetch('http://127.0.0.1:18790/transcribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioPath: wav }), signal: AbortSignal.timeout(600_000),
    });
    if (!resp.ok) throw new Error(`本地 ASR 服务返回 ${resp.status}`);
    payload = await resp.json().catch(() => ({}));
  } catch (e) {
    rmSync(wav, { force: true });
    throw new Error(`本地 ASR 失败：${e.message}（宁停不偷传妙记——要用妙记让老大点名 MINUTE=1）`);
  }
  rmSync(wav, { force: true });
  tc = String(payload.text ?? '').trim();
  if (!tc) throw new Error('本地 ASR 没吐出文本');
  console.log(`   本地转写完成，${tc.length} 字`);
}

// 引流/卖课话术剔除（老大 2026-09-19 定为常驻要求）。卖课号常在一句干货后面接一句"留666打包带走"，
// 所以按「句」切、只丢命中模式的句子，不整段删 —— 整段删会把同段的干货一起扔掉。
const AD = /(留下?\s*\d|留个\s*\d|扣\s*\d|刷\s*\d+|打包带走|必考题库|题库|课程表|安装包|完整课表|关注我|关注一下|点个赞|点赞|评论区|私信我|私我|我粉丝|免费领取|资料已整理|白嫖)/;
function stripAds(text) {
  const lines = String(text).split('\n');
  const out = [];
  let dropped = 0, blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim();
    if (!/^Speaker[\s\d]/i.test(head) && !/^说话人/.test(head)) continue;
    let body = '';
    while (i + 1 < lines.length && !/^(Speaker[\s\d]|说话人)/i.test(lines[i + 1].trim()) && lines[i + 1].trim() !== '') {
      i++; body += (body ? ' ' : '') + lines[i].trim();
    }
    const parts = body.split(/(?<=[。！？!?])/).filter((s) => {
      const t = s.trim();
      if (!t) return false;
      if (AD.test(t)) { dropped++; console.log('   剔除引流句：' + t.slice(0, 46)); return false; }
      return true;
    });
    const kept = parts.join('').trim();
    if (kept) { blocks++; out.push(head + ' \n' + kept + '\n'); }
  }
  if (!out.length) {
    // 本地 ASR 无说话人分段 → 按句切剔广告（老大常驻要求，不因引擎降级而失效）。
    // 🔴 但 SenseVoice 原文常整篇无标点，split 出来就是一整块巨句（2026-09-21 实测：
    // 全文里一个"评论区"命中 AD，整篇 1992 字被当一句广告删光，逐字稿变白纸）。
    // 规矩：>120 字的"句"必是没标点的巨块，不可整块删——只记警告保留原文；
    // 短句照常过滤。真正想剔引流句，走精修（asr-polish 出标点）之后再说。
    let giant = 0;
    const kept = String(tc).split(/(?<=[。！？!?])/).filter((s) => {
      const t = s.trim();
      if (!t) return false;
      if (t.length > 120) { if (AD.test(t)) giant++; return true; }
      if (AD.test(t)) { dropped++; console.log('   剔除引流句：' + t.slice(0, 46)); return false; }
      return true;
    });
    if (giant) console.log('   ⚠ 无标点长块命中引流词，不敢整删（防误杀），保留原文');
    return { text: kept.map((s) => s.trim()).join(''), dropped, blocks: 1 };
  }
  return { text: out.join('\n'), dropped, blocks };
}
const cut = stripAds(tc);
console.log(`   逐字稿：保留 ${cut.blocks} 段发言，剔除 ${cut.dropped} 句引流话术`);

const infoRaw = JSON.parse(readFileSync(join(DIR, 'info.json'), 'utf8'));
const nz = (x) => String(x ?? '').replace(/\r/g, '');
const durSec = Math.round(Number(nz(infoRaw.video?.duration_sec)) || 0);
// 分辨率/编码器一律从 info.json 实测值来，别写死（写死过一回，720p 的件标成 1080p）
const resTxt = nz(infoRaw.video?.width) && nz(infoRaw.video?.height)
  ? nz(infoRaw.video.width) + '×' + nz(infoRaw.video.height) + ' ' + nz(infoRaw.video?.codec).toUpperCase()
  : '?';
const engine = USE_MINUTE ? '飞书妙记（云端，带标点+说话人+时间戳）' : '本地 ASR（SenseVoice，零飞书额度；无标点/无说话人分离，技术词偶错听）';
const tFile = 'transcript.' + (USE_MINUTE ? '飞书妙记' : '本地ASR') + '.md';
const md = `# ${basenameOf(DIR)}

> 高质量三件套 · 视频 ${resTxt} / 音频 audio.m4a / 逐字稿来自**${engine}**
> 源链接：${URL_}
${minuteUrl ? '> 妙记：' + minuteUrl + '\n' : ''}> 时长约 ${Math.floor(durSec / 60)} 分 ${durSec % 60} 秒 · 取回于 ${new Date().toLocaleString('zh-CN')}

## 关键词

${(art.keywords || []).join('、') || '_（无）_'}

## 逐字稿（已自动剔除 ${cut.dropped} 句引流/卖课话术）

${cut.text.trim()}

## AI 总结

${art.summary || '_（无）_'}
`;
writeFileSync(join(DIR, tFile), md, 'utf8');
try { rmSync(join(DIR, 'minutes'), { recursive: true, force: true }); } catch { /* 清不掉就算了，不拦主流程 */ }
const info = JSON.parse(readFileSync(join(DIR, 'info.json'), 'utf8'));
info.transcript = { engine: USE_MINUTE ? 'feishu-minutes' : 'local-asr', url: minuteUrl || null, token: minuteToken || null, file: tFile, keywords: (art.keywords || []).length };
delete info.minutes;
writeFileSync(join(DIR, 'info.json'), JSON.stringify(info, null, 2), 'utf8');

console.log('⑤ 完成，目录内容：');
for (const f of readdirSync(DIR)) if (!statSync(join(DIR, f)).isDirectory()) console.log(`   ${(statSync(join(DIR, f)).size / 1024).toFixed(0).padStart(7)} KB  ${f}`);
console.log('📁 ' + DIR);

function basenameOf(p) { return p.replace(/[\\/]$/, '').split(/[\\/]/).pop(); }
