/**
 * 语法闸门 —— apply / 重启前用 esbuild 纯转译检查 src 目录下所有 .ts 文件。
 *
 * 背景（2026-09-15 事故）：某 bot 把 src/providers/dsh.ts 改出
 * `359:128 Unterminated regular expression`，配置中心照常「保存即 apply + 重启」
 * ⇒ tsx 直读 src 的 bot 服务 spawn 即崩（日志连撞 3 次 esbuild TransformError），
 * 全线不可用，且排查时没人想到是"语法"这种最低级的问题。
 *
 * 关键约束：只做语法层转译，绝不 import / 执行被检文件
 * （providers 顶层有网络 / 文件系统副作用，import 即污染配置中心进程）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 项目根（本文件位于 src/config-center/，上溯两级） */
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

export interface SyntaxError { file: string; line: number; column: number; message: string; }
export interface SyntaxReport {
  ok: boolean;
  errors: SyntaxError[];
  filesChecked: number;
  ms: number;
  /** 闸门自身不可用（esbuild 加载失败等）⇒ 按策略放行并记日志，绝不因工具坏了就锁死配置中心 */
  checkerUnavailable?: string;
}

interface EsbuildLocation { file?: string; line?: number; column?: number; }
interface EsbuildMsg { text?: string; location?: EsbuildLocation; }
interface EsbuildLike {
  transformSync(code: string, opts: { loader: string; sourcefile: string }): unknown;
  stop?(): Promise<unknown>;
}

const MAX_REPORT = 8;

function rel(p: string): string {
  const r = path.relative(PROJECT_ROOT, p).replace(/\\/g, '/');
  return r && !r.startsWith('..') ? r : p.replace(/\\/g, '/');
}

/** 递归收 src 下全部 .ts/.tsx/.mts/.cts（跳过 node_modules/.git/dist 与 .d.ts） */
function listTsFiles(dir: string, acc: string[]): string[] {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { listTsFiles(full, acc); continue; }
    if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

let cached: EsbuildLike | null = null;

/**
 * 加载 esbuild（惰性单例）。候选路径已在本机核实：
 *   首选 = tsx 自带副本（与 bot 启动时真正用的转译器同源 ⇒ 判定最准，tsx@4.23 / esbuild@0.28.2）
 *   兜底 = 顶层 devDependency（esbuild@0.23.1）
 * 二者均为 CJS，绝对路径直接 require（esbuild 包无 exports map）。
 */
function loadEsbuild(): EsbuildLike {
  if (cached) return cached;
  const req = createRequire(import.meta.url);
  const candidates = [
    path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'node_modules', 'esbuild', 'lib', 'main.js'),
    path.join(PROJECT_ROOT, 'node_modules', 'esbuild', 'lib', 'main.js'),
  ];
  let lastErr: unknown = new Error('未找到任何 esbuild 副本');
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) { lastErr = new Error(`不存在: ${p}`); continue; }
      const m = req(p) as EsbuildLike;
      if (typeof m?.transformSync !== 'function') { lastErr = new Error(`无 transformSync: ${p}`); continue; }
      cached = m;
      return m;
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error('esbuild 加载失败');
}

/**
 * 全量扫描 src 语法。串行 transformSync：本机实测 47 文件 / 0.8MB ≈ 175ms
 * （首次含 esbuild.exe 冷启动 30ms），相对 nssm restart 的秒级开销零感知。
 */
export function checkSrcSyntax(rootDir?: string): SyntaxReport {
  const t0 = Date.now();
  let eb: EsbuildLike;
  try { eb = loadEsbuild(); } catch (e) {
    return { ok: true, errors: [], filesChecked: 0, ms: Date.now() - t0,
      checkerUnavailable: e instanceof Error ? e.message : String(e) };
  }
  const files = listTsFiles(path.join(rootDir || PROJECT_ROOT, 'src'), []);
  const errors: SyntaxError[] = [];
  for (const f of files) {
    let code: string;
    try { code = fs.readFileSync(f, 'utf8'); } catch { continue; }
    try {
      // 不传 target/format ⇒ 走 esbuild 默认 esnext，杜绝"新语法被误判"
      eb.transformSync(code, { loader: f.endsWith('.tsx') ? 'tsx' : 'ts', sourcefile: rel(f) });
    } catch (e) {
      const msgs = (e as { errors?: EsbuildMsg[] })?.errors;
      if (!Array.isArray(msgs) || msgs.length === 0) {
        errors.push({ file: rel(f), line: 0, column: 0, message: (e as Error)?.message ?? '语法错误' });
      } else {
        for (const m of msgs) {
          errors.push({
            file: rel(m?.location?.file || f),
            line: Number(m?.location?.line ?? 0),
            column: Number(m?.location?.column ?? 0) + 1, // esbuild 列 0-based，展示 +1
            message: String(m?.text ?? '语法错误'),
          });
        }
      }
      if (errors.length >= MAX_REPORT) break; // 早停：已确定坏了，不必扫完
    }
  }
  return { ok: errors.length === 0, errors, filesChecked: files.length, ms: Date.now() - t0 };
}

/** 中文错误串，直接回给网页前端展示（前端 setErr(data.error) 原样显示） */
export function formatSyntaxErrors(r: SyntaxReport): string {
  if (r.ok) return '';
  const lines = r.errors.slice(0, MAX_REPORT)
    .map((e) => `  · ${e.file}:${e.line}:${e.column} ${e.message}`);
  const more = r.errors.length > MAX_REPORT ? `\n  …另有 ${r.errors.length - MAX_REPORT} 处，修完上面再重扫` : '';
  return `源码语法校验未通过（扫描 ${r.filesChecked} 个 .ts 文件，发现 ${r.errors.length} 处）：\n`
    + `${lines.join('\n')}${more}\n`
    + `已拒绝本次保存与重启：bot 服务由 tsx 直读 src，带语法错的代码一重启就 spawn 即崩。`
    + `请先把上面文件的语法修好，再回来保存配置。`;
}
