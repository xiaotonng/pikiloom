import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult, DriverEvent, TuiInput, TuiSpec, NativeSessionInfo } from '../contracts/driver.js';
import type { UniversalUsage } from '../protocol/index.js';
import { discoverAgyNativeSessions } from './native.js';
import { createLineBuffer, parseJsonLine, sigterm, wireAbort } from './shared.js';

export function isAgySessionOversized(sessionId: string | null | undefined, homeDir?: string): boolean {
  if (!sessionId || sessionId.startsWith('pending_')) return false;
  const home = homeDir || process.env.HOME || os.homedir();
  if (!home) return false;

  const convDb = path.join(home, '.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`);
  try {
    if (fs.existsSync(convDb)) {
      const stat = fs.statSync(convDb);
      if (stat.size > 3 * 1024 * 1024) return true;
    }
  } catch {}

  const transcript = path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    if (fs.existsSync(transcript)) {
      const stat = fs.statSync(transcript);
      if (stat.size > 1.5 * 1024 * 1024) return true;
    }
  } catch {}

  return false;
}

export function normalizeAgyModelId(model: unknown): string {
  const m = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!m || m === 'auto' || m === 'auto-gemini-3' || m === 'auto-gemini-2.5' || m === 'gemini-auto') {
    return 'gemini-3.8-flash-high';
  }
  if (m === 'pro' || m === 'gemini-pro' || m === 'gemini-2.5-pro' || m === 'gemini-3-pro-preview' || m === 'gemini-3.1-pro-preview') {
    return 'gemini-3.1-pro-high';
  }
  if (m === 'flash' || m === 'gemini-flash' || m === 'gemini-2.5-flash' || m === 'gemini-3-flash-preview') {
    return 'gemini-3.8-flash-high';
  }
  if (m === 'flash-lite' || m === 'gemini-2.5-flash-lite' || m === 'gemini-3.1-flash-lite-preview') {
    return 'gemini-3.6-flash-high';
  }
  return typeof model === 'string' ? model.trim() : '';
}

export function resolveAgyModelAndEffort(
  rawModel?: string | null,
  rawEffort?: string | null
): { model: string; effort: string | null } {
  let model = normalizeAgyModelId(rawModel || '');
  let effort = (rawEffort || '').trim().toLowerCase();

  // Claude models do not accept --effort in agy
  if (model.startsWith('claude-')) {
    return { model, effort: null };
  }

  // Extract embedded effort if present in the model name (e.g. gemini-3.8-flash-high, gpt-oss-120b-medium)
  const effortMatch = /-(low|medium|high)$/.exec(model);
  if (effortMatch) {
    const embeddedEffort = effortMatch[1];
    if (!effort) {
      effort = embeddedEffort;
    }
    const baseModel = model.replace(/-(low|medium|high)$/, '');
    if (baseModel.startsWith('gemini-') || baseModel.startsWith('gpt-')) {
      model = baseModel;
    }
  }

  // gemini-* models require an effort flag if passed as base model
  if (model.startsWith('gemini-')) {
    if (!effort || !['low', 'medium', 'high'].includes(effort)) {
      effort = 'high';
    }
    if (model.includes('3.1-pro') && effort === 'medium') {
      effort = 'high';
    }
  }

  // gpt-oss models require medium effort
  if (model.startsWith('gpt-')) {
    if (!effort || !['low', 'medium', 'high'].includes(effort)) {
      effort = 'medium';
    }
  }

  return { model, effort: effort || null };
}

// Native kernel Antigravity driver: `agy --output-format stream-json --dangerously-skip-permissions ... -p <prompt>`
// and parse its stream-json events into kernel DriverEvents.
export class AgyDriver implements AgentDriver {
  readonly id: string = 'agy';
  readonly capabilities = { steer: false, interact: false, resume: true, tui: true };

  constructor(private readonly bin: string = 'agy') {}

  run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    const args = ['--output-format', 'stream-json'];
    const extra = input.extraArgs || [];
    if (!extra.includes('--dangerously-skip-permissions')) {
      args.push('--dangerously-skip-permissions');
    }
    if (input.workdir) args.push('--add-dir', input.workdir);

