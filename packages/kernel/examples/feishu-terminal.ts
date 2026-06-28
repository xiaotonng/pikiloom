// Reference IM terminal: Feishu (Lark) as a `Surface` over `LoomIO`.
//
// Proves the upper-seam claim "IM is just a Surface": inbound Feishu text -> io.prompt,
// kernel snapshot stream -> create/edit a Feishu message (streaming, edit-in-place).
//
// The adapter is PURE — it depends on an injected `FeishuTransport`, so the pipeline is
// hermetically testable (fake transport) and the kernel package carries no Lark dep.
// The real transport (im.v1.message.create / .patch + EventDispatcher) is a thin wrapper;
// see feishu-lark-transport.ts.
import type { LoomIO, Surface } from '../src/index.js';
import type { UniversalSnapshot } from '../src/index.js';

export interface InboundFeishuMessage { chatId: string; text: string; messageId: string }

export interface FeishuTransport {
  connect?(): Promise<void>;
  onMessage(cb: (m: InboundFeishuMessage) => void): void;
  send(chatId: string, text: string): Promise<string>;   // returns feishu message id
  edit(messageId: string, text: string): Promise<void>;   // patch-in-place
  disconnect?(): void;
}

interface ChatBinding { chatId: string; msgId: string | null; lastText: string; latest: UniversalSnapshot | null; busy: boolean }

export class FeishuSurface implements Surface {
  readonly id = 'feishu';
  readonly capabilities = { editMessages: true, images: false, buttons: true };

  private io?: LoomIO;
  private unsub?: () => void;
  private readonly bySession = new Map<string, ChatBinding>();

  constructor(private readonly transport: FeishuTransport, private readonly opts: { agent?: string } = {}) {}

  async start(io: LoomIO): Promise<void> {
    this.io = io;
    this.unsub = io.subscribe((key, snap) => { void this.onSnapshot(key, snap); });
    if (this.transport.connect) await this.transport.connect();
    this.transport.onMessage(async (m) => {
      const resume = this.sessionForChat(m.chatId);
      const { sessionKey } = await io.prompt({ prompt: m.text, agent: this.opts.agent, sessionKey: resume });
      if (!this.bySession.has(sessionKey)) this.bySession.set(sessionKey, { chatId: m.chatId, msgId: null, lastText: '', latest: null, busy: false });
    });
  }

  async stop(): Promise<void> {
    this.unsub?.();
    this.transport.disconnect?.();
  }

  private sessionForChat(chatId: string): string | undefined {
    for (const [key, b] of this.bySession) if (b.chatId === chatId) return key;
    return undefined;
  }

  private async onSnapshot(sessionKey: string, snap: UniversalSnapshot): Promise<void> {
    const b = this.bySession.get(sessionKey);
    if (!b) return;
    b.latest = snap;
    if (b.busy) return;                 // an op is in flight — it will pick up b.latest (coalesced)
    b.busy = true;
    try {
      while (b.latest) {
        const s = b.latest; b.latest = null;
        const text = renderFeishu(s);
        if (text === b.lastText) continue;
        b.lastText = text;
        if (!b.msgId) b.msgId = await this.transport.send(b.chatId, text);  // exactly one create
        else await this.transport.edit(b.msgId, text);                      // edit-in-place
        if (s.phase === 'done') b.msgId = null; // next turn in this chat starts a fresh message
      }
    } finally {
      b.busy = false;
    }
  }
}

export function renderFeishu(snap: UniversalSnapshot): string {
  const body = snap.text || (snap.phase === 'streaming' ? '…' : '');
  const err = snap.error ? `\n⚠️ ${snap.error}` : '';
  const foot = snap.phase === 'done' && snap.usage?.outputTokens != null ? `\n— ${snap.usage.outputTokens} tok` : '';
  const tail = snap.phase === 'streaming' ? ' ⏳' : '';
  return `${body}${err}${foot}${tail}`;
}
