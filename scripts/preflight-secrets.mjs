// 提交前防呆：挡住登录凭证 / 浏览器登录态 / 大件二进制（2026-09-21 加）
//
// 触发方式：`.githooks/pre-commit`（已用 `git config core.hooksPath .githooks` 启用）
// 手动跑：node scripts/preflight-secrets.mjs [--all]
//   --all = 检查**全部已跟踪文件**（体检现有仓库，而不是只看暂存区）
//
// 🔴 为什么需要它：`oadank/agents-to-feishu` 是**公开仓库**。
//   技术手法被人学走无所谓（那些本来网上就有），但**一次 `git add -A` 手滑把
//   cookies.txt / 浏览器登录态推上去 = 账号直接送人**，这是真事故。
//   老大 2026-09-21 拍板加这层防护。
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';

const ALL = process.argv.includes('--all');
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const files = (ALL
  ? git(['ls-files']).split('\n')
  : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n')
).map((s) => s.trim()).filter(Boolean);

// 文件名特征 —— 命中即拦
const BLOCK_NAME = [
  [/^cookies?\.txt$/i, '登录凭证文件'],
  [/cookies?[-_.][^/]*\.(txt|json|jsonl|csv|dat|log)$/i, '疑似凭证数据文件'],
  [/(^|\/)edge-video-profile(\/|$)/i, '浏览器登录态目录'],
  [/(^|\/)[^/]*-profile(\/|$)/i, '疑似浏览器登录态目录'],
  [/(^|\/)node_modules(\/|$)/i, '依赖目录'],
  [/\.(exe|dll|so|dylib)$/i, '二进制程序'],
  [/(^|\/)login[_-]?.*\.(png|jpe?g)$/i, '登录过程截图'],
  [/(^|\/)(qr|sms|verify|code)[_-]?.*\.(png|jpe?g)$/i, '验证码/登录截图'],
];
// 内容特征 —— 命中即拦（只扫文本类文件）
const BLOCK_CONTENT = [
  [/sessionid=[A-Za-z0-9%_\-]{8,}/, '浏览器 sessionid'],
  [/\bttwid=[A-Za-z0-9%_\-]{10,}/, '抖音 ttwid cookie'],
  [/\bodin_tt=/i, '抖音登录态 cookie'],
  [/passport_csrf_token/i, '登录 csrf token'],
  [/\b(_secure_session_id|sid_tt|sid_guard)=/i, '抖音会话 cookie'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{24,}/, 'API key'],
];
const TEXT_EXT = /\.(txt|json|jsonl|md|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|yml|yaml|env|conf|ini|log|html|css|csv|xml|toml)$/i;
const MAX_MB = 5;

const problems = [];
// 扫描器不扫自己：本文件源码里必然写着下面这些特征字面量（那是规则，不是凭证），
// 否则每次提交防护脚本自己都会被自己拦下（2026-09-21 实测踩到）。
const SELF = 'scripts/preflight-secrets.mjs';
for (const f of files) {
  if (f === SELF) continue;
  for (const [re, why] of BLOCK_NAME) if (re.test(f)) problems.push(`${f}  ← ${why}（文件名命中）`);
  if (!existsSync(f)) continue;
  let st;
  try { st = statSync(f); } catch { continue; }
  if (st.isDirectory()) continue;
  if (st.size > MAX_MB * 1024 * 1024) { problems.push(`${f}  ← ${(st.size / 1024 / 1024).toFixed(1)}MB 大文件`); continue; }
  if (!TEXT_EXT.test(f)) continue;
  let text = '';
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  if (text.length > 4_000_000) continue;
  for (const [re, why] of BLOCK_CONTENT) {
    const m = re.exec(text);
    if (m) problems.push(`${f}  ← ${why}（内容命中：${String(m[0]).slice(0, 40)}…）`);
  }
}

if (problems.length) {
  console.error(`\n🔴 拦下：${ALL ? '仓库里' : '暂存区里'}有不该进公开仓库的东西\n`);
  problems.forEach((p) => console.error('   ' + p));
  console.error('\n这些属于登录凭证 / 浏览器登录态 / 大件二进制 —— 推到公开仓库就是真事故。');
  console.error('确认无误要强行提交：git commit --no-verify');
  console.error('若是 .gitignore 漏了规则，请补上：.gitignore\n');
  process.exit(1);
}
console.log(`✓ 防呆检查通过（${ALL ? '全仓库体检' : '暂存区'} ${files.length} 个文件，无凭证/大件）`);
