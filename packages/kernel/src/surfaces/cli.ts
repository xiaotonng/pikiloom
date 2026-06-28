import readline from 'node:readline';
import type { LoomIO, Surface } from '../contracts/surface.js';

// Simplest possible terminal: stdin lines -> prompts, snapshot text -> stdout.
// Demonstrates that IM/Web/CLI are all just Terminals over the same LoomIO.
export class CliSurface implements Surface {
  readonly id = 'cli';
  readonly capabilities = { editMessages: false, images: false, buttons: false };

  private rl?: readline.Interface;
  private unsub?: () => void;

  constructor(private readonly opts: { agent?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}) {}

  async start(io: LoomIO): Promise<void> {
    const out = this.opts.output || process.stdout;
    let sessionKey: string | undefined;          // conversation continuity across lines
    let pendingPromptId: string | null = null;   // a HITL question awaiting an answer from this terminal
    let lastQueued = 0;

    this.unsub = io.subscribe((key, snap) => {
      if (sessionKey && key !== sessionKey) return;          // single-conversation terminal
      const interaction = (snap.interactions || [])[0];
      if (interaction && interaction.promptId !== pendingPromptId && snap.phase !== 'done') {
        pendingPromptId = interaction.promptId;              // surface HITL; next line answers it
        const q = interaction.questions[interaction.currentIndex ?? 0] || interaction.questions[0];
        out.write(`\n[?] ${q?.text || interaction.title}\n> `);
        return;
      }
      const q = snap.queued?.length ?? 0;
      if (q !== lastQueued && snap.phase !== 'done') { lastQueued = q; if (q) out.write(`\n[queued: ${q}]\n> `); }
      if (snap.phase !== 'done') return;
      pendingPromptId = null; lastQueued = 0;
      out.write(`\n${snap.text || snap.error || '(no output)'}\n> `);
    });

    this.rl = readline.createInterface({ input: this.opts.input || process.stdin, output: out, prompt: '> ' });
    this.rl.prompt();
    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) { this.rl!.prompt(); return; }
      if (pendingPromptId) { const pid = pendingPromptId; pendingPromptId = null; io.interact(pid, 'text', text); return; }   // HITL answer
      if (text === '/models') {                              // discovery from the terminal (C2)
        void io.listModels(this.opts.agent || io.listAgents()[0] || '').then(ms => out.write(`\n${ms.map(m => m.id).join(', ') || '(no models)'}\n> `));
        return;
      }
      void io.prompt({ prompt: text, agent: this.opts.agent, sessionKey }).then(r => { sessionKey = r.sessionKey; });   // continue the conversation
    });
  }

  async stop(): Promise<void> {
    this.unsub?.();
    this.rl?.close();
  }
}
