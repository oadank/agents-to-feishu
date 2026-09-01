/**
 * 命令处理 —— /new /stop /compact /model /status /help
 */

import type { MessageEngine } from './bridge/engine.js';
import type { SessionManager } from './bridge/session.js';
import fs from 'node:fs';
import path from 'node:path';

/** /sendimg 允许外发的图片扩展名 */
const SENDABLE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

/** 敏感路径片段：命中即拒绝外发（凭证 / 私钥 / 配置） */
const SENSITIVE_PATH_PATTERNS = [
  '.ssh', '.aws', '.gnupg',
  'id_rsa', 'id_ed25519',
  '.npmrc', '.credentials', 'credential',
  '\\.dsh\\', '\\.agents-to-feishu\\',
  'config-store.json', 'config.env',
];

/**
 * /sendimg 路径安全校验（2026-08-29 新增）。
 *
 * 背景：/sendimg 会把本机文件读走并上传飞书。原先唯一的校验是 `fs.existsSync`，
 * 等于给 allowlist 内用户开了一个**任意文件外传**口子 —— 例如
 * `/sendimg C:\Users\oadan\.ssh\id_rsa` 就能把私钥发进飞书。
 * 三重限制：扩展名白名单 + 路径规范化（path.resolve 消除 ..）+ 敏感位置黑名单。
 */
function validateSendableImage(input: string): { ok: true } | { ok: false; reason: string } {
  const raw = input.trim().replace(/^["']+|["']+$/g, '');
  if (!raw) return { ok: false, reason: '路径为空' };
  const abs = path.resolve(raw);
  const ext = path.extname(abs).toLowerCase();
  if (!SENDABLE_IMAGE_EXT.has(ext)) {
    return { ok: false, reason: `只允许图片文件（${[...SENDABLE_IMAGE_EXT].join(' / ')}），实际为 \`${ext || '无扩展名'}\`` };
  }
  const lower = abs.toLowerCase();
  for (const pat of SENSITIVE_PATH_PATTERNS) {
    if (lower.includes(pat)) {
      return { ok: false, reason: '该路径位于敏感位置（凭证 / 密钥 / 配置），禁止外发' };
    }
  }
  return { ok: true };
}

export async function handleCommand(
  raw: string,
  chatId: string,
  engine: MessageEngine,
  sessions: SessionManager,
): Promise<void> {
  const [cmd, ...rest] = raw.trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case '/new':
    case '/new:default': {
      // 真正新建空白会话：新 id + 清上下文 + provider 开新 ACP session（不杀进程）
      console.log(`[agents-to-feishu] 执行 /new 命令 chat=${chatId.slice(0, 12)} arg=${arg || '(默认目录)'}`);
      const session = await sessions.reset(chatId);
      const dir = sessions.resolveWorkdir(arg || undefined);
      session.workdir = dir;
      // 文案对齐老项目：✅ 已新建 {agent} 会话｜工作区 \`{dir}\`｜直接对话即可
      await engine.sendCommandCard(chatId, `✅ 已新建 ${engine.botName} 会话｜工作区 \`${dir}\`｜直接对话即可`);
      break;
    }
    case '/stop': {
      // /stop 对所有 agent 通用：先标 session 状态，再真中断底层 provider（DSH/Claude 等真实 stop，其余尽力）
      await sessions.interrupt(chatId);
      await engine.interruptProvider();
      await engine.sendCommandCard(chatId, '⏹ 已发送中断请求');
      break;
    }
    case '/compact': {
      const session = sessions.get(chatId);
      if (!session || session.context.length === 0) {
        await engine.sendCommandCard(chatId, '当前会话没有可压缩的上下文。');
        break;
      }
      // 桥接层级压缩：把历史上下文汇总成摘要，注入下一条消息
      const rawCount = session.context.length;
      const summary = session.context
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 500)}`)
        .join('\n');
      session.context = [{ role: 'user', content: `[会话已压缩]\n\n${summary}` }];
      // 必须标记 fresh：engine 只在 fresh 轮次把 history 传给 provider，
      // 少了这一步摘要就永远停在内存里发不出去（2026-08-29 修复）。
      session.pendingFresh = true;
      await engine.sendCommandCard(chatId, `✅ 上下文已压缩（${rawCount} 段 → 1 段摘要）。下一条消息将开新会话并携带摘要继续。`);
      break;
    }
    case '/model': {
      await engine.sendCommandCard(chatId, `当前模型配置：\nModel: ${engine.modelGroup || 'N/A'}\nProvider: ${engine.modelProvider || 'N/A'}\n\n模型切换将在后台管理页实现（P5 阶段）。`);
      break;
    }
    case '/sendimg': {
      // 发图：/sendimg <本地图片路径>，上传飞书并发送
      const p = arg.trim();
      if (!p) {
        await engine.sendCommandCard(chatId, '用法：/sendimg <本地图片路径>  —— 例：/sendimg C:\\path\\to\\image.png');
        break;
      }
      // 安全校验：堵住任意文件外传（详见 validateSendableImage 注释）
      const check = validateSendableImage(p);
      if (!check.ok) {
        await engine.sendCommandCard(chatId, `❌ ${check.reason}`);
        break;
      }
      if (!fs.existsSync(p)) {
        await engine.sendCommandCard(chatId, `图片不存在：\`${p}\``);
        break;
      }
      const ok = await engine.sendImageFile(chatId, p);
      await engine.sendCommandCard(chatId, ok ? `✅ 已发送图片：\`${p}\`` : `❌ 图片发送失败：\`${p}\``);
      break;
    }
    case '/status': {
      const session = sessions.get(chatId);
      if (!session) {
        await engine.sendCommandCard(chatId, '尚无会话，发消息自动创建');
        break;
      }
      const last = sessions.lastCacheRate(session);
      const avg = sessions.avgCacheRate(session);
      await engine.sendCommandCard(
        chatId,
        `📊 会话状态\nID: ${session.id.slice(0, 8)}\n目录: ${session.workdir}\n状态: ${session.status}\n最近缓存: ${last.toFixed(2)}%\n平均缓存: ${avg.toFixed(2)}%`,
      );
      break;
    }
    case '/help':
      await engine.sendCommandCard(
        chatId,
        `可用命令：\n/new [目录] — 新建空白会话并绑定目录\n/compact — 压缩当前会话上下文\n/model — 查看当前模型配置\n/sendimg <路径> — 发送本地图片\n/stop — 中断当前任务\n/status — 会话状态与用量\n/help — 帮助`,
      );
      break;
    default:
      await engine.sendCommandCard(chatId, `未知命令 ${cmd}，输入 /help 查看帮助`);
  }
}
