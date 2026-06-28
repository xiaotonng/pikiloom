import type { TuiSpec } from '../contracts/driver.js';
import { PtyBridge, type PtyExit } from './pty.js';

export interface AttachTuiOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  observers?: Array<(chunk: string) => void>; // tee the raw TUI stream (e.g. mirror to web/record)
}

// Full terminal passthrough: spawn the agent's TUI in a PTY and wire the caller's
// stdin/stdout to it raw (so the user is "inside" the real Claude/Codex TUI), while
// optionally tee-ing every byte to observers. Resolves with the exit code.
export async function attachTui(spec: TuiSpec, opts: AttachTuiOptions = {}): Promise<PtyExit> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const bridge = PtyBridge.open(spec, { cols: stdout.columns, rows: stdout.rows });

  for (const obs of opts.observers ?? []) bridge.onData(obs);
  const offData = bridge.onData((d) => { stdout.write(d); });

  const wasRaw = !!(stdin as any).isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  const onInput = (chunk: Buffer | string) => bridge.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  stdin.on('data', onInput);
  const onResize = () => bridge.resize(stdout.columns || 80, stdout.rows || 24);
  stdout.on('resize', onResize);

  return await new Promise<PtyExit>((resolve) => {
    bridge.onExit((e) => {
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      offData();
      if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch { /* ignore */ } }
      stdin.pause();
      resolve(e);
    });
  });
}
