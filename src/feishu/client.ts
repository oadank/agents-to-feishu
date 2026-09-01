/**
 * 飞书接入层 —— SDK 封装。
 * 只做一件事：把飞书的收发消息/卡片更新封装成简单函数，不掺业务逻辑。
 */

import lark, { Client } from '@larksuiteoapi/node-sdk';

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
}

export class FeishuClient {
  readonly sdk: Client;
  private opts: FeishuClientOptions;

  constructor(opts: FeishuClientOptions) {
    this.opts = opts;
    this.sdk = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
  }

  /** 发文字消息 */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.sdk.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  /** 发富文本（markdown 由上层转成 post 结构） */
  async sendPost(chatId: string, content: Record<string, unknown>): Promise<void> {
    await this.sdk.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify(content),
      },
    });
  }

  /** 更新已发出的 text 消息（流式更新用） */
  async updateTextMessage(messageId: string, text: string): Promise<void> {
    await this.sdk.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  // ── CardKit 流式卡片（对齐本地 agents-to-im preview-service 链路）──
  // 创建卡片实体 → 引用用户消息发送 → cardElement.content 增量流式更新 → settings 更新 summary

  /** 创建卡片实体（cardkit.v1.card.create），返回 card_id */
  async createCardkitCard(card: unknown): Promise<string | null> {
    const resp = await this.sdk.cardkit.v1.card.create({
      data: { type: 'card_json' as never, data: JSON.stringify(card) },
    });
    const cardId = resp?.data?.card_id;
    if (!cardId) {
      console.warn(`[feishu] createCardkitCard failed: code=${resp?.code} msg=${resp?.msg}`);
      return null;
    }
    return cardId;
  }

  /** 引用用户消息发送卡片实体（im/v1/messages reply，content={type:card, data:{card_id}}） */
  async sendCardByIdReply(replyToMessageId: string, cardId: string): Promise<string | null> {
    const token = await this.getTenantToken();
    const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      }),
    });
    const json = await resp.json() as { code?: number; msg?: string; data?: { message_id?: string } };
    if (json.code !== 0) {
      console.warn(`[feishu] sendCardByIdReply failed: code=${json.code} msg=${json.msg}`);
      return null;
    }
    return json.data?.message_id ?? null;
  }

  /** 增量更新卡片 element（cardkit.v1.cardElement.content，带 sequence） */
  async updateCardElement(cardId: string, elementId: string, content: string, sequence: number): Promise<boolean> {
    const resp = await this.sdk.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, sequence },
    });
    if (resp?.code !== 0 && resp?.code !== undefined) {
      console.warn(`[feishu] updateCardElement FAILED seq=${sequence} code=${resp?.code} msg=${resp?.msg}`);
      return false;
    }
    console.log(`[feishu] updateCardElement OK seq=${sequence} len=${content.length}`);
    return true;
  }

  /**
   * 更新卡片 settings（cardkit.v1.card.settings）：summary + 流式开关。
   *
   * `streaming_mode` 是 CardKit 的**独立开关**，与卡片 config 无关：
   * - true  = 开启流式更新（此后 cardElement.content 增量更新才可用）
   * - false = 关闭流式（本轮结束，卡片转为静态终态）
   *
   * 未开启就调 cardElement.content 会报 **300309（streaming mode is closed）**。
   * 2026-08-29 修复：此前从未开启过该开关，导致每一轮对话的流式更新都在第一次
   * 就失败并静默降级为整卡 PATCH（日志累计 207 次 300309）。
   */
  async updateCardSettings(cardId: string, summary: string, sequence: number, streamingMode?: boolean): Promise<boolean> {
    const settings: Record<string, unknown> = {};
    if (summary) settings.summary = { content: summary };
    if (streamingMode !== undefined) settings.streaming_mode = streamingMode;
    const resp = await this.sdk.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: {
        settings: JSON.stringify(settings),
        sequence,
      },
    });
    if (resp?.code !== 0 && resp?.code !== undefined) {
      console.warn(`[feishu] updateCardSettings failed: code=${resp?.code} msg=${resp?.msg} settings=${JSON.stringify(settings)}`);
      return false;
    }
    return true;
  }

  /** 整卡更新（cardkit.v1.card.update，可整体替换 body → 用于移除按钮等结构变化） */
  async updateCardBody(cardId: string, card: unknown, sequence = 0): Promise<boolean> {
    const resp = await this.sdk.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: {
        // SDK 要求 card={type:'card_json', data:<JSON字符串>}，且必须带 sequence
        card: { type: 'card_json' as never, data: JSON.stringify(card) },
        sequence,
      } as never,
    });
    if (resp?.code !== 0 && resp?.code !== undefined) {
      console.warn(`[feishu] updateCardBody failed: code=${resp?.code} msg=${resp?.msg}`);
      return false;
    }
    console.log(`[feishu] updateCardBody OK seq=${sequence}`);
    return true;
  }

  private tokenCache: { token: string; at: number } | null = null;

  private async getTenantToken(): Promise<string> {
    if (this.tokenCache && Date.now() - this.tokenCache.at < 100 * 60 * 1000) {
      return this.tokenCache.token;
    }
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
    });
    const json = await resp.json() as { code?: number; tenant_access_token?: string; msg?: string };
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new Error(`feishu token error: code=${json.code} msg=${json.msg}`);
    }
    this.tokenCache = { token: json.tenant_access_token, at: Date.now() };
    return json.tenant_access_token;
  }

  /** 发 interactive 卡片（HTTP 直调），返回 message_id */
  async sendCardHttp(chatId: string, card: unknown): Promise<string | null> {
    const token = await this.getTenantToken();
    const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
    });
    const json = await resp.json() as { code?: number; msg?: string; data?: { message_id?: string } };
    if (json.code !== 0) {
      console.warn(`[feishu] sendCardHttp failed: code=${json.code} msg=${json.msg}`);
      return null;
    }
    return json.data?.message_id ?? null;
  }

  /** 发 CardKit 卡片实体引用（content={type:card, data:{card_id}}，不引用用户消息），返回 message_id */
  async sendCardIdHttp(chatId: string, cardId: string): Promise<string | null> {
    const token = await this.getTenantToken();
    const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      }),
    });
    const json = await resp.json() as { code?: number; msg?: string; data?: { message_id?: string } };
    if (json.code !== 0) {
      console.warn(`[feishu] sendCardIdHttp failed: code=${json.code} msg=${json.msg}`);
      return null;
    }
    return json.data?.message_id ?? null;
  }

  /** 发 interactive 卡片并引用用户消息（reply 接口），返回 message_id */
  async replyCardHttp(replyToMessageId: string, card: unknown): Promise<string | null> {
    const token = await this.getTenantToken();
    const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) }),
    });
    const json = await resp.json() as { code?: number; msg?: string; data?: { message_id?: string } };
    if (json.code !== 0) {
      console.warn(`[feishu] replyCardHttp failed: code=${json.code} msg=${json.msg}`);
      return null;
    }
    return json.data?.message_id ?? null;
  }

  /** 发文本并引用用户消息（reply 接口） */
  async replyTextHttp(replyToMessageId: string, text: string): Promise<string | null> {
    const token = await this.getTenantToken();
    const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) }),
    });
    const json = await resp.json() as { code?: number; msg?: string; data?: { message_id?: string } };
    if (json.code !== 0) {
      console.warn(`[feishu] replyTextHttp failed: code=${json.code} msg=${json.msg}`);
      return null;
    }
    return json.data?.message_id ?? null;
  }

  /** 更新已发出的卡片（HTTP 直调 PATCH） */
  async updateCardHttp(messageId: string, card: unknown): Promise<boolean> {
    const token = await this.getTenantToken();
    const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ content: JSON.stringify(card) }),
    });
    const json = await resp.json() as { code?: number; msg?: string };
    console.log(`[feishu] updateCardHttp msgId=${messageId} resp=${JSON.stringify(json)}`);
    if (json.code !== 0) {
      console.warn(`[feishu] updateCardHttp failed: code=${json.code} msg=${json.msg}`);
      return false;
    }
    return true;
  }

  /** 发交互卡片（interactive msg_type） */
  async sendCard(chatId: string, card: unknown): Promise<void> {
    await this.sdk.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
  }

  /** 更新已发出的卡片（流式更新） */
  async updateCard(messageId: string, card: unknown): Promise<void> {
    await this.sdk.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
  }

  /** 发图片（file_key 需先上传） */
  async sendImage(chatId: string, fileKey: string): Promise<void> {
    await this.sdk.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: fileKey }),
      },
    });
  }

  /** 发语音（file_key 需先上传） */
  async sendAudio(chatId: string, fileKey: string): Promise<void> {
    await this.sdk.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'audio',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
  }

  /** 上传文件到飞书，返回 file_key */
  async uploadFile(filePath: string, fileType: 'stream' | 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' = 'stream'): Promise<string> {
    const fs = await import('node:fs');
    const file = fs.readFileSync(filePath);
    const response = await this.sdk.im.file.create({
      data: { file_type: fileType, file, file_name: filePath.split(/[\\/]/).pop() || 'file' },
    });
    const fileKey = response?.file_key;
    if (!fileKey) throw new Error('飞书文件上传成功但没有 file_key');
    return fileKey;
  }

  /** 上传图片到飞书，返回 image_key（发图片消息必须用 image_key，file_key 不通用） */
  async uploadImage(filePath: string): Promise<string> {
    const fs = await import('node:fs');
    const file = fs.readFileSync(filePath);
    const response = await this.sdk.im.image.create({
      data: {
        image_type: 'message',
        image: file,
      } as never,
    });
    const imageKey = (response as unknown as { image_key?: string })?.image_key;
    if (!imageKey) throw new Error('飞书图片上传成功但没有 image_key');
    return imageKey;
  }

  /** 获取消息内容（取 message_id 的原文） */
  async getMessage(messageId: string): Promise<{ msg_type: string; content: string } | null> {
    const resp = await this.sdk.im.message.get({ path: { message_id: messageId } });
    const items = (resp as unknown as { data?: { items?: Array<Record<string, unknown>> } }).data?.items;
    const item = items?.[0];
    if (!item) return null;
    return {
      msg_type: String(item.msg_type ?? ''),
      content: String(item.content ?? ''),
    };
  }

  /** 下载消息里的资源（图片/语音等），返回本地文件路径 */
  async downloadResource(messageId: string, fileKey: string, ext: string): Promise<string | null> {
    try {
      const response = await this.sdk.im.messageResource.get({
        params: { type: 'file' as never },
        path: { message_id: messageId, file_key: fileKey },
      });
      const stream = response.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs');
      const tmpDir = path.join(os.tmpdir(), 'agents-to-feishu');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `${Date.now()}-${fileKey}.${ext}`);
      fs.writeFileSync(tmpFile, Buffer.concat(chunks));
      return tmpFile;
    } catch (e) {
      console.warn(`[feishu] downloadResource failed:`, e);
      return null;
    }
  }
}
