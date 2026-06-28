import { createRequire } from 'node:module';
import type { TuiSpec } from '../contracts/driver.js';

const require = createRequire(import.meta.url);

let _pty: any | null | undefined;
function loadPty(): any | null {
  if (_pty === undefined) {
    try { _pty = require('node-pty'); } catch { _pty = null; }
  }
  return _pty;
}

export function ptyAvailable(): boolean { return !!loadPty(); }

export interface PtyOpenOpts { cols?: number; rows?: number }
export interface PtyExit { exitCode: number; signal?: number }

// A pseudo-terminal bridge around an agent's interactive process. Carries raw TUI bytes
// in both directions and fans `onData` out to many observers (full passthrough + tee/mirror).
// This is the capability the kernel previously lacked: transparently passing through
// Claude/Codex TUI traffic instead of only the structured -p stream.
export class PtyBridge {
  private readonly dataCbs = new Set<(d: string) => void>();
  private readonly exitCbs = new Set<(e: PtyExit) => void>();

  private constructor(private readonly proc: any) {
    proc.onData((d: string) => { for (const cb of this.dataCbs) { try { cb(d); } catch { /* isolate */ } } });
    proc.onExit((e: { exitCode: number; signal?: number }) => {
      for (const cb of this.exitCbs) { try { cb({ exitCode: e.exitCode, signal: e.signal }); } catch { /* isolate */ } }
    });
  }

  static open(spec: TuiSpec, opts: PtyOpenOpts = {}): PtyBridge {
    const pty = loadPty();
    if (!pty) throw new Error('node-pty is not available — install the optional dependency `node-pty` to use TUI passthrough.');
    const proc = pty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env || {}) },
    });
    return new PtyBridge(proc);
  }

  onData(cb: (d: string) => void): () => void { this.dataCbs.add(cb); return () => this.dataCbs.delete(cb); }
  onExit(cb: (e: PtyExit) => void): () => void { this.exitCbs.add(cb); return () => this.exitCbs.delete(cb); }
  write(data: string): void { try { this.proc.write(data); } catch { /* closed */ } }
  resize(cols: number, rows: number): void { try { this.proc.resize(Math.max(1, cols), Math.max(1, rows)); } catch { /* closed */ } }
  kill(signal?: string): void { try { this.proc.kill(signal); } catch { /* closed */ } }
  get pid(): number { return this.proc.pid; }
}
