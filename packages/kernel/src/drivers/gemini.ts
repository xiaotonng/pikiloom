import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult, DriverEvent, TuiInput, TuiSpec } from '../contracts/driver.js';
import type { UniversalUsage } from '../protocol/index.js';

// Native kernel Gemini driver: `gemini --output-format stream-json ... -p <prompt>` and
// parse its stream-json events into kernel DriverEvents. Faithful to pikiloom's geminiParse.
export class GeminiDriver implements AgentDriver {
  readonly id = 'gemini';
  readonly capabilities = { steer: false, interact: false, resume: true, tui: true };

  constructor(private readonly bin: string = 'gemini') {}

  run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    const args = ['--output-format', 'stream-json'];
    if (input.model) args.push('--model', input.model);
    if (input.sessionId) args.push('--resume', input.sessionId);
    const extra = input.extraArgs || [];
    if (!extra.some(a => a === '--approval-mode' || a === '--yolo' || a === '-y')) args.push('--approval-mode', 'yolo');
    if (extra.length) args.push(...extra);
    args.push('-p', input.prompt);

    const s = { text: '', sessionId: input.sessionId ?? null, model: input.model ?? null, input: null as number | null, output: null as number | null, cached: null as number | null, stopReason: null as string | null, error: null as string | null };
    const tools = new Map<string, { name: string; summary: string }>();

    return new Promise<DriverResult>((resolve) => {
      let child: ChildProcess;
      try { child = spawn(this.bin, args, { cwd: input.workdir, env: input.env ? { ...process.env, ...input.env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (err: any) { resolve({ ok: false, text: '', error: `spawn failed: ${err?.message || err}`, stopReason: 'error' }); return; }

      const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });

      let buf = ''; let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim(); if (!trimmed) continue;
          let ev: any; try { ev = JSON.parse(trimmed); } catch { continue; }
          parseGeminiEvent(ev, s, tools, ctx.emit);
        }
      });
      child.stderr!.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      child.on('error', (err) => resolve({ ok: false, text: s.text, error: `gemini spawn error: ${err.message}`, stopReason: 'error' }));
      child.on('close', (code) => {
        const usage: UniversalUsage = { inputTokens: s.input, outputTokens: s.output, cachedInputTokens: s.cached, contextPercent: null };
        if (ctx.signal.aborted) { resolve({ ok: false, text: s.text, error: 'Interrupted by user.', stopReason: 'interrupted', sessionId: s.sessionId, usage }); return; }
        const ok = !s.error && code === 0;
        resolve({ ok, text: s.text, error: s.error || (ok ? null : `gemini exited ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`), stopReason: s.stopReason, sessionId: s.sessionId, usage });
      });
    });
  }

  tui(input: TuiInput): TuiSpec {
    const args: string[] = [];
    if (input.model) args.push('--model', input.model);
    if (input.extraArgs?.length) args.push(...input.extraArgs);
    return { command: this.bin, args, cwd: input.workdir, env: input.env };
  }
}

export function parseGeminiEvent(ev: any, s: any, tools: Map<string, { name: string; summary: string }>, emit: (e: DriverEvent) => void): void {
  const t = ev.type || '';
  if (t === 'init') {
    if (ev.session_id && ev.session_id !== s.sessionId) { s.sessionId = ev.session_id; emit({ type: 'session', sessionId: ev.session_id }); }
    s.model = ev.model ?? s.model;
    return;
  }
  if (t === 'message' && ev.role === 'assistant') {
    if (ev.delta) { const d = ev.content || ''; if (d) { s.text += d; emit({ type: 'text', delta: d }); } }
    else if (!s.text.trim() && ev.content) { s.text = ev.content; emit({ type: 'text', delta: ev.content }); }
    return;
  }
  if (t === 'tool_use' || t === 'tool_call') {
    const id = String(ev.tool_id || ev.id || '').trim();
    const name = String(ev.tool_name || ev.name || ev.tool || 'Tool');
    if (id && !tools.has(id)) { tools.set(id, { name, summary: name }); emit({ type: 'tool', call: { id, name, summary: name, status: 'running' } }); }
    return;
  }
  if (t === 'tool_result') {
    const id = String(ev.tool_id || ev.id || '').trim();
    const tool = id ? tools.get(id) : undefined;
    if (tool) emit({ type: 'tool', call: { id, name: tool.name, summary: tool.summary, status: ev.is_error ? 'failed' : 'done' } });
    return;
  }
  if (t === 'error' && ev.severity === 'error') { s.error = String(ev.message || ev.error || 'Gemini error'); return; }
  if (t === 'result') {
    if (ev.session_id) s.sessionId = ev.session_id;
    if (ev.status === 'error' || ev.status === 'failure') s.error = String(ev.error || ev.message || `status ${ev.status}`);
    s.stopReason = ev.status === 'success' ? 'end_turn' : ev.status;
    const u = ev.stats;
    if (u) {
      s.input = u.input_tokens ?? u.input ?? s.input;
      s.output = u.output_tokens ?? u.output ?? s.output;
      s.cached = u.cached ?? s.cached;
      emit({ type: 'usage', usage: { inputTokens: s.input, outputTokens: s.output, cachedInputTokens: s.cached, contextPercent: null } });
    }
    return;
  }
}
