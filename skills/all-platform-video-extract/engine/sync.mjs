// 本机引擎资产 → 技能包 engine/ 单向同步（2026-09-21）
//
// 为什么需要它：脚本的真源在本机 `C:\D\opt\tools\yt-dlp`（插件里路径是硬编码的运行位置），
// 仓库里这份是**快照**。两边必然分叉（SKILL.md 已经踩过一次坑），所以用「带排除清单 + sha 对比」
// 的同步代替手抄：改完本机脚本跑一次，谁跟谁不一样一目了然。
//
// 用法：
//   node sync.mjs --dry-run     只报告差异，不动文件
//   node sync.mjs               把有差异的文件复制进 engine/
//
// 环境变量：ENGINE_SRC 覆盖源目录（默认 C:\D\opt\tools\yt-dlp）
import { readdirSync, statSync, copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));           // …\skills\all-platform-video-extract\engine
const SRC = process.env.ENGINE_SRC || 'C:\\D\\opt\\tools\\yt-dlp';
const DRY = process.argv.includes('--dry-run');

// ── 排除清单：凭证 / 第三方大件 / 产物 / 含设备标识的文件
const EXCLUDE_FILES = [
  /^cookies\.txt$/,          // 真登录凭证
  /^cdp\.port$/,             // 本机端口状态
  /^yt-dlp\.exe$/,           // 17MB 第三方二进制
  /^recon_full_url\.txt$/,   // 真实带签名 URL，含设备级 uifid —— 属凭证性质
  /^login_qr\.png$/, /^qr_.*\.png$/, /^sms_.*\.png$/, /^verify_state\.png$/,
];
const EXCLUDE_DIRS = [/^edge-video-profile$/, /^__pycache__$/, /^node_modules$/, /^logs?$/];
const EXCLUDE_EXT = [/\.(png|jpe?g|gif|pyc|log|bak|tmp)$/i];
// ── 只同步这些（白名单，比黑名单安全）
const ROOT_EXT = /\.(mjs|js|conf)$/i;
const SUBDIRS = ['test', 'plugins', 'recon'];

const bad = (name, dirs) => EXCLUDE_FILES.some((r) => r.test(name))
  || EXCLUDE_EXT.some((r) => r.test(name))
  || dirs.some((d) => EXCLUDE_DIRS.some((r) => r.test(d)));

function walk(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (bad(e.name, [e.name])) continue;
      out.push(...walk(join(dir, e.name), relPath));
    } else if (e.isFile()) {
      if (bad(e.name, relPath.split('/'))) continue;
      out.push(relPath);
    }
  }
  return out;
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);

// 收集源文件：根目录源码 + 指定子目录
let files = readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isFile() && ROOT_EXT.test(e.name) && !bad(e.name, []))
  .map((e) => e.name);
for (const sub of SUBDIRS) {
  const p = join(SRC, sub);
  if (existsSync(p) && statSync(p).isDirectory()) files.push(...walk(p, sub).filter((f) => ROOT_EXT.test(f) || /\.py$/i.test(f)));
}
files.sort();

if (!files.length) { console.error('源目录没找到可同步的源码：' + SRC); process.exit(1); }

const same = [], added = [], updated = [], skipped = [];
for (const rel of files) {
  const s = join(SRC, rel.replace(/\//g, '\\'));
  const d = join(HERE, rel.replace(/\//g, '\\'));
  if (!existsSync(d)) { added.push(rel); if (!DRY) { mkdirSync(dirname(d), { recursive: true }); copyFileSync(s, d); } continue; }
  const hs = sha(s), hd = sha(d);
  if (hs === hd) { same.push(rel); continue; }
  updated.push(`${rel}  (快照 ${hd} → 本机 ${hs})`);
  if (!DRY) copyFileSync(s, d);
}

// 反向检查：engine/ 里有、源里没有的（可能是删掉的本机文件，也可能是手工放的）
const all = walk(HERE).filter((f) => ROOT_EXT.test(f) || /\.py$/i.test(f));
for (const rel of all) if (!files.includes(rel)) skipped.push(rel);

const show = (t, arr) => { if (arr.length) { console.log(`\n${t}（${arr.length}）`); arr.forEach((x) => console.log('  ' + x)); } };
console.log(`源: ${SRC}`);
console.log(`目标: ${HERE}${DRY ? '   [DRY-RUN 未改文件]' : ''}`);
console.log(`共 ${files.length} 个待同步文件`);
show('一致', same);
show('新增', added);
show('更新', updated);
show('仅存在于 engine/（源里没有，注意是否该删）', skipped);
console.log(`\n结果：一致 ${same.length} / 新增 ${added.length} / 更新 ${updated.length} / 引擎侧多余 ${skipped.length}`);
