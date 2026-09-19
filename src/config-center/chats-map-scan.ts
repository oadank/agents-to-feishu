/**
 * chats-map 补账通道 —— [2026-09-19 票3]
 *
 * 背景：飞书 app（tenant_access_token）视角枚举不到 p2p 单聊（隐私墙实测，im/v1/chats 只回群），
 * 新 bot 的 p2p chat_id 只能靠老大人肉报，logs/chats-map.json 常缺账。
 * 本通道用 lark-cli **user 身份**（老大本人 token）扫老大视角会话（含 p2p，实测可列），
 * 再按 bot 显示名匹配名册（各 bot app 自己凭据调 /bot/v3/info 取 app_name）补账。
 *
 * 手动触发，不建定时：
 *   - 控制台端点：POST /api/tools/chats-map-scan（server.ts）
 *   - 命令行：npx tsx src/config-center/chats-map-scan.ts
 *
 * 补账纪律：只补缺失（added）；已有账与扫描不符只报 mismatch 不改（防误伤在用会话）；
 * 名册 bot 全都匹配不上、或扫到名册外的 bot 会话，都原样列进报告给老大看。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStore } from './store.js';

const execFileP = promisify(execFile);

// lark-cli 调用姿势与 server.ts user-self-test 同款（node + run.js 直调），PATH 里没有 lark-cli 也能跑
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const LARK_RUNJS = 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js';

export interface ChatsMapScanEntry {
  id: string;
  botName: string;
  chatId?: string;
  action: 'added' | 'kept' | 'mismatch' | 'no-chat' | 'token-fail' | 'info-fail';
  detail?: string;
}

export interface ChatsMapScanReport {
  ok: boolean;
  mapFile: string;
  scannedChats: number;
  agents: ChatsMapScanEntry[];
  /** 老大视角存在、但不属于名册的 bot 会话（如系统助手/历史实验 bot），只报告不动账 */
  unmatchedBotChats: Array<{ name: string; chatId: string }>;
  changed: boolean;
  error?: string;
}

type ChatItem = { chat_id: string; name?: string; p2p_target_type?: string };

async function larkCli(args: string[]): Promise<{ ok?: boolean; error?: { message?: string } | string; data?: { chats?: ChatItem[]; has_more?: boolean; page_token?: string } }> {
  const useDirect = fs.existsSync(NODE_EXE) && fs.existsSync(LARK_RUNJS);
  const cmd = useDirect ? NODE_EXE : 'lark-cli';
  const argv = useDirect ? [LARK_RUNJS, ...args] : args;
  const { stdout } = await execFileP(cmd, argv, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const out = JSON.parse(stdout) as { ok?: boolean; error?: { message?: string } | string };
  if (out?.ok === false) {
    const msg = typeof out.error === 'string' ? out.error : out.error?.message || JSON.stringify(out.error);
    throw new Error(`lark-cli 失败: ${msg}（user token 失效时先跑 POST /api/tools/user-auth-login 重新登录）`);
  }
  return out;
}

function readMap(mapFile: string): Record<string, string> {
  try {
    const m = JSON.parse(fs.readFileSync(mapFile, 'utf-8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

function writeMap(mapFile: string, map: Record<string, string>): void {
  fs.mkdirSync(path.dirname(mapFile), { recursive: true });
  fs.writeFileSync(mapFile, JSON.stringify(map, null, 0));
}

export async function scanChatsMap(): Promise<ChatsMapScanReport> {
  // chats-map.json 落仓库 logs/（与旧 scan-chats.mjs 同一份账）；模块位于 src/config-center/，上溯两级
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const mapFile = path.join(repoRoot, 'logs', 'chats-map.json');
  const agents = readStore().agents ?? [];

  // ① 老大视角 p2p 会话全翻页（必须 user 身份；app 视角枚举不到 p2p）
  const chats: ChatItem[] = [];
  let pageToken = '';
  do {
    const args = ['im', '+chat-list', '--types=p2p', '--page-size=100', '--as', 'user'];
    if (pageToken) args.push('--page-token', pageToken);
    const out = await larkCli(args);
    chats.push(...(out.data?.chats ?? []));
    pageToken = out.data?.has_more ? (out.data.page_token ?? '') : '';
  } while (pageToken);
  const botChats = chats.filter((c) => c.p2p_target_type === 'bot' && c.chat_id);

  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const byName = new Map<string, ChatItem>();
  for (const c of botChats) {
    const k = norm(c.name || '');
    if (k && !byName.has(k)) byName.set(k, c);
  }

  // ② 名册每户：自家 app 凭据取 bot 显示名 → 老大视角按名匹配
  const map = readMap(mapFile);
  const entries: ChatsMapScanEntry[] = [];
  const matchedNames = new Set<string>();
  let changed = false;
  for (const a of agents) {
    const base: ChatsMapScanEntry = { id: a.id, botName: '', action: 'no-chat' };
    try {
      const t = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: a.appId, app_secret: a.appSecret }),
      }).then((r) => r.json()) as { code: number; msg?: string; tenant_access_token?: string };
      if (t.code !== 0 || !t.tenant_access_token) {
        entries.push({ ...base, action: 'token-fail', detail: t.msg || 'tenant token 获取失败' });
        continue;
      }
      const b = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${t.tenant_access_token}` },
      }).then((r) => r.json()) as { bot?: { app_name?: string } };
      const appName = b?.bot?.app_name || '';
      base.botName = appName;
      if (appName) matchedNames.add(norm(appName));
      const hit = appName ? byName.get(norm(appName)) : undefined;
      if (!hit) {
        entries.push({ ...base, action: 'no-chat', detail: `老大视角无名为「${appName}」的 bot 单聊` });
        continue;
      }
      const existing = map[a.id];
      if (existing === hit.chat_id) {
        entries.push({ ...base, chatId: hit.chat_id, action: 'kept' });
      } else if (existing) {
        // 已有账与扫描不符：只报不改（现账可能是在用会话；改名/换号场景留给老大裁决）
        entries.push({ ...base, chatId: hit.chat_id, action: 'mismatch', detail: `账上现值与扫描结果不一致，未改` });
      } else {
        map[a.id] = hit.chat_id;
        changed = true;
        entries.push({ ...base, chatId: hit.chat_id, action: 'added' });
      }
    } catch (e) {
      entries.push({ ...base, action: 'info-fail', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  const unmatchedBotChats = botChats
    .filter((c) => !matchedNames.has(norm(c.name || '')))
    .map((c) => ({ name: c.name || '', chatId: c.chat_id }));
  if (changed) writeMap(mapFile, map);
  return { ok: true, mapFile, scannedChats: chats.length, agents: entries, unmatchedBotChats, changed };
}

// 命令行直跑：npx tsx src/config-center/chats-map-scan.ts
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  scanChatsMap()
    .then((r) => {
      console.log(JSON.stringify(r, null, 1));
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch((e) => {
      console.error('[chats-map-scan] 失败:', e instanceof Error ? e.message : e);
      process.exitCode = 1;
    });
}
