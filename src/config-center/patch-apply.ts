/**
 * 精准配置穿透（2026-08-29 老大拍板：改配置可以穿透到 agent，但绝不能破坏别的参数）
 *
 * 背景（灾难现场）：配置中心 apply 原为"整篇重渲染覆盖"——改一个模型，顺手把模板不认识
 * 的键全部抹掉（CTI_CLAUDE_CLI_PATH 被清 ⇒ claude 回落 .bat ⇒ spawn EINVAL）。
 *
 * 五原则：
 *  1. 键级合并：只写本次真正变更的键，其余原样保留；模板不认识的键（手工加的）一律 carry over
 *  2. 权属以「本次渲染结果」为准：rendered 里有的键 = 配置中心拥有（可覆盖），没有的 = 人工拥有（永不碰）
 *  3. cordis.yml 托管区：只替换 BEGIN/END managed 区内，区外（插件/人工条目）永不碰
 *  4. 变更审计 + 自动备份：apply 前备份带时间戳，diff 落 logs/config-apply-<日期>.log
 *  5. 渲染与写入分离：render* 只产出目标内容，本模块负责合并落盘
 *
 * ── 2026-09-11 根治（老大授权："要修"）──
 * 旧第 2 条是「受保护键清单：只补全、不覆盖、不删除（显式传入才覆盖）」，实测有两个致命副作用：
 *   a) 名单把配置中心**自己拥有的键**也保护了（`/^ANTHROPIC_/`、`(_KEY|_TOKEN|_SECRET)$`、`OPENAI_API_KEY`）
 *      ⇒ 配置中心改成 gw，文件里旧的 ark 值纹丝不动、只在末尾再追加一行新值 ⇒ 「改了不生效」
 *      （claude 卡「正在处理…」的根因之一）；加上 nssm 注册表/HKCU 的僵尸键，问题被掩盖得更深。
 *   b) mergeEnvText 按行遍历、**不折叠同名键** ⇒ 每次 apply 只要值变过就多留一行，config.<bot>.env
 *      长成整块重复（实测 config.gemini.env：2-43 行旧块 + 44-70 行新块，几乎所有键重复一遍），
 *      越 apply 越脏；靠 parseEnvFile 的「末值胜」勉强跑对，但谁也说不清哪一行是真源。
 *
 * 新语义（三步，删繁就简）：
 *  1. rendered 里出现的键 = 配置中心拥有 → 用渲染值覆盖（凭证键一视同仁，值本来就来自凭证库）
 *  2. rendered 里没有的键 = 人工/其他工具拥有 → 原样保留（人工配置永不丢，旧第 1 条原则不变）
 *  3. 同名重复键折叠为一行（保留首次出现的位置，值取渲染值）；渲染值为空串时不抹掉文件里已有的非空值
 * 原 PROTECTED_PATTERNS 降级为 SENSITIVE_PATTERNS：只用于「日志脱敏」，不再拦截覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '..', '..', 'logs');

/** 敏感键模式：只决定「日志里打不打值」，不再决定「能不能覆盖」（覆盖权属见文件头新语义） */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^CTI_[A-Z0-9_]*_CLI_PATH$/, // 各 runtime 的 CLI 可执行路径（claude.exe / dsh harness 等）
  /^CTI_[A-Z0-9_]*_EXEC$/,
  /^CTI_DSH_HARNESS_PATH$/,
  /^CTI_DSH_ACP_(CONFIG|CWD)$/,
  /^CTI_USER_HOME$/,
  /^CTI_RT_LOG$/,
  /(_KEY|_TOKEN|_SECRET)$/i, // 凭证类
  /^ANTHROPIC_/,
  /^DEEPSEEK_/,
  /^OPENAI_API_KEY$/,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(key));
}

/** 旧名兼容（语义已改为「敏感键」，仅供日志脱敏判定） */
export const isProtectedKey = isSensitiveKey;

export interface EnvChange {
  key: string;
  oldValue: string;
  newValue: string;
  /** keep-empty = 渲染值为空，保留文件里已有的非空值（空值保护） */
  kind: 'add' | 'update' | 'keep-empty';
}

