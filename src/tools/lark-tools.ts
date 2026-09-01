/**
 * 飞书原生能力工具集（2026-08-30 内置化开工，老大拍板）
 *
 * 让 agent 把"飞书沟通"当作内置能力（而非靠注入提示词）：
 *   - lark_list_chats      机器人所在群/会话列表（含 chat_id，通讯录入口）
 *   - lark_chat_history    拉取某会话最近聊天记录（补上下文）
 *   - lark_send_text       机器人身份发文本消息（私聊/群，receive_id_type 可选）
 *
 * 凭证：当前 bot 的 appId/appSecret（tenant_access_token，缓存 1.5h）。
 * 挂载：mcp-stdio.ts 把本表并入 stdio MCP；claude SDK 侧后续同源接入。
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { markManualReceipt } from '../bridge/auto-receipt.js';
import { promisify } from 'node:util';

// P1 修复：异步 execFile（execFileSync 会阻塞桥接事件循环最长 60s×2，冻结 WS 心跳/流式卡片/其它会话）
const execFileAsync = promisify(execFile);
import path from 'node:path';
import { z } from 'zod';
import { readStore } from '../config-center/store.js';

export interface LarkToolCtx {
  /** 当前 bot 的内部 id（CTI_BOT） */
  botId: string;
}

interface TokenCacheEntry {
  token: string;
  expireAt: number;
}
const tokenCache = new Map<string, TokenCacheEntry>();

function botCredentials(botId: string): { appId: string; appSecret: string } | null {
  const a = readStore().agents.find((x) => x.id === botId);
  if (!a || !a.appId || !a.appSecret) return null;
  return { appId: a.appId, appSecret: a.appSecret };
}

async function tenantToken(botId: string): Promise<string> {
  const cached = tokenCache.get(botId);
  if (cached && cached.expireAt > Date.now() + 60_000) return cached.token;
  const cred = botCredentials(botId);
  if (!cred) throw new Error(`bot ${botId} 缺少飞书 appId/appSecret（设置中心补全后重试）`);
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cred.appId, app_secret: cred.appSecret }),
  });
  const j: any = await r.json();
  if (!j.tenant_access_token) throw new Error(`获取 tenant_access_token 失败: ${j.msg ?? '未知错误'}`);
  tokenCache.set(botId, { token: j.tenant_access_token, expireAt: Date.now() + (j.expire ?? 7200) * 1000 });
  return j.tenant_access_token;
}

/** 任意 bot 的 tenant token（bot_directory 用） */
async function tenantTokenByCred(appId: string, appSecret: string): Promise<string> {
  const cached = tokenCache.get(appId);
  if (cached && cached.expireAt > Date.now() + 60_000) return cached.token;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j: any = await r.json();
  if (!j.tenant_access_token) throw new Error(`获取 tenant_access_token 失败: ${j.msg ?? '未知错误'}`);
  tokenCache.set(appId, { token: j.tenant_access_token, expireAt: Date.now() + (j.expire ?? 7200) * 1000 });
  return j.tenant_access_token;
}

let botDirectoryCache: { at: number; data: string } | null = null;
/** 全部 bot 目录（open_id），缓存 10 分钟 */
async function buildBotDirectory(): Promise<string> {
  if (botDirectoryCache && botDirectoryCache.at > Date.now() - 10 * 60_000) return botDirectoryCache.data;
  // P2-6 修复：并行拉全部 bot（原串行 10 次 HTTP，每次最多 10s 超时）
  const items = (await Promise.all(
    readStore().agents
      .filter((a) => a.appId && a.appSecret)
      .map(async (a): Promise<Record<string, string>> => {
        try {
          const token = await tenantTokenByCred(a.appId!, a.appSecret!);
          const r = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          });
          const j: any = await r.json();
          if (j?.bot?.open_id) {
            return { name: j.bot.app_name || a.displayName || a.id, agentId: a.id, open_id: j.bot.open_id, activate_status: String(j.bot.activate_status ?? '') };
          }
          return { name: a.displayName || a.id, error: 'bot/v3/info 无 open_id' };
        } catch (e) {
          return { name: a.displayName || a.id, error: e instanceof Error ? e.message : String(e) };
        }
      }),
  )) as Array<Record<string, string>>;
  const data = JSON.stringify({ count: items.length, bots: items, note: '给其他 bot 发私聊：lark_send_text 用 receive_id_type=open_id + 对方 open_id' }, null, 1);
  botDirectoryCache = { at: Date.now(), data };
  return data;
}

