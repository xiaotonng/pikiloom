import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import { FeishuSurface, type FeishuTransport, type InboundFeishuMessage } from '../examples/feishu-terminal.js';

// Fake Lark transport: records create/patch calls, lets the test inject inbound events.
class FakeFeishuTransport implements FeishuTransport {
  sent: Array<{ chatId: string; id: string; text: string }> = [];
  edits: Array<{ id: string; text: string }> = [];
  private cb?: (m: InboundFeishuMessage) => void;
  onMessage(cb: (m: InboundFeishuMessage) => void): void { this.cb = cb; }
  async send(chatId: string, text: string): Promise<string> { const id = `m${this.sent.length + 1}`; this.sent.push({ chatId, id, text }); return id; }
  async edit(id: string, text: string): Promise<void> { this.edits.push({ id, text }); }
  inbound(chatId: string, text: string): void { this.cb?.({ chatId, text, messageId: `in-${Date.now()}` }); }
  rendered(): string[] { return [...this.sent.map(s => s.text), ...this.edits.map(e => e.text)]; }
}

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await new Promise(r => setTimeout(r, 5)); }
};

describe('FeishuSurface (IM as a Surface over LoomIO, hermetic)', () => {
  let tmp: string;
  let loom: Loom;
  let fake: FakeFeishuTransport;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-feishu-'));
    fake = new FakeFeishuTransport();
    loom = createLoom({
      drivers: [new EchoDriver()], defaultAgent: 'echo',
      sessionStore: new FsSessionStore(tmp),
      surfaces: [new FeishuSurface(fake, { agent: 'echo' })],
    });
    await loom.start();
  });
  afterEach(async () => { await loom.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('routes an inbound Feishu message through the kernel and streams the reply back', async () => {
    fake.inbound('chatA', 'hello feishu');
    // a message was created in the chat, then edited as the kernel streamed the agent reply.
    // Wait for the DONE render (carries the 'tok' usage footer) — the streaming frame has the
    // full text but no usage yet, so waiting on text alone races the done frame.
    await waitFor(() => fake.rendered().some(t => t.includes('Echo: hello feishu') && t.includes('tok')));
    expect(fake.sent.length).toBeGreaterThanOrEqual(1);
    expect(fake.sent[0].chatId).toBe('chatA');
    expect(fake.edits.length).toBeGreaterThanOrEqual(1);                 // edited in place (streaming)
    const final = fake.rendered().reverse().find(t => t.includes('Echo:'))!;
    expect(final).toContain('Echo: hello feishu');
    expect(final).toContain('tok');                                       // usage footer on done
  });

  it('resumes the same kernel session for follow-up messages in the same chat', async () => {
    fake.inbound('chatB', 'first');
    await waitFor(() => fake.rendered().some(t => t.includes('Echo: first')));
    const afterFirst = fake.sent.length;
    fake.inbound('chatB', 'second');
    await waitFor(() => fake.rendered().some(t => t.includes('Echo: second')));
    // a NEW message for the new turn (msgId reset on done), but same underlying session
    expect(fake.sent.length).toBe(afterFirst + 1);
    const keys = loom.io.listSessions().map(s => s.sessionKey);
    expect(new Set(keys).size).toBe(1); // one session reused across both turns in chatB
  });
});