interface ParsedLine { line: string; key?: string; value?: string }

/**
 * 按行解析 KEY=VALUE。
 *
 * 2026-09-11 修复（整块重复的真凶）：原实现直接对 split('\n') 的每行套 `/^KEY=(.*)$/`，
 * 但 config.<bot>.env 是 **CRLF** 文件 ⇒ 行尾残留 `\r`，而 JS 正则里 `.` 不匹配 `\r`、
 * 非 multiline 的 `$` 也不在 `\r` 前匹配 ⇒ **整行匹配失败**，所有真实配置行都被判成
 * 「非 KEY=VALUE 行」原样保留，随后新渲染的整套键再追加一遍 ⇒ 每次 apply 文件多出一整块
 * （实测 gemini/claude/mimo/reasonix：几乎所有键重复一遍，行数只增不减）。
 * 修法：解析前剥掉行尾 `\r`（返回的 line 也统一为无 `\r`，落盘行尾归一到 LF）。
 * 注意：bot 运行时读配置的 config.ts `parseEnvFile` 用的是 `split(/\r?\n/)` + trim，不受此坑影响。
 */
function parseEnvLines(text: string): ParsedLine[] {
  return text.split('\n').map((raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return m ? { line, key: m[1], value: m[2] } : { line };
  });
}

/**
 * 合并 env：以现有文件为底做「归一化重写」——权属按本次渲染结果判定。
 *
 * 规则：
 *  - rendered 里的键 = 配置中心拥有 ⇒ 写渲染值（覆盖同名旧行的值）
 *  - rendered 里没有的键 = 人工/其他工具拥有 ⇒ 原样保留
 *  - 同名重复键折叠成一行（保留首次出现位置）；渲染值为空串时保留文件里已有的非空值
 *
 * @param existingText 现有文件内容（空串 = 首次生成）
 * @param renderedText 渲染器产出的目标内容
 * @param explicitKeys 需要「连空值也照写」的键（默认空；否则渲染值为空 → 保留旧值）
 */
export function mergeEnvText(
  existingText: string,
  renderedText: string,
  explicitKeys: Set<string> = new Set(),
): { text: string; changes: EnvChange[] } {
  // 本次渲染的目标值（同键后者胜，与 config.ts parseEnvFile 的「末值胜」一致）
  const rendered = new Map<string, string>();
  for (const p of parseEnvLines(renderedText)) {
    if (p.key !== undefined) rendered.set(p.key, p.value ?? '');
  }

  const changes: EnvChange[] = [];
  const written = new Set<string>(); // 已落盘的键（用于折叠重复行）
  const out: string[] = [];
  const parsed = parseEnvLines(existingText);

  // 人工键（渲染结果里没有的键）的「末值」：与 config.ts parseEnvFile 的末值胜保持一致，
  // 折叠重复行时用末值，保证运行时读到的值不变。
  const manualLast = new Map<string, string>();
  for (const p of parsed) {
    if (p.key !== undefined && !rendered.has(p.key)) manualLast.set(p.key, p.value ?? '');
  }

  for (const p of parsed) {
    if (p.key === undefined) { out.push(p.line); continue; } // 注释/空行原样
    const target = rendered.get(p.key);
    if (target === undefined) {
      // 模板不认识的键 → 保留（人工配置不丢）；同名重复行同样折叠为一行
      if (written.has(p.key)) continue;
      written.add(p.key);
      const last = manualLast.get(p.key) ?? '';
      const cur = p.value ?? '';
      if (cur === last) { out.push(p.line); continue; }
      changes.push({ key: p.key, oldValue: cur, newValue: last, kind: 'update' });
      out.push(`${p.key}=${last}`);
      continue;
    }
    if (written.has(p.key)) continue; // 同名重复行 → 丢弃（值由首次出现处统一给）
    written.add(p.key);
    const current = p.value ?? '';
    if (current === target) { out.push(p.line); continue; }
    if (!target.trim() && !explicitKeys.has(p.key)) {
      // 空值保护：渲染值为空时不抹掉文件里已有的非空值
      // （如 CTI_BOT_<id>_BASE_URL 在无上游时渲染为空串）
      changes.push({ key: p.key, oldValue: current, newValue: current, kind: 'keep-empty' });
      out.push(p.line);
      continue;
    }
    changes.push({ key: p.key, oldValue: current, newValue: target, kind: 'update' });
    out.push(`${p.key}=${target}`);
  }

  // 渲染器新增的键
  for (const [k, v] of rendered) {
    if (written.has(k)) continue;
    changes.push({ key: k, oldValue: '', newValue: v, kind: 'add' });
    out.push(`${k}=${v}`);
  }

  return { text: out.join('\n'), changes };
}