    const { model, effort } = resolveAgyModelAndEffort(input.model, input.effort);
    if (model) args.push('--model', model);
    if (input.sessionId) args.push('--conversation', input.sessionId);
    if (effort) args.push('--effort', effort);
    if (extra.length) args.push(...extra);
    args.push('-p', input.prompt);

    const s = {
      text: '',
      sessionId: input.sessionId ?? null,
      input: null as number | null,
      output: null as number | null,
      cached: null as number | null,
      stopReason: null as string | null,
      error: null as string | null,
    };
    const tools = new Map<string, { name: string; summary: string }>();

    return new Promise<DriverResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.bin, args, {
          cwd: input.workdir,
          env: input.env ? { ...process.env, ...input.env } : process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        resolve({ ok: false, text: '', error: `spawn failed: ${err?.message || err}`, stopReason: 'error' });
        return;
      }

      wireAbort(ctx.signal, () => sigterm(child));

      const nextLines = createLineBuffer();
      let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        for (const line of nextLines(chunk)) {
          const ev = parseJsonLine(line);
          if (ev !== undefined) parseAgyEvent(ev, s, tools, ctx.emit);
        }
      });
      child.stderr!.on('data', (c: Buffer) => {
        const chunk = c.toString('utf8');
        stderr += chunk;
        if (/RESOURCE_EXHAUSTED/i.test(chunk) || /Individual quota reached/i.test(chunk)) {
          s.stopReason = 'quota_exhausted';
          s.error = chunk.trim().replace(/^error:\s*/i, '');
          sigterm(child);
        }
      });
      child.on('error', (err) => resolve({ ok: false, text: s.text, error: `agy spawn error: ${err.message}`, stopReason: 'error' }));
      child.on('close', (code) => {
        const usage: UniversalUsage = { inputTokens: s.input, outputTokens: s.output, cachedInputTokens: s.cached, contextPercent: null };
        if (ctx.signal.aborted) {
          resolve({ ok: false, text: s.text, error: 'Interrupted by user.', stopReason: 'interrupted', sessionId: s.sessionId, usage });
          return;
        }
        const ok = !s.error && code === 0;
        resolve({
          ok,
          text: s.text,
          error: s.error || (ok ? null : `agy exited ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`),
          stopReason: s.stopReason,
          sessionId: s.sessionId,
          usage,
        });
      });
    });
  }

  tui(input: TuiInput): TuiSpec {
    const args: string[] = [];
    if (input.workdir) args.push('--add-dir', input.workdir);
    if (input.model) args.push('--model', input.model);
    if (input.extraArgs?.length) args.push(...input.extraArgs);
    return { command: this.bin, args, cwd: input.workdir, env: input.env };
  }

  listNativeSessions(opts: { workdir: string; limit?: number }): NativeSessionInfo[] {
    return discoverAgyNativeSessions(opts.workdir, { limit: opts.limit });
  }
}

