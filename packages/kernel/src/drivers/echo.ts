import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult } from '../contracts/driver.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Deterministic, dependency-free driver used for hermetic E2E. Its behavior is keyed
// off prompt prefixes so tests can exercise every event + control verb without timing
// races:
//   "ASK: <q>"  -> emits an interaction, awaits the answer, echoes it
//   "HOLD ..."  -> registers steer + blocks until steered OR stopped, then echoes
//   anything    -> reasoning + tool(running/done) + streamed text echo + usage
const ECHO_TUI = `process.stdout.write('ECHO-TUI-READY\\n');process.stdin.on('data',d=>{const s=d.toString();if(s.includes('Q')){process.stdout.write('BYE\\n');setTimeout(()=>process.exit(0),10);return;}process.stdout.write('GOT:'+s);});`;

export class EchoDriver implements AgentDriver {
  readonly id = 'echo';
  readonly capabilities = { steer: true, interact: true, resume: true, tui: true };

  // A hermetic raw-PTY "TUI": prints a banner, echoes input, exits on 'Q'. Lets the
  // Lane R passthrough path be exercised without a real agent.
  tui(input: { workdir: string; env?: Record<string, string> }): { command: string; args: string[]; cwd: string; env?: Record<string, string> } {
    return { command: process.execPath, args: ['-e', ECHO_TUI], cwd: input.workdir, env: input.env };
  }

  async run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    const prompt = input.prompt;
    ctx.emit({ type: 'reasoning', delta: `Considering: ${prompt}` });

    if (prompt.startsWith('ASK:')) {
      const q = prompt.slice(4).trim() || 'Your input?';
      const answers = await ctx.askUser({
        promptId: 'echo-ask', kind: 'user-input', title: 'Echo asks',
        questions: [{ id: 'a', text: q, allowFreeform: true }],
      });
      const a = answers['a']?.[0] ?? '(none)';
      const text = `You said: ${a}`;
      ctx.emit({ type: 'text', delta: text });
      return { ok: true, text, reasoning: `Considering: ${prompt}`, stopReason: 'end_turn' };
    }

    let steered: string | null = null;
    if (prompt.startsWith('HOLD')) {
      ctx.emit({ type: 'activity', line: 'holding for steer' });
      await new Promise<void>((resolve) => {
        ctx.registerSteer(async (p) => { steered = p; resolve(); return true; });
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (ctx.signal.aborted) {
        return { ok: false, text: '', error: 'Interrupted by user.', stopReason: 'interrupted' };
      }
    }

    ctx.emit({ type: 'tool', call: { id: 't1', name: 'echo_tool', summary: 'echo the prompt', status: 'running' } });
    const base = `Echo: ${prompt}` + (steered ? ` | steered: ${steered}` : '');
    let acc = '';
    for (const tok of base.split(/(\s+)/)) {
      if (ctx.signal.aborted) return { ok: false, text: acc, error: 'Interrupted by user.', stopReason: 'interrupted' };
      acc += tok;
      if (tok) ctx.emit({ type: 'text', delta: tok });
      await sleep(2);
    }
    ctx.emit({ type: 'tool', call: { id: 't1', name: 'echo_tool', summary: 'echo the prompt', status: 'done', result: 'ok' } });
    const usage = { inputTokens: prompt.length, outputTokens: base.length, cachedInputTokens: 0, contextPercent: null };
    ctx.emit({ type: 'usage', usage });
    return { ok: true, text: acc, reasoning: `Considering: ${prompt}`, usage, stopReason: 'end_turn' };
  }
}