async function larkApi(botId: string, method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
  const token = await tenantToken(botId);
  const r = await fetch(`https://open.feishu.cn/open-apis${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j: any = await r.json();
  if (j.code !== 0) throw new Error(`飞书 API ${j.code}: ${j.msg}`);
  return j.data;
}

/** 上传图片（multipart），返回 image_key */
async function uploadImage(botId: string, filePath: string): Promise<string> {
  const token = await tenantToken(botId);
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('image_type', 'message');
  form.append('image', new Blob([new Uint8Array(buf)]), path.basename(filePath));
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const j: any = await r.json();
  if (j.code !== 0) throw new Error(`上传图片失败 ${j.code}: ${j.msg}`);
  return j.data.image_key;
}

export interface LarkBuiltinTool {
  name: string;
  description: string;
  schema: Record<string, any>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}


/** 2026-08-31 自动回执：以用户身份给指定 agent 发文本（tool 与桥接自动转发共用）。
 *  text 由调用方组装；本函数负责 agentId→私聊 chat_id 解析（翻全页）+ 发送。 */
export async function sendAsUserToBot(to: string, text: string): Promise<void> {
  const runjs = 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  if (!fs.existsSync(runjs)) throw new Error('lark-cli 未安装');
  const dir = JSON.parse(await buildBotDirectory()) as { bots: Array<{ agentId?: string; name?: string }> };
  const target = dir.bots.find((b) => b.agentId === to);
  if (!target) throw new Error(`目录里没有 agentId=${to} 的 bot`);
  let items: Array<{ chat_id?: string; name?: string; p2p_target_id?: string }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const args = [runjs, 'im', '+chat-list', '--types=p2p', '--page-size', '100', '--as', 'user'];
    if (pageToken) args.push('--page-token', pageToken);
    const r = await execFileAsync(node, args, { timeout: 60_000, encoding: 'utf-8' as 'buffer', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    const out = String(r.stdout);
    const i = out.lastIndexOf('\n{');
    const parsed = JSON.parse(i >= 0 ? out.slice(i + 1) : out);
    const data = parsed?.data ?? {};
    items.push(...((data.chats ?? data.items ?? []) as Array<{ chat_id?: string; name?: string; p2p_target_id?: string }>));
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  const want = (target.name || to).trim();
  const exact = items.filter((c) => (c.name || '').trim() === want);
  const fuzzy = exact.length === 0 ? items.filter((c) => (c.name || '').includes(want)) : [];
  const cands = exact.length > 0 ? exact : fuzzy;
  if (cands.length > 1) throw new Error(`私聊会话名「${want}」命中多个`);
  const hit = cands[0];
  if (!hit?.chat_id) throw new Error(`未找到与 ${want} 的私聊会话`);
  const r = await execFileAsync(node, [runjs, 'im', '+messages-send', '--chat-id', hit.chat_id, '--text', text, '--as', 'user'], { timeout: 60_000, encoding: 'utf-8' as 'buffer', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (!/"ok"[: ]+true/.test(String(r.stdout))) throw new Error(`lark-cli 发送失败: ${String(r.stdout).slice(0, 200)}`);
}

export function buildLarkTools(ctx: LarkToolCtx): LarkBuiltinTool[] {
  return [
    {
      name: 'lark_list_chats',
      description: '列出当前机器人所在的全部飞书会话（群聊/私聊），返回 chat_id 和名称。要给其他 agent/群发消息前，先用它拿 chat_id。',
      schema: {},
      execute: async () => {
        const data: any = await larkApi(ctx.botId, 'GET', '/im/v1/chats?page_size=50');
        const items = (data?.items ?? []).map((c: any) => ({ chat_id: c.chat_id, name: c.name, type: c.chat_type }));
        return JSON.stringify({ count: items.length, items }, null, 1);
      },
    },
    {
      name: 'lark_chat_history',
      description: '拉取某个飞书会话最近的聊天记录（默认 20 条，含发送者与内容摘要）。需要先有 chat_id（lark_list_chats 可查）。',
      schema: {
        chat_id: z.string().describe('会话 ID（lark_list_chats 查到）'),
        count: z.number().optional().describe('条数，默认 20，最大 50'),
      },
      execute: async (args) => {
        const chatId = String(args.chat_id ?? '');
        if (!chatId) throw new Error('chat_id 必填');
        const count = Math.min(Number(args.count ?? 20) || 20, 50);
        const data: any = await larkApi(ctx.botId, 'GET', `/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=${count}`);
        const items = (data?.items ?? []).map((m: any) => ({
          sender: m.sender?.id_type === 'open_id' ? m.sender?.id : m.sender?.sender_id,
          type: m.msg_type,
          time: new Date(Number(m.create_time) * 1000).toISOString().slice(11, 19),
          body: typeof m.body?.content === 'string' ? m.body.content.slice(0, 200) : '',
        })).reverse();
        return JSON.stringify({ chat_id: chatId, count: items.length, items }, null, 1);
      },
    },
    {
      name: 'lark_send_text',
      description: '机器人身份给指定会话/用户发一条文本消息。私聊用 receive_id_type=open_id + open_id；群用 receive_id_type=chat_id + chat_id。这是和飞书里其他人/群直接沟通的通道。',
      schema: {
        receive_id: z.string().describe('目标 ID（chat_id 或 open_id，取决于 receive_id_type）'),
        receive_id_type: z.enum(['chat_id', 'open_id']).optional().describe('ID 类型，默认 chat_id'),
        text: z.string().describe('要发送的文本内容'),
      },
      execute: async (args) => {
        const receiveId = String(args.receive_id ?? '');
        const idType = String(args.receive_id_type ?? 'chat_id');
        const text = String(args.text ?? '').trim();
        if (!receiveId || !text) throw new Error('receive_id 与 text 必填');
        const data: any = await larkApi(ctx.botId, 'POST', `/im/v1/messages?receive_id_type=${idType}`, {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        });
        return JSON.stringify({ ok: true, message_id: data?.message_id });
      },
    },
    {
      name: 'lark_send_image',
      description: '机器人身份给指定会话发一张本地图片（如：自己生成/看过的图）。需 chat_id（lark_list_chats 可查）与图片本地路径。',
      schema: {
        chat_id: z.string().describe('目标会话 ID'),
        image_path: z.string().describe('图片本地绝对路径'),
      },
      execute: async (args) => {
        const chatId = String(args.chat_id ?? '');
        const imgPath = String(args.image_path ?? '');
        if (!chatId || !imgPath) throw new Error('chat_id 与 image_path 必填');
        if (!fs.existsSync(imgPath)) throw new Error(`图片不存在: ${imgPath}`);
        const imageKey = await uploadImage(ctx.botId, imgPath);
        const data: any = await larkApi(ctx.botId, 'POST', '/im/v1/messages?receive_id_type=chat_id', {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        });
        return JSON.stringify({ ok: true, message_id: data?.message_id, image_key: imageKey });
      },
    },
    {
      name: 'lark_create_doc',
      description: '创建一篇飞书文档（docx），返回文档链接。标题必填，正文可选（纯文本，会写进文档首段）。',
      schema: {
        title: z.string().describe('文档标题'),
        content: z.string().optional().describe('正文纯文本（可选）'),
        folder_token: z.string().optional().describe('目标文件夹 token（缺省=我的空间根目录）'),
      },
      execute: async (args) => {
        const title = String(args.title ?? '').trim();
        if (!title) throw new Error('title 必填');
        const body: Record<string, unknown> = { name: title };
        if (args.folder_token) body.folder_token = String(args.folder_token);
        const doc: any = await larkApi(ctx.botId, 'POST', '/docx/v1/documents', body);
        const documentId = doc?.document?.document_id;
        const content = String(args.content ?? '').trim();
        if (content && documentId) {
          // 写入正文：先拿根块，再在下面插文本块
          const root: any = await larkApi(ctx.botId, 'GET', `/docx/v1/documents/${documentId}/blocks/${documentId}`);
          const blockId = root?.block?.block_id ?? documentId;
          const lines = content.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 100);
          for (const line of lines) {
            try {
              await larkApi(ctx.botId, 'POST', `/docx/v1/documents/${documentId}/blocks/${blockId}/children`, {
                children: [{ block_type: 2, text: { elements: [{ text_run: { content: line } }] } }],
                index: -1,
              });
            } catch { /* 单行失败不阻塞 */ }
          }
        }
        return JSON.stringify({ ok: true, document_id: documentId, url: `https://feishu.cn/docx/${documentId}` });
      },
    },
    {
      name: 'lark_get_doc_text',
      description: '读取一篇飞书文档的纯文本内容（raw_content）。需要文档链接里的 document_id（/docx/后面的那串）。',
      schema: {
        document_id: z.string().describe('文档 ID（链接 /docx/ 后面的那串）'),
      },
      execute: async (args) => {
        const docId = String(args.document_id ?? '').trim();
        if (!docId) throw new Error('document_id 必填');
        const data: any = await larkApi(ctx.botId, 'GET', `/docx/v1/documents/${docId}/raw_content`);
        return JSON.stringify({ document_id: docId, content: data?.content ?? '' }, null, 1);
      },
    },
    {
      name: 'lark_bot_directory',
      description: '获取全部飞书 bot 的通讯目录（名字 + open_id + 各自视角下与其他 bot 的私聊 chat_id）。【重要】open_id 是 app 视角隔离的：目录里的 open_id 只对该 bot 自己有效，跨 bot 发消息不能用。正确用法：①给其他 bot 发消息→用你自己的 lark_list_chats 找你与对方的私聊 chat_id（p2p）；②目录同时返回每家 bot 视角的 p2p 会话表（botChats），可查"任何两家之间"的私聊 chat_id 供 send_as_user 参考。结果缓存 10 分钟。',
      schema: {},
      execute: async () => {
        // 在 buildBotDirectory 基础上聚合各 bot 视角的 p2p 私聊会话（跨 bot 传话的可靠 id 来源）
        const base = JSON.parse(await buildBotDirectory()) as { bots: Array<Record<string, string>> };
        // P2-6 修复：p2p 聚合并行拉（原串行 10 家，每家最多 10s）
        const botChats = (await Promise.all(
          base.bots
            .filter((b) => b.agentId && !b.error)
            .map(async (b): Promise<Record<string, unknown>> => {
              const aid = b.agentId as string;
              try {
                const token = await tenantToken(aid);
                const r = await fetch('https://open.feishu.cn/open-apis/im/v1/chats?page_size=50', {
                  headers: { Authorization: `Bearer ${token}` },
                  signal: AbortSignal.timeout(10_000),
                });
                const j: any = await r.json();
                const chats = (j?.data?.items ?? []).map((c: any) => ({ chat_id: c.chat_id, name: c.name, type: c.chat_type }));
                return { agentId: aid, count: chats.length, chats };
              } catch (e) {
                return { agentId: aid, error: e instanceof Error ? e.message : String(e) };
              }
            }),
        )) as Array<Record<string, unknown>>;
        // 求交集：全体 bot 共同所在的群（互通群，全自动，无需手抄）
        const withChats = botChats.filter((b: any) => Array.isArray(b.chats)) as Array<{ agentId: string; chats: Array<{ chat_id: string; name: string; type: string }> }>;
        let commonGroups: Array<{ chat_id: string; name: string }> = [];
        if (withChats.length >= 2) {
          const first = withChats[0];
          commonGroups = first.chats
            .filter((c: any) => withChats.every((b: any) => b.chats.some((x: any) => x.chat_id === c.chat_id)))
            .map((c: any) => ({ chat_id: c.chat_id, name: c.name }));
        }
        const merged = {
          ...base,
          botChats,
          commonGroups,
          note: '①commonGroups=全体 bot 共同所在的群（chat_id 全局唯一，任何成员 bot 都能往里发消息，全体 bot 都会收到——bot 间互通就发这里）。②各 bot 之间没有私聊会话（飞书不支持 bot→bot 私聊）。③给用户发消息用用户 open_id（send_as_user 或你视角下与用户的私聊 chat_id）。',
        };
        return JSON.stringify(merged, null, 1);
      },
    },
    {
      name: 'lark_send_post',
      description: '机器人身份发富文本消息（post）：支持多段落、@人、链接。text 里可直接写 <at user_id="ou_xxx"></at> 标签来@人，每行一个段落。【@人必读】at 标签的 user_id 必须用 lark_chat_members 查到的"你自己视角"open_id，用别家视角的 id 会 @ 失败或 @ 错人。',
      schema: {
        receive_id: z.string().describe('目标 ID（chat_id 或 open_id）'),
        receive_id_type: z.enum(['chat_id', 'open_id']).optional().describe('ID 类型，默认 chat_id'),
        title: z.string().optional().describe('富文本标题（可选）'),
        text: z.string().describe('正文，支持多行；@人写 <at user_id="ou_xxx"></at>'),
      },
      execute: async (args) => {
        const receiveId = String(args.receive_id ?? '');
        const idType = String(args.receive_id_type ?? 'chat_id');
        const body = String(args.text ?? '');
        if (!receiveId || !body.trim()) throw new Error('receive_id 与 text 必填');
        const parseLine = (line: string): unknown[] => {
          const els: unknown[] = [];
          const re = /<at user_id="([^"]+)"\s*\/?>(?:<\/at>)?/g;
          let last = 0, m: RegExpExecArray | null;
          while ((m = re.exec(line)) !== null) {
            if (m.index > last) els.push({ tag: 'text', text: line.slice(last, m.index) });
            els.push({ tag: 'at', user_id: m[1] });
            last = m.index + m[0].length;
          }
          els.push({ tag: 'text', text: line.slice(last) });
          return els;
        };
        const content = body.split('\n').filter((l) => l.trim() !== '').map(parseLine);
        if (content.length === 0) throw new Error('正文为空');
        const post: Record<string, unknown> = { zh_cn: { content } };
        if (args.title) (post.zh_cn as Record<string, unknown>).title = String(args.title);
        const data: any = await larkApi(ctx.botId, 'POST', `/im/v1/messages?receive_id_type=${idType}`, {
          receive_id: receiveId,
          msg_type: 'post',
          content: JSON.stringify(post),
        });
        return JSON.stringify({ ok: true, message_id: data?.message_id });
      },
    },
    {
      name: 'lark_send_as_user',
      description: '以用户（陈丹）身份给其他 bot 发消息（主动发起传话/派活时用）。【勿用于回执】收到别的 bot 传话后直接正常文字回复即可——桥接自动转达，用本工具回执会让对方收到两条重复。支持群聊：receive_id_type 传 chat_id 时可在群里发（@ 人/@ bot 的正确方式：text 里写 <at user_id=\"lark_chat_members 返回的 id\"></at>）。'
        + '【推荐用法】to 直接传对方 agentId（如 to="codex"）——系统自动定位与该 bot 的私聊会话并发送，无需任何手工 id。'
        + '【闭环协议】①派活：先 lark_list_chats 找你自己与用户（陈丹）的私聊 chat_id（p2p 会话），写进消息末尾：（完成后请用 lark_send_as_user(to="发起方agentId") 回复，文首带 [你的身份名]）；②回执：收到派活的 bot 完成后，再调本工具 to=发起方agentId 把结果发回去——发起方会在自己私聊里收到结果。'
        + '消息以陈丹的名义出现，文首必须标注你的身份（如 [hermes]）。',
      schema: {
        to: z.string().optional().describe('对方 agentId（推荐，如 codex/claude）——自动定位私聊会话'),
        target_id: z.string().optional().describe('对方 ID（open_id 或私聊 chat_id；与 to 二选一）'),
        id_type: z.enum(['user_id', 'chat_id']).optional().describe('target_id 的类型，默认 user_id'),
        text: z.string().describe('要传的话（建议文首带 [你的身份名] 前缀）'),
      },
      execute: async (args) => {
        const runjs = 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js';
        const node = 'C:\\Program Files\\nodejs\\node.exe';
        if (!fs.existsSync(runjs)) throw new Error('lark-cli 未安装');
        const text = String(args.text ?? '').trim();
        if (!text) throw new Error('text 必填');
        let sendArgs: string[] | null = null;
        if (args.to) {
          // 2026-08-31 自动回执：bot 间消息附标记，接收方桥接检测后自动把其回复转发回来（模型零纪律）
          const to = String(args.to);
          const fromBot = process.env.CTI_BOT || 'unknown';
          markManualReceipt(); // 本 bot 主动用工具发消息 → onReplySent 跳过自动转发（防双份）
          const marked = `${text}\n\n(from-bot:${fromBot} · 直接回复本消息即可，桥接自动转达，勿调 send_as_user)`;
          await sendAsUserToBot(to, marked);
          return JSON.stringify({ ok: true, via: 'user(陈丹身份)', note: '已附自动回执标记，对方直接回复即可送达你' });
        } else {
          const targetId = String(args.target_id ?? '');
          if (!targetId) throw new Error('to 与 target_id 至少传一个');
          const idType = String(args.id_type ?? 'user_id') === 'chat_id' ? '--chat-id' : '--user-id';
          sendArgs = ['im', '+messages-send', idType, targetId, '--text', text, '--as', 'user'];
        }
        if (!sendArgs) throw new Error('to 与 target_id 至少传一个');
        let out: string;
        try {
          const r = await execFileAsync(node, [runjs, ...sendArgs], { timeout: 60_000, encoding: 'utf-8' as 'buffer', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
          out = String(r.stdout);
        } catch (e) {
          throw new Error(`lark-cli 调用失败: ${(e as Error)?.message ?? String(e)}`);
        }
        const okFlag = /"ok"[: ]+true/.test(out);
        if (!okFlag) throw new Error(`lark-cli 返回异常: ${out.slice(0, 200)}`);
        return JSON.stringify({ ok: true, via: 'user(陈丹身份)', note: '文首记得已带身份前缀' });
      },
    },
    {
      name: 'lark_chat_members',
      description: '获取群聊成员列表：users[]（人）+ bots[]（bot，含 app_id 可对应 agentId）。【@ 唯一正确姿势】在群里 @ 人或 @ 某个 bot：必须用 lark_send_as_user（用户身份）发消息，at 标签的 user_id 用本工具返回的 member_id（用户视角）——bot 身份发消息时群里无法正确 @ 其他 bot（飞书限制，别再试）。bot 名 ↔ agentId 对应：bots[].app_id 与配置中心 agents 的 appId 相同。',
      schema: {
        chat_id: z.string().describe('群聊 id（用 lark_list_chats 查）'),
      },
      execute: async (args: Record<string, unknown>) => {
        const chatId = String(args.chat_id ?? '').trim();
        if (!chatId) throw new Error('chat_id 必填');
        const node = 'C:/Program Files/nodejs/node.exe';
        const runjs = 'C:/Users/oadan/AppData/Roaming/npm/node_modules/@larksuite/cli/scripts/run.js';
        if (!fs.existsSync(runjs)) throw new Error('lark-cli 未安装');
        let out: string;
        try {
          const r = await execFileAsync(node, [runjs, 'im', '+chat-members-list', '--chat-id', chatId], { timeout: 60_000, encoding: 'utf-8' as 'buffer', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
          out = String(r.stdout);
        } catch (e) {
          throw new Error(`lark-cli 查成员失败（user token 可能未登录）: ${(e as Error)?.message ?? String(e)}`);
        }
        // 输出前置非 JSON 行（[page N] fetching.../Found X）——取最后一个 { 起的 JSON
        const i = out.lastIndexOf('\n{');
        const json = i >= 0 ? out.slice(i + 1) : out;
        let parsed: any;
        try { parsed = JSON.parse(json); } catch { throw new Error(`chat-members-list 输出非 JSON: ${out.slice(0, 120)}`); }
        const data = parsed?.data ?? {};
        const bots = (data.bots ?? []).map((b: any) => ({ open_id: b.member_id, name: b.name, app_id: b.app_id }));
        const users = (data.users ?? []).map((u: any) => ({ open_id: u.member_id ?? u.open_id, name: u.name }));
        return JSON.stringify({ ok: true, users, bots, note: 'at 标签用这里的 open_id（用户视角）；bots[].app_id 对应配置中心 appId → agentId' }, null, 1);
      },
    },
  ];
}