export function parseAgyEvent(
  ev: any,
  s: any,
  tools: Map<string, { name: string; summary: string }>,
  emit: (e: DriverEvent) => void,
): void {
  // Support both new `agy` event structure and legacy structure
  const eventType = ev.event || ev.type || '';

  // 1. Init event
  if (eventType === 'init') {
    const sessId = ev.conversation_id || ev.session_id;
    if (sessId && sessId !== s.sessionId) {
      s.sessionId = sessId;
      emit({ type: 'session', sessionId: sessId });
    }
    return;
  }

  // 2. Step update (agy native stream event)
  if (eventType === 'step_update' && ev.step_update) {
    const step = ev.step_update;
    if (step.conversation_id && step.conversation_id !== s.sessionId) {
      s.sessionId = step.conversation_id;
      emit({ type: 'session', sessionId: step.conversation_id });
    }

    if (step.step_type === 'agent_response') {
      if (step.text_delta) {
        s.text += step.text_delta;
        emit({ type: 'text', delta: step.text_delta });
      }
      if (step.usage) {
        s.input = step.usage.input_tokens ?? s.input;
        s.output = step.usage.output_tokens ?? s.output;
        s.cached = step.usage.cache_read_tokens ?? s.cached;
        emit({
          type: 'usage',
          usage: { inputTokens: s.input, outputTokens: s.output, cachedInputTokens: s.cached, contextPercent: null },
        });
      }
      return;
    }

    if (step.step_type === 'tool') {
      const id = String(step.step_index ?? tools.size + 1);
      const name = String(step.tool_name || step.tool_info?.name || 'Tool');
      if (step.state === 'ACTIVE') {
        if (!tools.has(id)) {
          tools.set(id, { name, summary: name });
          emit({ type: 'tool', call: { id, name, summary: name, status: 'running' } });
        }
      } else if (step.state === 'DONE') {
        const tool = tools.get(id);
        const status = step.tool_info?.output?.startsWith('Error:') ? 'failed' : 'done';
        emit({ type: 'tool', call: { id, name: tool?.name || name, summary: tool?.summary || name, status } });
      }
      return;
    }

    return;
  }

  // Legacy gemini format support in same parser
  if (eventType === 'message' && ev.role === 'assistant') {
    if (ev.delta) {
      const d = ev.content || '';
      if (d) { s.text += d; emit({ type: 'text', delta: d }); }
    } else if (!s.text.trim() && ev.content) {
      s.text = ev.content; emit({ type: 'text', delta: ev.content });
    }
    return;
  }

  if (eventType === 'tool_use' || eventType === 'tool_call') {
    const id = String(ev.tool_id || ev.id || '').trim();
    const name = String(ev.tool_name || ev.name || ev.tool || 'Tool');
    if (id && !tools.has(id)) {
      tools.set(id, { name, summary: name });
      emit({ type: 'tool', call: { id, name, summary: name, status: 'running' } });
    }
    return;
  }

  if (eventType === 'tool_result') {
    const id = String(ev.tool_id || ev.id || '').trim();
    const tool = id ? tools.get(id) : undefined;
    if (tool) {
      emit({ type: 'tool', call: { id, name: tool.name, summary: tool.summary, status: ev.is_error ? 'failed' : 'done' } });
    }
    return;
  }

  if (eventType === 'error' && ev.severity === 'error') {
    s.error = String(ev.message || ev.error || 'Antigravity error');
    return;
  }

  // 3. Result event
  if (eventType === 'result') {
    const res = ev.result || ev;
    const sessId = res.conversation_id || res.session_id;
    if (sessId) s.sessionId = sessId;

    if (res.status === 'ERROR' || res.status === 'error' || res.status === 'failure') {
      let errStr = String(res.error || res.message || `status ${res.status}`);
      if (/RESOURCE_EXHAUSTED/i.test(errStr) || /Individual quota reached/i.test(errStr)) {
        s.stopReason = 'quota_exhausted';
        if (!errStr.includes('New Session') && !errStr.includes('/new')) {
          errStr = `${errStr}\n\nTip: This conversation has grown too large for the model context (~9.4M tokens). Please start a fresh session (click "+ New Session" in the dashboard, or send /new in Telegram).`;
        }
      } else {
        s.stopReason = 'error';
      }
      s.error = errStr;
    } else {
      s.stopReason = res.status === 'SUCCESS' || res.status === 'success' ? 'end_turn' : res.status;
    }

    if (!s.text && res.response) {
      s.text = res.response;
      emit({ type: 'text', delta: res.response });
    }

    const u = res.usage || res.stats;
    if (u) {
      s.input = u.input_tokens ?? u.input ?? s.input;
      s.output = u.output_tokens ?? u.output ?? s.output;
      s.cached = u.cache_read_tokens ?? u.cached ?? s.cached;
      emit({
        type: 'usage',
        usage: { inputTokens: s.input, outputTokens: s.output, cachedInputTokens: s.cached, contextPercent: null },
      });
    }
    return;
  }
}
