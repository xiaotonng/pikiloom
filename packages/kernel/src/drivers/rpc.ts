import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

// One newline-delimited JSON-RPC client over a child process' stdio — the shared wire
// under both `codex app-server` and every ACP agent. Driver-internal (not exported by
// any barrel); the drivers own the protocol on top (initialize handshakes, methods).

export type RpcMsg = { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: any };

/** Throw from an onRequest handler to answer with a specific JSON-RPC error code. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export interface StdioRpcOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;   // merged over process.env
  cwd?: string;
  label?: string;                 // name used in error messages; defaults to command
}

const STDERR_TAIL_LINES = 20;

export class StdioRpcClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (m: RpcMsg) => void>();
  private notifyCb?: (method: string, params: any) => void;
  private requestCb?: (method: string, params: any, id: number | string) => any | Promise<any>;
  private closeCb?: () => void;
  private readonly stderrTail: string[] = [];
  private readonly label: string;

  constructor(private readonly opts: StdioRpcOptions) {
    this.label = opts.label || opts.command;
  }

  onNotification(cb: (method: string, params: any) => void): void { this.notifyCb = cb; }
  /** Serve peer->client requests. Throw RpcError for a coded error; anything else answers -32603. */
  onRequest(cb: (method: string, params: any, id: number | string) => any | Promise<any>): void { this.requestCb = cb; }
  /**
   * Fires once when the child process exits/closes. A driver awaiting a terminal *notification*
   * (not a pending request) MUST use this to settle its turn — otherwise a process that dies
   * without emitting its completion notification leaves the turn hanging forever.
   */
  onClose(cb: () => void): void { this.closeCb = cb; }
  /** Rolling tail of the process' stderr — startup/crash diagnostics. */
  stderrText(): string { return this.stderrTail.join('\n'); }

  start(): boolean {
    try {
      this.proc = spawn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
      });
    } catch { return false; }
    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
    // Always drain stderr (an unread pipe backpressures the child) and keep a tail for errors.
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      for (const ln of chunk.toString('utf8').split('\n')) {
        const t = ln.trim();
        if (!t) continue;
        this.stderrTail.push(t.slice(0, 240));
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });
    this.proc.on('close', () => {
      for (const cb of this.pending.values()) cb({ error: { message: `${this.label} exited` } });
      this.pending.clear();
      this.closeCb?.();
    });
    this.proc.on('error', () => { /* surfaced via start() false / request timeouts */ });
    return true;
  }

  private onLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let m: RpcMsg;
    try { m = JSON.parse(t); } catch { return; }            // non-JSON stdout noise
    if (m.method && m.id != null) { void this.handleRequest(m); return; }   // peer -> client request
    if (m.id != null) {                                      // response to one of our requests
      const cb = this.pending.get(m.id as number);
      if (cb) { this.pending.delete(m.id as number); cb(m); }
      return;
    }
    if (m.method) this.notifyCb?.(m.method, m.params ?? {});  // notification
  }

  private async handleRequest(m: RpcMsg): Promise<void> {
    const id = m.id!;
    if (!this.requestCb) { this.respondError(id, -32601, `Method not implemented: ${m.method}`); return; }
    try {
      const result = await this.requestCb(m.method!, m.params ?? {}, id);
      this.respond(id, result ?? null);
    } catch (e: any) {
      const code = e instanceof RpcError ? e.code : -32603;
      this.respondError(id, code, e?.message || 'handler error');
    }
  }

  request(method: string, params?: any, timeoutMs = 60_000): Promise<RpcMsg> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) { resolve({ error: { message: 'not connected' } }); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: `${this.label} '${method}' timed out` } }); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: any): void { this.write({ jsonrpc: '2.0', method, params }); }
  private respond(id: number | string, result: any): void { this.write({ jsonrpc: '2.0', id, result }); }
  private respondError(id: number | string, code: number, message: string): void { this.write({ jsonrpc: '2.0', id, error: { code, message } }); }
  private write(msg: unknown): void {
    if (!this.proc || this.proc.killed) return;
    try { this.proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch { /* stream closed */ }
  }
  kill(): void { try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ } this.proc = null; }
}
