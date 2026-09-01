/**
 * RuntimeProvider 统一接口 —— 架构锚点。
 *
 * 每个 AI 运行时（claude/codex/dsh/gemini/...）实现这个接口，
 * 桥接层只依赖接口，不关心各家接入方式（CLI/ACP/HTTP/直连）。
 */

/** 流式事件：桥接层只认这几种事件 */
export type StreamEvent =
  | { type: 'text'; text: string } // 已提交的正文增量
  | { type: 'thinking'; text: string } // 思考层增量（可选）
  | { type: 'tool'; tool: string; input?: string; status?: 'running' | 'done' | 'error'; output?: string } // 工具调用；output=工具结果文本（dsh ACP rawOutput，send_voice 投递靠它拿 voiceId）
  | { type: 'permission'; request: PermissionRequest } // 权限申请（卡片弹窗）
  | { type: 'question'; question: QuestionRequest } // AskUserQuestion 选择题/填空题（卡片弹窗）
  | { type: 'usage'; usage: UsageInfo; sessionId?: string } // token 统计（缓存命中率/上下文）；sessionId = ACP 真实会话 id（状态条显示用）
  | { type: 'error'; message: string } // 真实错误（必须推给用户，禁止静默卡住）
  | { type: 'done' }; // 本轮结束

/** 权限申请：对应飞书"允许/拒绝"卡片 */
export interface PermissionRequest {
  id: string;
  tool: string;
  description: string;
  options?: Array<{ label: string; value: string }>;
}

/** 选择题/填空题：对应飞书交互卡片（插队、选择、填写） */
export interface QuestionRequest {
  id: string;
  prompt: string;
  kind: 'choice' | 'text' | 'confirm';
  options?: string[];
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number; // 缓存命中
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** 请求总次数（用于平均缓存率） */
  requests?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatParams {
  /** 用户消息原文（图片/语音转写后的文本也拼在这里） */
  text: string;
  /** 附件列表（图片路径/语音转写等） */
  attachments?: Array<{ type: 'image' | 'audio' | 'file'; path?: string; text?: string }>;
  /** 注入的系统提示词（人设/团队认知） */
  systemPrompt?: string;
  /** 桥接层会话 id（用于区分不同 chat 的 ACP session） */
  sessionKey: string;
  /** 是否需要新建空白会话（/new 后第一条消息必为 true） */
  freshSession?: boolean;
  /** 会话内已累积的正文（发给 CLI 型运行时的历史回放；/compact 摘要也在里面） */
  history?: ChatMessage[];
  /**
   * 会话绑定的工作目录（/new [目录] 指定，缺省用 provider 默认）。
   * 2026-08-29 新增：此前该字段缺失，导致 /new 绑定目录对所有 runtime 都不生效
   * ——命令回了"✅ 已新建…工作区 xxx"、状态行也显示新目录，但子进程 cwd 从未改变。
   */
  workdir?: string;
  /** 中断信号：外部调用 stop() 时触发 */
  signal?: AbortSignal;
}

export interface RuntimeProvider {
  readonly name: string;

  /** 启动前自检：依赖/配置是否就绪（失败则 bot 拒绝启动并报错） */
  prepare(): Promise<void>;

  /** 流式对话：消费 params，产出 StreamEvent 序列 */
  streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent>;

  /**
   * /new：真正新建空白会话（kill 底层进程/清空上下文，不是只换 id）。
   * 2026-08-29：加可选 sessionKey —— SessionManager.reset 早已把 chatId 传给
   * onSessionReset（session.ts:102），但接口没这个参数导致 index.ts 把它丢弃，
   * in-process 组的 resetSession 因拿不到 key 而从不删 map 条目。
   */
  resetSession(sessionKey?: string): Promise<void>;

  /** /stop：中断当前任务（尽力而为，超时强制） */
  interrupt(): Promise<void>;

  /**
   * 桥接内置工具接线（Phase 1，可选实现）：注入 sendVoice/getSpeech 依赖，
   * 让 provider 把 ToolRegistry 的进程内工具注入给模型。须在首条消息前调用。
   */
  attachBridgeTools?(deps: import('../tools/registry.js').BridgeToolDeps): void;

  /** 资源清理（进程退出时） */
  dispose(): Promise<void>;
}
