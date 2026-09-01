/**
 * agents-to-feishu 新机部署向导（2026-09-01）
 *
 * 目标：clone → npm install → 跑本向导 → 填 key → 跑通
 *
 * 用法：
 *   node scripts/setup.mjs --check          只检查（前置+引擎），不写任何东西
 *   node scripts/setup.mjs --dry-run        全流程演练，不写文件不注册服务
 *   node scripts/setup.mjs --yes            非交互：已有的全用，缺的跳过并列清单
 *   node scripts/setup.mjs --apps a.json    批量导入飞书 app（{"claude":{"appId":"cli_..","appSecret":".."},...}）
 *   node scripts/setup.mjs --creds c.json   批量导入凭据（{"GW_API_KEY":"...","GITHUB_TOKEN":"..."}）
 *
 * 职责链：
 *   ① 前置检查（node/git/nssm/node_modules）
 *   ② 10 引擎 CLI 检测（缺的列出，不拦流程——对应 bot 可先禁用）
 *   ③ 凭据落地 ~/.dsh/.credentials.yaml（已有值不覆盖）
 *   ④ 飞书 app 填充 + config-store.json 落地（已存在则备份跳过，绝不覆盖）
 *   ⑤ gen-all-envs 渲染 config.<bot>.env
 *   ⑥ deploy-agents.ps1 注册 nssm 服务
 *   ⑦ 验证清单
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';

const repoDir = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const flagVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
const CHECK = has('--check'), DRY = has('--dry-run'), YES = has('--yes');

const userHome = flagVal('--home') || process.env.CTI_USER_HOME || os.homedir();
const credFile = path.join(userHome, '.dsh', '.credentials.yaml');
const ctiHome = process.env.CTI_HOME || path.join(userHome, '.agents-to-feishu');
const storeFile = process.env.CTI_SETUP_STORE || path.join(ctiHome, 'config-store.json');
const template = path.join(repoDir, 'scripts', 'setup', 'store-template.json');

const ENGINES = [
  { id: 'claude', cmd: 'claude', hint: 'npm i -g @anthropic-ai/claude-code' },
  { id: 'codex', cmd: 'codex', hint: 'npm i -g @openai/codex；~/.codex/config.toml 配认证' },
  { id: 'gemini', cmd: 'gemini', hint: 'npm i -g @google/gemini-cli；注意 0.57 破坏 gateway auth' },
  { id: 'hermes', cmd: 'hermes', hint: 'hermes-agent（venv）' },
  { id: 'reasonix', cmd: 'reasonix-cli', hint: 'Reasonix 安装包（AppData\\Local\\Programs\\Reasonix）' },
  { id: 'openclaw', cmd: 'openclaw', hint: 'npm i -g openclaw + gateway（127.0.0.1:18789）' },
  { id: 'opencode', cmd: 'opencode', hint: 'npm i -g opencode-ai' },
  { id: 'mimo', cmd: 'mimo', hint: 'mimo CLI' },
  { id: 'dsh', cmd: null, hint: 'deepseek-harness 仓库 + 构建（CTI_DSH_HARNESS_PATH）' },
  { id: 'openakita', cmd: 'openakita', hint: 'python venv + pip install openakita + scripts/openakita-patches/apply.py' },
];

const CRED_KEYS = [
  ['GW_API_KEY', 'LiteLLM/GW 网关 key（多数 bot 走它）', true],
  ['LITELLM_API_KEY', 'LiteLLM 中转 key（:4000 用量补拉）', false],
  ['DEEPSEEK_API_KEY', 'DeepSeek 官方 key（dsh bot）', false],
  ['GITHUB_TOKEN', 'GitHub PAT（也可放 config.env / 环境变量）', false],
  ['ANYSEARCH_API_KEY', 'anysearch 搜索 key（也可放 openakita workspace .env）', false],
  ['ARK_API_KEY', '火山方舟 key（volc-ark 套餐 bot）', false],
  ['VOLC_ACCESS_KEY_ID', '火山 TTS AK', false],
  ['VOLC_SECRET_ACCESS_KEY', '火山 TTS SK', false],
];

const ok = (m) => console.log(`  [✓] ${m}`);
const warn = (m) => console.log(`  [!] ${m}`);
const fail = (m) => console.log(`  [✗] ${m}`);

function whereCmd(name) {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? (r.stdout || '').split(/\r?\n/)[0].trim() : '';
}

// ── .credentials.yaml 极简解析（version:1 + refs: KEY: value）──
function readCreds() {
  if (!fs.existsSync(credFile)) return {};
  const refs = {}; let inRefs = false;
  for (const ln of fs.readFileSync(credFile, 'utf8').split(/\r?\n/)) {
    if (/^refs:/.test(ln)) { inRefs = true; continue; }
    if (inRefs) {
      const m = ln.match(/^ {2}([A-Z0-9_]+): ?(.*)$/);
      if (m) refs[m[1]] = m[2].trim();
      else if (ln && !/^ /) break;
    }
  }
  return refs;
}
function writeCreds(refs) {
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  const lines = ['version: 1', 'refs:'];
  for (const [k, v] of Object.entries(refs)) lines.push(`  ${k}: ${v}`);
  fs.writeFileSync(credFile, lines.join('\n') + '\n', 'utf8');
}

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }

async function main() {
  console.log(`\n=== agents-to-feishu setup ===`);
  console.log(`repo: ${repoDir}\nuserHome: ${userHome}\nCTI_HOME: ${ctiHome}\nstore: ${storeFile}\n`);
  if (CHECK) console.log('（--check 模式：只检查不写入）\n');

  // ① 前置
  console.log('── ① 前置检查 ──');
  const nodeV = process.version;
  const major = Number(nodeV.slice(1).split('.')[0]);
  major >= 20 ? ok(`node ${nodeV}`) : fail(`node ${nodeV}（需 ≥20）`);
  whereCmd('git') ? ok('git') : warn('git 未找到（clone/更新要用）');
  const nssm = whereCmd('nssm') || 'C:\\Windows\\System32\\nssm.exe';
  fs.existsSync(nssm) ? ok(`nssm: ${nssm}`) : warn('nssm 未找到——服务注册步骤会失败（https://nssm.cc）');
  fs.existsSync(path.join(repoDir, 'node_modules'))
    ? ok('node_modules 已安装')
    : warn('node_modules 缺失——先跑 npm install');
  console.log('');

  // ② 引擎检测
  console.log('── ② 引擎 CLI 检测（10 bot）──');
  const found = {};
  for (const e of ENGINES) {
    let p = e.cmd ? whereCmd(e.cmd) : '';
    if (e.id === 'dsh') {
      p = fs.existsSync('C:/D/opt/deepseek-harness/deepseek-harness')
        ? 'C:/D/opt/deepseek-harness/deepseek-harness' : '';
    }
    if (e.id === 'reasonix' && !p) {
      const cand = path.join(userHome, 'AppData', 'Local', 'Programs', 'Reasonix', 'reasonix-cli.exe');
      if (fs.existsSync(cand)) p = cand;
    }
    found[e.id] = p;
    p ? ok(`${e.id}: ${p}`) : warn(`${e.id}: 未找到 → ${e.hint}`);
  }
  console.log('');
  if (CHECK) { console.log('check 完成（未做任何修改）'); return; }

  // ③ 凭据
  console.log('── ③ 凭据（~/.dsh/.credentials.yaml，已有值不动）──');
  const creds = readCreds();
  let credsImport = {};
  if (flagVal('--creds')) credsImport = readJson(flagVal('--creds'));
  for (const [k, desc, required] of CRED_KEYS) {
    if (creds[k]) { ok(`${k} 已配置`); continue; }
    const v = credsImport[k];
    if (v) { creds[k] = v; ok(`${k} ← 导入`); continue; }
    if (YES || DRY) { (required ? warn : warn)(`${k} 缺失（${desc}）`); continue; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`  ${k}（${desc}；回车跳过）: `)).trim();
    rl.close();
    if (ans) { creds[k] = ans; ok(`${k} 已填`); }
  }
  if (!DRY && Object.keys(creds).length) {
    if (fs.existsSync(credFile)) fs.copyFileSync(credFile, credFile + '.bak-setup');
    writeCreds(creds); ok(`凭据写入 ${credFile}`);
  }
  console.log('');

  // ④ 飞书 app + store
  console.log('── ④ config-store（10 bot 飞书 app）──');
  let appsImport = {};
  if (flagVal('--apps')) appsImport = readJson(flagVal('--apps'));
  let store;
  if (fs.existsSync(storeFile)) {
    warn(`store 已存在，跳过：${storeFile}（要重建请先手工备份删除）`);
    store = readJson(storeFile);
  } else {
    store = readJson(template);
    // workdir 兜底：模板占位符 __AGENT_WORKDIR__ → <userHome>\agent-work（新建目录）。
    // 不能用仓库目录或本机硬编码路径（C:\D\opt）：CLI 在 git 仓库里跑会卡死（git 死锁事故），
    // 指向不存在的目录 spawn 直接 ENOENT。
    const agentWorkdir = flagVal('--workdir') || path.join(userHome, 'agent-work');
    if (store.defaultWorkdir === '__AGENT_WORKDIR__') store.defaultWorkdir = agentWorkdir;
    for (const a of store.agents || []) {
      if (a.workdir === '__AGENT_WORKDIR__') a.workdir = agentWorkdir;
      const imp = appsImport[a.id];
      if (imp?.appId) { a.appId = imp.appId; a.appSecret = imp.appSecret || ''; ok(`${a.id}: app ← 导入`); continue; }
      if (YES || DRY) { warn(`${a.id}: appId 空——注册后去 config-center UI 补`); continue; }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const appId = (await rl.question(`  ${a.id} appId（回车跳过）: `)).trim();
      const appSecret = appId ? (await rl.question(`  ${a.id} appSecret: `)).trim() : '';
      rl.close();
      a.appId = appId; a.appSecret = appSecret;
      appId ? ok(`${a.id}: 已填`) : warn(`${a.id}: 跳过`);
    }
    if (DRY) {
      ok(`(dry-run) bot 工作目录将设为 ${agentWorkdir}`);
    } else {
      fs.mkdirSync(agentWorkdir, { recursive: true });
      ok(`bot 工作目录 ${agentWorkdir}（已创建，CLI/引擎都在这里干活）`);
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
      ok(`store 写入 ${storeFile}`);
    }
  }
  console.log('');

  // ⑤ 渲染 env
  console.log('── ⑤ 渲染 config.<bot>.env ──');
  const tsxCli = path.join(repoDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const gen = path.join(repoDir, 'scripts', 'gen-all-envs.mjs');
  if (DRY) {
    console.log(`  （dry-run）将执行: node ${tsxCli} ${gen}  （env CTI_USER_HOME=${userHome}）`);
  } else {
    const r = spawnSync(process.execPath, [tsxCli, gen], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, CTI_USER_HOME: userHome, CTI_HOME: ctiHome },
    });
    (r.stdout || '').trim().split('\n').slice(0, 14).forEach((l) => console.log('  ' + l));
    if (r.status !== 0) fail(`gen-all-envs 退出码 ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  }
  console.log('');

  // ⑥ nssm 注册
  console.log('── ⑥ nssm 服务注册 ──');
  const deploy = path.join(repoDir, 'scripts', 'deploy-agents.ps1');
  const psArgs = ['-NoProfile', '-File', deploy, '-RepoDir', repoDir, '-UserHome', userHome, '-IncludeConfigCenter'];
  if (DRY) psArgs.push('-DryRun');
  const r2 = spawnSync('powershell.exe', psArgs, { encoding: 'utf8', timeout: 300000 });
  (r2.stdout || '').trim().split('\n').slice(0, 26).forEach((l) => console.log('  ' + l));
  if (r2.status !== 0) fail(`deploy-agents.ps1 退出码 ${r2.status}: ${(r2.stderr || '').slice(0, 300)}`);
  console.log('');

  // ⑦ 验证清单
  console.log('── ⑦ 验证（部署完成后逐条跑）──');
  console.log(`  1. 配置中心: curl http://127.0.0.1:13600/health（没起就 nssm start config-center）`);
  console.log(`  2. 每个服务: nssm status <bot>；日志 logs/<bot>-out.log / <bot>-err.log`);
  console.log(`  3. 飞书私信: node scripts/feishu-verify.mjs <bot> "gh api user --jq .login"`);
  console.log(`  4. 引擎补漏: 缺的引擎按上面 hint 安装后 nssm restart <bot>`);
  console.log(`  5. openakita 记得跑: python scripts/openakita-patches/apply.py --env <workspace>/.env`);
  console.log('');
  console.log('完成。卡住就看 logs/<bot>-err.log 和 scripts/openakita-patches/README.md。');
}

main().catch((e) => { console.error(e); process.exit(1); });