const BEGIN = '# BEGIN agents-to-feishu managed';
const END = '# END agents-to-feishu managed';

function topLevelIds(text: string): string[] {
  return text.split('\n')
    .filter((l) => /^- id:/.test(l))
    .map((l) => l.replace(/^- id:\s*/, '').trim());
}

/**
 * 合并 cordis.yml：只替换托管区；无托管区时（历史文件）保留其中"非生成"的条目后迁移。
 */
export function mergeCordisText(existingText: string, generatedText: string): string {
  const generatedIds = new Set(topLevelIds(generatedText));
  const region = `${BEGIN}\n${generatedText.replace(/\s+$/, '')}\n${END}\n`;

  const b = existingText.indexOf(BEGIN);
  const e = existingText.indexOf(END);
  if (b >= 0 && e > b) {
    // 有托管区：只替换区内，区外原样
    return existingText.slice(0, b) + region + existingText.slice(e + END.length + 1);
  }
  // 历史文件：提取非生成条目（人工/插件追加），迁移后原样保留在托管区之后
  const foreign: string[] = [];
  const lines = existingText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^- id:/.test(lines[i])) continue;
    const id = lines[i].replace(/^- id:\s*/, '').trim();
    if (generatedIds.has(id)) continue;
    const block: string[] = [];
    for (; i < lines.length; i++) {
      if (i > 0 && /^- id:/.test(lines[i]) && block.length) { i--; break; }
      block.push(lines[i]);
    }
    foreign.push(block.join('\n'));
  }
  return region + (foreign.length ? `\n# 以下为人工/插件追加条目（配置中心不拥有，apply 保留）\n${foreign.join('\n')}\n` : '');
}

/** apply 前备份（同目录带时间戳），失败不阻断 */
export function backupFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dest = `${file}.bak-${ts}`;
    fs.copyFileSync(file, dest);
    return dest;
  } catch { return null; }
}

/** 变更审计：落 logs/config-apply-<日期>.log */
export function logApply(agentId: string, file: string, changes: EnvChange[], backup: string | null): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    // 本地日期（老大在本机看日志；UTC 会把 08:00 前的记录算到前一天）
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const logFile = path.join(LOGS_DIR, `config-apply-${day}.log`);
    const ts = new Date().toISOString();
    const lines = [`[${ts}] agent=${agentId} file=${file} backup=${backup ?? '-'} changes=${changes.length}`];
    for (const c of changes) {
      const shown = isSensitiveKey(c.key) ? '(敏感/凭证，值不打日志)' : `${c.oldValue} -> ${c.newValue}`;
      lines.push(`  - ${c.kind} ${c.key}: ${shown}`);
    }
    fs.appendFileSync(logFile, lines.join('\n') + '\n', 'utf-8');
  } catch { /* 审计失败不影响主流程 */ }
}

/** 合并落盘（env）：备份 → 合并 → 审计 → 写入 */
export function writeEnvMerged(
  file: string,
  renderedText: string,
  agentId: string,
  explicitKeys: Set<string> = new Set(),
): EnvChange[] {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const { text, changes } = mergeEnvText(existing, renderedText, explicitKeys);
  const backup = backupFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
  logApply(agentId, file, changes, backup);
  return changes;
}

/** 合并落盘（cordis.yml）：备份 → 托管区替换 → 写入 */
export function writeCordisMerged(file: string, generatedText: string, agentId: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const text = mergeCordisText(existing, generatedText);
  const backup = backupFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
  logApply(agentId, file, [{ key: '(cordis managed region)', oldValue: '', newValue: 'updated', kind: 'update' }], backup);
}
