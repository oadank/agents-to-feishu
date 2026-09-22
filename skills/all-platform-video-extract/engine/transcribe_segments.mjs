// 分段转写：SenseVoice 单次吃不下几分钟音频（整条 292 秒实测 HTTP 500），
// 故按 45 秒切片逐段识别，再带时间戳拼成 Markdown。
// 用法：node transcribe_segments.mjs <切片目录> <输出md> <标题> [每段秒数]
import { readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
const OUT = process.argv[3];
const TITLE = process.argv[4] || '视频转写';
const SEG = Number(process.argv[5] || 45);
const API = 'http://127.0.0.1:18790/transcribe';

const files = readdirSync(DIR).filter((f) => f.endsWith('.wav')).sort();
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const parts = [];
let t0 = 0;
for (const f of files) {
  const path = join(DIR, f);
  const dur = Math.round(statSync(path).size / 32000);
  process.stdout.write(`  ${f} [${mmss(t0)}-${mmss(t0 + dur)}] `);
  let text = '';
  for (let try1 = 0; try1 < 3 && !text; try1++) {
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audioPath: path }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      text = String(j.text || '').trim();
    } catch (e) {
      process.stdout.write(`(重试 ${try1 + 1}: ${String(e.message).slice(0, 60)}) `);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log(`${text.length} 字`);
  if (text) parts.push({ from: t0, to: t0 + dur, text });
  t0 += dur;
  writeFileSync(OUT, render(parts), 'utf8');
}
function render(ps) {
  const body = ps.map((p) => `**[${mmss(p.from)} - ${mmss(p.to)}]**\n\n${p.text}\n`).join('\n---\n\n');
  return `# ${TITLE}\n\n> 本机离线转写（SenseVoice int8，127.0.0.1:18790）· 生成于 ${new Date().toLocaleString('zh-CN')} · 音频总时长约 ${mmss(t0)}\n\n${body || '_（暂无内容）_'}\n`;
}
writeFileSync(OUT, render(parts), 'utf8');
const total = parts.reduce((n, p) => n + p.text.length, 0);
console.log(`完成：${parts.length}/${files.length} 段成功，共 ${total} 字 -> ${OUT}`);
if (!parts.length) process.exit(4);
