import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeComChannel } from '../src/channels/wecom/channel.ts';

interface FakeWs {
  readyState: number;
  OPEN: 1;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function attachFakeWs(ch: any) {
  const sent: any[] = [];
  const fakeWs: FakeWs = {
    readyState: 1,
    OPEN: 1,
    send: vi.fn((payload: string, cb: (err?: Error) => void) => {
      sent.push(JSON.parse(payload));
      cb();
    }),
    close: vi.fn(),
  };
  ch.ws = fakeWs;
  return { fakeWs, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WeComChannel frame parsing and send', () => {
  it('handles heartbeat ack, routes callbacks, dedups, enforces allowlists, and uses correct send commands', async () => {
    {
      const ch = new WeComChannel({ botId: 'bot-1', botSecret: 'sec-1' });
      (ch as any).missedPong = 2;
      (ch as any).handleFrame({ headers: { req_id: 'ping_5' } });
      expect((ch as any).missedPong).toBe(0);
    }

    {
      const ch = new WeComChannel({ botId: 'bot-1', botSecret: 'sec-1' });
      const seen: any[] = [];
      ch.onMessage((msg, ctx) => seen.push({ text: msg.text, chatId: ctx.chatId, reqId: ctx.reqId }));

      (ch as any).handleFrame({
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'srv-1' },
        body: {
          msgid: 'm-1',
          aibotid: 'aibot-1',
          chatid: 'group-99',
          chattype: 'group',
          from: { userid: 'alice' },
          msgtype: 'text',
          text: { content: '@aibot-1 hi pikiloom' },
        },
      });

      await new Promise(r => setImmediate(r));
      expect(seen).toEqual([{ text: 'hi pikiloom', chatId: 'group-99', reqId: 'srv-1' }]);
    }

    {
      const ch = new WeComChannel({ botId: 'bot-1', botSecret: 'sec-1' });
      const seen: any[] = [];
      ch.onMessage(msg => seen.push(msg));
      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'srv-2' },
        body: {
          msgid: 'dup',
          chatid: 'g',
          chattype: 'group',
          from: { userid: 'alice' },
          msgtype: 'text',
          text: { content: 'hi' },
        },
      };
      (ch as any).handleFrame(frame);
      (ch as any).handleFrame(frame);
      await new Promise(r => setImmediate(r));
      expect(seen.length).toBe(1);
    }

    {
      const ch = new WeComChannel({
        botId: 'bot-1',
        botSecret: 'sec-1',
        allowedUserIds: new Set(['boss']),
      });
      const seen: any[] = [];
      ch.onMessage(msg => seen.push(msg));
      (ch as any).handleFrame({
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'srv-3' },
        body: {
          msgid: 'm-2',
          chatid: 'g',
          chattype: 'group',
          from: { userid: 'random' },
          msgtype: 'text',
          text: { content: 'hi' },
        },
      });
      await new Promise(r => setImmediate(r));
      expect(seen).toEqual([]);
    }

    {
      const ch = new WeComChannel({ botId: 'bot-1', botSecret: 'sec-1' });
      const { sent } = attachFakeWs(ch);

      (ch as any).chatMeta.set('group-1', { pendingReqId: 'orig-req' });
      await ch.send('group-1', 'reply 1');

      expect(sent[0]).toMatchObject({
        cmd: 'aibot_respond_msg',
        headers: { req_id: 'orig-req' },
        body: { msgtype: 'stream' },
      });
      expect(sent[0].body.stream).toMatchObject({ finish: true, content: 'reply 1' });
    }

    {
      const ch = new WeComChannel({ botId: 'bot-1', botSecret: 'sec-1' });
      const { sent, fakeWs } = attachFakeWs(ch);
      (ch as any).chatMeta.set('group-1', { pendingReqId: 'orig-req' });

      await ch.send('group-1', 'reply 1');
      expect(sent[0].cmd).toBe('aibot_respond_msg');

      fakeWs.send.mockImplementationOnce((payload: string, cb: any) => {
        const frame = JSON.parse(payload);
        sent.push(frame);
        cb();
        const reqId = frame.headers.req_id;
        queueMicrotask(() => (ch as any).handleFrame({ headers: { req_id: reqId }, errcode: 0 }));
      });

      await ch.send('group-1', 'follow-up');
      const followup = sent[sent.length - 1];
      expect(followup.cmd).toBe('aibot_send_msg');
      expect(followup.body).toMatchObject({ chatid: 'group-1', msgtype: 'markdown' });
      expect(followup.body.markdown).toMatchObject({ content: 'follow-up' });
    }
  });
});
