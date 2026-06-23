import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { agentLog, agentWarn } from './utils.js';

export interface AcpClientOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type IncomingMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
};

export function toAcpMcpServers(servers: Record<string, any> | undefined): any[] {
  if (!servers) return [];
  const out: any[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const type = String(cfg.type || '').toLowerCase();
    if ((type === 'http' || type === 'sse') && cfg.url) {
      const headers = Object.entries(cfg.headers || {}).map(([n, v]) => ({ name: n, value: String(v) }));
      out.push({ type, name, url: String(cfg.url), headers });
      continue;
    }
    if (cfg.command) {
      const env = Object.entries(cfg.env || {}).map(([n, v]) => ({ name: n, value: String(v) }));
      out.push({
        name,
        command: String(cfg.command),
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env,
      });
    }
  }
  return out;
}

export class AcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private exited = false;

  constructor(private opts: AcpClientOptions) {
    super();
  }

  start(): void {
    if (this.proc) return;
    agentLog(`[acp] spawn: ${this.opts.command} ${this.opts.args.join(' ')}`);
    this.proc = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', line => this.handleLine(line));

    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const ln of text.split('\n')) {
        const t = ln.trim();
        if (t) agentLog(`[acp:stderr] ${t.slice(0, 240)}`);
      }
    });

    this.proc.on('error', err => {
      agentWarn(`[acp] spawn error: ${err.message}`);
      this.failPending(err);
    });

    this.proc.on('close', code => {
      agentLog(`[acp] exit code=${code}`);
      this.exited = true;
      this.emit('exit', code);
      this.failPending(new Error(`ACP process exited with code ${code}`));
    });
  }

  isAlive(): boolean {
    return !!this.proc && !this.exited;
  }

  async request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (!this.proc || this.exited) throw new Error('ACP process not running');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async tryRequest(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    try {
      return await this.request(method, params, timeoutMs);
    } catch (e: any) {
      agentLog(`[acp] tryRequest(${method}) skipped: ${e?.message || e}`);
      return null;
    }
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc || this.exited) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async waitForQuiet(quietMs = 150, maxMs = 3_000): Promise<number> {
    let events = 0;
    let lastEventAt = Date.now();
    const onUpdate = () => { events++; lastEventAt = Date.now(); };
    this.on('sessionUpdate', onUpdate);
    try {
      const startedAt = Date.now();
      while (Date.now() - startedAt < maxMs) {
        const idle = Date.now() - lastEventAt;
        if (idle >= quietMs) break;
        await new Promise(r => setTimeout(r, Math.min(50, quietMs - idle + 1)));
      }
      return events;
    } finally {
      this.off('sessionUpdate', onUpdate);
    }
  }

  async close(): Promise<void> {
    if (!this.proc || this.exited) return;
    try { this.proc.stdin.end(); } catch {}
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { this.proc?.kill('SIGTERM'); } catch {}
        resolve();
      }, 1500);
      this.proc?.on('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  private write(msg: unknown): void {
    if (!this.proc || this.exited) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch (e: any) {
      agentWarn(`[acp] write failed: ${e?.message || e}`);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(trimmed) as IncomingMessage;
    } catch {
      agentLog(`[acp:stdout-noise] ${trimmed.slice(0, 200)}`);
      return;
    }

    if ('id' in msg && (('result' in msg) || ('error' in msg))) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pending.get(resp.id);
      if (!pending) return;
      this.pending.delete(resp.id);
      if (resp.error) pending.reject(new Error(`ACP error ${resp.error.code} on ${pending.method}: ${resp.error.message}`));
      else pending.resolve(resp.result);
      return;
    }

    if (!('id' in msg) && 'method' in msg) {
      const n = msg as JsonRpcNotification;
      if (n.method === 'session/update') {
        this.emit('sessionUpdate', n.params);
      } else {
        this.emit('notification', n);
      }
      return;
    }

    if ('id' in msg && 'method' in msg) {
      const r = msg as JsonRpcRequest;
      this.emit('request', { id: r.id, method: r.method, params: r.params });
      return;
    }
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
