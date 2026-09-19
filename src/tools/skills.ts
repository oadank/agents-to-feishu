/**
 * cti-builtin 技能读取件（2026-09-19 · 配套 workbuddy Phase 1）
 *
 * 职责边界：workbuddy 管清单注入与目录铺设；本模块只管**读**。
 * 工具：
 *   skill_index — 返回全部 {name, description, dir_path}
 *   skill_read  — 返回指定 SKILL.md 全文；支持模糊命中；查无必须报错、禁止编造
 *
 * 扫描根：
 *   1) 项目 skills/（配置中心同源，PROJECT_ROOT/skills）
 *   2) env CTI_SKILLS_DIRS（分号/冒号分隔的额外目录，workbuddy 铺目录可挂这里）
 * 红线：不碰 render.ts / look / registry 生图看图路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { BuiltinTool } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

export interface SkillEntry {
  name: string;
  description: string;
  dir_path: string;
}

function extraSkillRoots(): string[] {
  const raw = process.env.CTI_SKILLS_DIRS || '';
  return raw.split(/[;:]/).map((s) => s.trim()).filter(Boolean);
}

/** 技能根目录列表（去重，项目 skills/ 恒在首位） */
export function skillRoots(): string[] {
  const roots = [PROJECT_SKILLS_DIR, ...extraSkillRoots()];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
  }
  return out;
}

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** 从 SKILL.md 抽 description：frontmatter description 优先，否则首个非标题非空行 */
function extractDescription(content: string): string {
  const text = content.replace(/^﻿/, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const m = /^description:\s*(.+)$/m.exec(fm[1]);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '').slice(0, 200);
  }
  const ln = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find((x) => x !== '' && !x.startsWith('#') && !x.startsWith('---'));
  return (ln || '').slice(0, 200);
}

function listSkillDirs(root: string): string[] {
  const names: string[] = [];
  try {
    if (!fs.existsSync(root)) return names;
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory() && fs.existsSync(path.join(root, ent.name, 'SKILL.md'))) {
        names.push(ent.name);
      }
    }
  } catch { /* 权限/竞态：忽略该根 */ }
  return names;
}

/** 列出全部技能（多根合并，同名取先出现的根） */
export function listSkills(): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const root of skillRoots()) {
    for (const name of listSkillDirs(root).sort()) {
      if (byName.has(name)) continue;
      const dir = path.join(root, name);
      let description = '';
      try {
        description = extractDescription(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'));
      } catch { description = ''; }
      byName.set(name, { name, description, dir_path: dir });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按名解析技能（模糊）：
 *  1) 目录名精确
 *  2) 大小写不敏感精确
 *  3) 唯一子串包含
 * 多命中/零命中 → 抛错，绝不编造。
 */
export function resolveSkill(name: string): SkillEntry {
  const q = String(name ?? '').trim();
  if (!q) throw new Error('skill name 不能为空；请先调 skill_index 查看可用技能');
  const all = listSkills();
  if (!all.length) throw new Error('技能目录为空：没有任何含 SKILL.md 的技能（skills/ 未铺好或 CTI_SKILLS_DIRS 未配）');
  const exact = all.find((s) => s.name === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  const ci = all.filter((s) => s.name.toLowerCase() === lower);
  if (ci.length === 1) return ci[0];
  const sub = all.filter((s) => s.name.toLowerCase().includes(lower) || s.description.toLowerCase().includes(lower));
  if (sub.length === 1) return sub[0];
  const names = all.map((s) => s.name).join(', ');
  if (sub.length > 1) {
    throw new Error(`技能名「${q}」模糊命中多个：${sub.map((s) => s.name).join(' / ')}。请用 skill_index 确认精确名后重试。可选：${names}`);
  }
  throw new Error(`查无技能「${q}」（禁止编造内容）。可选技能：${names}`);
}

/** 读 SKILL.md 全文 */
export function readSkillMd(entry: SkillEntry): string {
  const file = path.join(entry.dir_path, 'SKILL.md');
  try {
    const text = fs.readFileSync(file, 'utf-8');
    if (!text.trim()) throw new Error(`技能「${entry.name}」的 SKILL.md 为空`);
    return text;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('技能「')) throw e;
    throw new Error(`读取技能「${entry.name}」失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** skill_index / skill_read 工具定义（与 registry 同构，stdio + claude 进程内共用） */
export function buildSkillTools(): BuiltinTool[] {
  return [
    {
      name: 'skill_index',
      description:
        '列出全部可用技能（项目 skills/ + CTI_SKILLS_DIRS）。'
        + '返回 JSON 数组：[{name, description, dir_path}]。'
        + '需要查操作手册/运维姿势时先调本工具，再用 skill_read(name) 读全文。',
      schema: {},
      execute: async () => {
        const skills = listSkills();
        return JSON.stringify({ ok: true, count: skills.length, roots: skillRoots(), skills }, null, 2);
      },
    },
    {
      name: 'skill_read',
      description:
        '读取某个技能的 SKILL.md 全文。参数 name 可精确或唯一模糊命中。'
        + '查无/多命中会明确报错并列出候选，不会编造内容。'
        + '先 skill_index 看清单，再 skill_read。',
      schema: {
        name: z.string().describe('技能名（如 feishu-bridge）；支持唯一子串模糊匹配'),
      },
      execute: async (args) => {
        const entry = resolveSkill(String(args.name ?? ''));
        const content = readSkillMd(entry);
        return JSON.stringify({
          ok: true,
          name: entry.name,
          description: entry.description,
          dir_path: entry.dir_path,
          content,
        }, null, 2);
      },
    },
  ];
}
