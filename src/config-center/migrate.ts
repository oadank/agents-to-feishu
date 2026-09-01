/**
 * config-center migrate —— 从老系统 ~/.agents-to-im/config.env 迁移全部 bot 到 config-store.json。
 *
 * 用法：node --import tsx/esm src/config-center/migrate.ts [--dry]
 *  --dry : 只打印将要迁移的 agent 清单，不写入 store。
 *
 * 迁移策略（用户确认 2026-08-25）：全迁 10 个，每个保留飞书凭证/显示名/端口，
 * runtime 统一收敛为 dsh（DSH ACP 架构）；默认模型 = 第一个 provider 的第一个模型；
 * 默认 MCP = agentmemory + wiki。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readStore, writeStore, type AgentDef, type ConfigStore } from './store.js';

// 解析老 config.env（严格 KEY=VALUE，对齐 config.ts parseEnvFile）
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    const strip = (s: string) => (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
    out[strip(k)] = strip(v);
  }
  return out;
}

export function migrateAgents(opts: { oldEnvFile?: string; dry?: boolean } = {}): { agents: Omit<AgentDef, 'workdir' | 'enabled' | 'showToolCallCards' | 'showAgentDivider'>[]; created: string[] } {
  const oldFile = opts.oldEnvFile || path.join(process.env.CTI_USER_HOME || 'C:\\Users\\oadan', '.agents-to-im', 'config.env');
  if (!fs.existsSync(oldFile)) throw new Error(`老配置不存在: ${oldFile}`);

  const env = parseEnv(fs.readFileSync(oldFile, 'utf8'));

  // 从前缀识别所有 bot（CTI_BOT_<NAME>_APP_ID 存在即算一个）
  const botIds = new Set<string>();
  for (const k of Object.keys(env)) {
    const m = k.match(/^CTI_BOT_([A-Z0-9]+)_APP_ID$/);
    if (m) botIds.add(m[1].toLowerCase());
  }
  if (botIds.size === 0) throw new Error('老配置里没有识别到任何 bot');

  const store = readStore();
  const existing = new Set(store.agents.map((a) => a.id));
  const defaultProvider = store.providers[0]?.id || '';
  const defaultModel = store.providers[0]?.models[0]?.id || '';

  const agents: Omit<AgentDef, 'workdir' | 'enabled' | 'showToolCallCards' | 'showAgentDivider'>[] = [];
  const created: string[] = [];

  const PORTS: Record<string, number> = {
    claude: 13580, codex: 13581, mimo: 13582, gemini: 13583, hermes: 13584,
    openakita: 13585, reasonix: 13586, openclaw: 13587, opencode: 13588, dsh: 13589,
  };

  for (const id of botIds) {
    if (existing.has(id)) continue; // 已存在不覆盖
    const P = (key: string, fb = '') => env[`CTI_BOT_${id.toUpperCase()}_${key}`] ?? env[`CTI_BOT_${id.toUpperCase()}_${key}`] ?? fb;

    const agent = {
      id,
      displayName: P('AGENT_NAME', id),
      appId: P('APP_ID', ''),
      appSecret: P('APP_SECRET', ''),
      providerId: defaultProvider,
      modelId: defaultModel,
      mcps: ['agentmemory', 'wiki'],
      port: PORTS[id] ?? (13600 + store.agents.length),
      showToolCallCards: true,
      showAgentDivider: true,
      workdir: 'C:\\D\\opt',
      enabled: true,
    };
    agents.push(agent);
    if (!opts.dry) {
      store.agents.push(agent);
      created.push(id);
    }
  }

  if (!opts.dry) writeStore(store);

  return { agents, created };
}

// 直接跑：node --import tsx/esm src/config-center/migrate.ts [--dry]
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('migrate.ts');
if (isMain) {
  const dry = process.argv.includes('--dry');
  const oldIdx = process.argv.indexOf('--old');
  const oldEnvFile = oldIdx >= 0 ? process.argv[oldIdx + 1] : undefined;
  try {
    const r = migrateAgents({ dry, oldEnvFile });
    console.log(`识别到 ${r.agents.length} 个待迁移 agent: ${r.agents.map((a) => a.id).join(', ')}`);
    if (dry) {
      console.log('(--dry 未写入)');
    } else {
      console.log(`已写入 ${r.created.length} 个: ${r.created.join(', ') || '(无新增)'}`);
    }
  } catch (e) {
    console.error('迁移失败:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
