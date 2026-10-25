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

/**
 * 剥掉链路机器标记（T-0036）：`lark_send_as_user` 会给 bot 间消息尾部自动追加
 * `(from-bot:X · 直接回复本消息即可…)`，还有 `[身份名]` 前缀 /「（自动回执）」。
 * 这些是**传输层落款，永远不可能是命令参数** —— 以前没净化，dsh 收到我发的 `/new`
 * 时落款被当成目录参数喂进 resolveWorkdir，状态栏显示成 `📁 C:\D\opt(from-bot:opencode · …)`。
 */
function stripMachineMarks(raw: string): string {
  return raw
    .replace(/\((?:from-bot|to-bot):[^)]*\)/g, ' ')
    .replace(/（自动回执）/g, ' ')
    .replace(/^\s*\[[^\]\n]{1,24}\]\s*/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function handleCommand(
  raw: string,
  chatId: string,
  engine: MessageEngine,
  sessions: SessionManager,
): Promise<void> {
  const [cmd, ...rest] = stripMachineMarks(raw).split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case '/de': {
      // [2026-09-25 老大定调] 副驾三选一：读本会话历史 → 本仓引擎判断/起草/排序 → 交互卡片。
      // 刻意不 import dsh 的任何东西：dsh-web 挂了、插件没装，这里照样出候选（模型在配置中心 :13600 各配各的）。
      console.log(`[agents-to-feishu] 执行 /de chat=${chatId.slice(0, 12)}`);
      await engine.runDeCommand(chatId);
      break;
    }
    case '/new':
    case '/new:default': {
      // 真正新建空白会话：新 id + 清上下文 + provider 开新 ACP session（不杀进程）
      console.log(`[agents-to-feishu] 执行 /new 命令 chat=${chatId.slice(0, 12)} arg=${arg || '(默认目录)'}`);
      const session = await sessions.reset(chatId);
      const dir = sessions.resolveWorkdir(arg || undefined);
      session.workdir = dir; // 🔴 别漏：状态栏 📁 与 provider 的 cwd 都读这个字段
      // 参数明显不是目录（落款/一串中文）→ 不污染工作区，按默认目录绑定并【当面说出来】
      const ignoredArg = !!arg && !sessions.looksLikeWorkdir(arg);
      // 文案对齐老项目：✅ 已新建 {agent} 会话｜工作区 \`{dir}\`｜直接对话即可
      await engine.sendCommandCard(
        chatId,
        `✅ 已新建 ${engine.botName} 会话｜工作区 \`${dir}\`｜直接对话即可`
        + (ignoredArg ? `\n⚠️ 参数「${arg.slice(0, 48)}」不是目录，已忽略（按默认目录绑定）` : ''),
      );
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
      // 🔴 老大令 2026-09-19：桥接不负责压缩，只负责传递 —— 把 "/compact" 原文灌进
      // 正常轮次管道（handleText 不再经过命令拦截，无回环），各家引擎用自己的原生
      // 压缩策略（claude-code 的 /compact、mimocode/codex 各家定义）；引擎不认就如实回。
      // 旧版桥自压（截500字拼摘要注入）已废：那是桥替引擎做梦，压缩质量与策略必须归引擎。
      //
      // [2026-10-18 全机排查] 只有 claude（claude-code）真正响应 /compact 命令并产出 compact_boundary。
      // 其余引擎实测均无原生 /compact：codex/workbuddy 把命令当聊天（codex 实测 FINAL 1399 字）；
      // mimo/opencode/openclaw 探针 session/compact = Method not found（T-0030 已判 C 类）；
      // gemini/hermes 只在每轮结算后 fire-and-forget notify session/compact，不响应命令文本；
      // zcode 归 B 类、压缩归引擎自管（桥不触发）；reasonix/openakita/dsh/deeptutor 零 compact 通道。
      // 桥不替引擎压缩（老大令 09-19），故统一如实回执，绝不再把命令当消息喂给模型。
      const botId = (process.env.CTI_BOT || '').toLowerCase();
      const COMPACT_NATIVE = new Set(['claude']);
      if (!COMPACT_NATIVE.has(botId)) {
        await engine.sendCommandCard(
          chatId,
          `⚠️ ${botId} 引擎没有 /compact 压缩命令（无原生压缩通道，桥也不替引擎压缩）。\n`
          + '要清上下文请发 /new；继续对话时引擎会按自己的能力自动压缩/告警。',
        );
        break;
      }
      await engine.handleText(chatId, raw.trim());
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
