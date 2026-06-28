// Real Lark-backed FeishuTransport — the thin wrapper the hermetic test stubs out.
// Faithful to pikiloom's src/channels/feishu/channel.ts (im.v1.message.create / .patch +
// EventDispatcher). Lives in examples/ so the kernel package carries no @larksuiteoapi dep.
//
// NOTE: not exercised live in CI — inbound events need the Lark long-connection, which is
// single-per-app and is held by the running production pikiloom bot. To live-test, use a
// SEPARATE Feishu test app's credentials (appId/appSecret) so it doesn't contend with prod.
//
// @ts-nocheck  (example file; @larksuiteoapi/node-sdk resolved from the repo root)
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuTransport, InboundFeishuMessage } from './feishu-terminal.js';

export interface FeishuLarkOptions { appId: string; appSecret: string }

export class FeishuLarkTransport implements FeishuTransport {
  private client: lark.Client;
  private ws: lark.WSClient;
  private dispatcher: lark.EventDispatcher;
  private cb?: (m: InboundFeishuMessage) => void;

  constructor(opts: FeishuLarkOptions) {
    this.client = new lark.Client({ appId: opts.appId, appSecret: opts.appSecret });
    this.ws = new lark.WSClient({ appId: opts.appId, appSecret: opts.appSecret });
    this.dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        const msg = data?.message;
        if (!msg) return;
        let text = '';
        try { text = JSON.parse(msg.content || '{}').text || ''; } catch { /* non-text */ }
        this.cb?.({ chatId: msg.chat_id, text, messageId: msg.message_id });
      },
    });
  }

  async connect(): Promise<void> {
    await this.ws.start({ eventDispatcher: this.dispatcher });
  }

  onMessage(cb: (m: InboundFeishuMessage) => void): void { this.cb = cb; }

  async send(chatId: string, text: string): Promise<string> {
    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
    return resp?.data?.message_id || '';
  }

  async edit(messageId: string, text: string): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }) },
    });
  }
}
