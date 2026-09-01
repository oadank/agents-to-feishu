/**
 * 精准配置穿透（2026-08-29 老大拍板：改配置可以穿透到 agent，但绝不能破坏别的参数）
 *
 * 背景（灾难现场）：配置中心 apply 原为"整篇重渲染覆盖"——改一个模型，顺手把模板不认识
 * 的键全部抹掉（CTI_CLAUDE_CLI_PATH 被清 ⇒ claude 回落 .bat ⇒ spawn EINVAL）。
 *
 * 五原则：
 *  1. 键级合并：只写本次真正变更的键，其余原样保留；模板不认识的键（手工加的）一律 carry over
 *  2. 受保护键清单：apply 只补全、不覆盖、不删除（除非本次显式传入该键 = 用户明确改它）
 *  3. cordis.yml 托管区：只替换 BEGIN/END managed 区内，区外（插件/人工条目）永不碰
 *  4. 变更审计 + 自动备份：apply 前备份带时间戳，diff 落 logs/config-apply-<日期>.log
 *  5. 渲染与写入分离：render* 只产出目标内容，本模块负责合并落盘
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '..', '..', 'logs');

/** 受保护键：配置中心不拥有它们，apply 不得静默清除（显式传值除外） */
const PROTECTED_PATTERNS: RegExp[] = [
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

export function isProtectedKey(key: string): boolean {
  return PROTECTED_PATTERNS.some((re) => re.test(key));
}

export interface EnvChange {
  key: string;
  oldValue: string;
  newValue: string;
  kind: 'add' | 'update' | 'keep-protected';
}

interface ParsedLine { line: string; key?: string; value?: string }

function parseEnvLines(text: string): ParsedLine[] {
  return text.split('\n').map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return m ? { line, key: m[1], value: m[2] } : { line };
  });
}

/**
 * 合并 env：以现有文件为底，只应用 rendered 里的目标值。
 * @param existingText 现有文件内容（空串 = 首次生成）
 * @param renderedText 渲染器产出的目标内容
 * @param explicitKeys 本次请求显式提供的键（用户明确要改它 ⇒ 覆盖受保护键）
 */
export function mergeEnvText(
  existingText: string,
  renderedText: string,
  explicitKeys: Set<string> = new Set(),
): { text: string; changes: EnvChange[] } {
  const rendered = new Map<string, string>();
  for (const p of parseEnvLines(renderedText)) {
    if (p.key !== undefined) rendered.set(p.key, p.value ?? '');
  }

  const changes: EnvChange[] = [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const p of parseEnvLines(existingText)) {
    if (p.key === undefined) { out.push(p.line); continue; }
    seen.add(p.key);
    if (!rendered.has(p.key)) {
      // 模板不认识的键 → 原样保留（人工配置不丢）
      out.push(p.line);
      continue;
    }
    const target = rendered.get(p.key)!;
    const current = p.value ?? '';
    if (current === target) { out.push(p.line); continue; }
    if (isProtectedKey(p.key) && !explicitKeys.has(p.key)) {
      // 受保护键：保留现有值（空值才用渲染值补齐）
      changes.push({ key: p.key, oldValue: current, newValue: current, kind: 'keep-protected' });
      out.push(current.trim() ? p.line : `${p.key}=${target}`);
      continue;
    }
    changes.push({ key: p.key, oldValue: current, newValue: target, kind: 'update' });
    out.push(`${p.key}=${target}`);
  }

  // 渲染器新增的键
  for (const [k, v] of rendered) {
    if (seen.has(k)) continue;
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
      const shown = isProtectedKey(c.key) ? '(受保护/凭证，值不打日志)' : `${c.oldValue} -> ${c.newValue}`;
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
