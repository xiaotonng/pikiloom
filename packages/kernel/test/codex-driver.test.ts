import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodexDriver, captureCodexReasoning, captureCodexAgentMessage, codexReasoningItemText,
  codexFinalText, codexFinalReasoning, codexToolCall, codexToolSummary, type CodexContentState,
} from '../src/drivers/codex.js';
import type { DriverContext, DriverEvent } from '../src/contracts/driver.js';

// A fake `codex app-server` speaking the newline-JSON-RPC the driver expects, so the
// codex port is verified end-to-end without the real codex binary / network.
const FAKE_APP_SERVER = `#!/usr/bin/env node
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method, params }) + '\\n');
const TID = 'codex-thread-xyz';
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'thread/start') reply(m.id, { thread: { id: TID } });
    else if (m.method === 'turn/start') {
      reply(m.id, {});
      notify('turn/started', { threadId: TID, turn: { id: 'turn-1' } });
      notify('item/started', { threadId: TID, item: { type: 'agentMessage', id: 'msg1', phase: 'final_answer' } });
      notify('item/reasoning/textDelta', { threadId: TID, delta: 'thinking...' });
      notify('item/agentMessage/delta', { threadId: TID, itemId: 'msg1', delta: 'CODEX-' });
      notify('item/agentMessage/delta', { threadId: TID, itemId: 'msg1', delta: 'KERNEL-OK' });
      notify('item/started', { threadId: TID, item: { type: 'commandExecution', id: 'cmd1', command: 'ls -la', cwd: '/tmp/work' } });
      notify('item/commandExecution/outputDelta', { threadId: TID, itemId: 'cmd1', delta: 'live output\\n' });
      // Some app-server versions omit aggregatedOutput after streaming outputDelta. The driver
      // must preserve the accumulated live result instead of replacing it with an empty value.
      notify('item/completed', { threadId: TID, item: { type: 'commandExecution', id: 'cmd1', status: 'completed', aggregatedOutput: null, exitCode: 0 } });
      notify('item/completed', { threadId: TID, item: { type: 'webSearch', id: 'ws1', status: 'completed', query: 'pikiloom rename' } });
      notify('turn/plan/updated', { threadId: TID, plan: { steps: [{ step: 'do the thing', status: 'in_progress' }] } });
      notify('thread/tokenUsage/updated', { threadId: TID, tokenUsage: { input_tokens: 42, output_tokens: 7 } });
      notify('turn/completed', { threadId: TID, turn: { id: 'turn-1', status: 'completed' } });
    }
  }
});
`;

function ctxCollect(): { ctx: DriverContext; events: DriverEvent[] } {
  const events: DriverEvent[] = [];
  const ctx: DriverContext = {
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    askUser: async () => ({}),
    registerSteer: () => {},
  };
  return { ctx, events };
}

describe('CodexDriver native (app-server JSON-RPC, hermetic via fake server)', () => {
  let tmp: string; let fake: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-codex-'));
    fake = path.join(tmp, 'fake-codex.mjs');
    fs.writeFileSync(fake, FAKE_APP_SERVER);
    fs.chmodSync(fake, 0o755);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('drives a turn: session id, text, reasoning, tool, plan, usage, completion', async () => {
    const { ctx, events } = ctxCollect();
    const driver = new CodexDriver(fake);
    const result = await driver.run({ prompt: 'hello codex', workdir: tmp, effort: 'high' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.text).toBe('CODEX-KERNEL-OK');
    expect(result.sessionId).toBe('codex-thread-xyz');
    expect(result.usage).toMatchObject({ inputTokens: 42, outputTokens: 7 });

    expect(events.find(e => e.type === 'session')).toMatchObject({ sessionId: 'codex-thread-xyz' });
    expect(events.filter(e => e.type === 'text').map(e => (e as any).delta).join('')).toBe('CODEX-KERNEL-OK');
    expect(events.filter(e => e.type === 'reasoning').map(e => (e as any).delta).join('')).toBe('thinking...');
    const toolStatuses = events.filter(e => e.type === 'tool').map(e => (e as any).call.status);
    expect(toolStatuses).toContain('running');
    expect(toolStatuses).toContain('done');
    const commandCalls = events.filter(e => e.type === 'tool').map(e => (e as any).call).filter(c => c.id === 'cmd1');
    expect(commandCalls[0]).toMatchObject({
      name: 'shell',
      summary: 'Run shell: ls -la',
      status: 'running',
    });
    expect(commandCalls[0].input).toContain('"command": "ls -la"');
    expect(commandCalls[0].input).toContain('"cwd": "/tmp/work"');
    expect(commandCalls.some(c => c.status === 'running' && c.result === 'live output\n')).toBe(true);
    expect(commandCalls.at(-1)).toMatchObject({ status: 'done', result: 'live output\n' });
    // webSearch arrives as a completed-only item (no item/started, query only at completion) —
    // it must still surface as an Activity tool row with its query.
    const ws = events.filter(e => e.type === 'tool').map(e => (e as any).call).find(c => c.id === 'ws1');
    expect(ws).toMatchObject({ name: 'web_search', summary: 'Search web: pikiloom rename', status: 'done' });
    const plan = events.find(e => e.type === 'plan') as any;
    expect(plan.plan.steps).toEqual([{ text: 'do the thing', status: 'inProgress' }]);
  }, 20_000);

  it('exposes a TUI spec', () => {
    const spec = new CodexDriver().tui({ workdir: '/tmp/x', model: 'gpt-5.5' });
    expect(spec.command).toBe('codex');
    expect(spec.args).toContain('-m');
    expect(spec.args).toContain('gpt-5.5');
  });
});

// Regression: codex (notably Chat→Responses bridged third-party models) can deliver the final
// answer and reasoning as *completed items* with NO preceding deltas. The kernel must still
// surface them — parity with the legacy driver's s.msgs / s.thinkParts + end-of-turn fallback.
const FAKE_COMPLETED_ONLY_SERVER = `#!/usr/bin/env node
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method, params }) + '\\n');
const TID = 'codex-thread-completed';
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'thread/start') reply(m.id, { thread: { id: TID } });
    else if (m.method === 'turn/start') {
      reply(m.id, {});
      notify('turn/started', { threadId: TID, turn: { id: 'turn-1' } });
      // No agentMessage/reasoning deltas — only completed items.
      notify('rawResponseItem/completed', { threadId: TID, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONED-VIA-RAW' }] } });
      notify('item/completed', { threadId: TID, item: { type: 'agentMessage', id: 'msg1', phase: 'final_answer', text: 'FINAL-VIA-COMPLETED' } });
      notify('turn/completed', { threadId: TID, turn: { id: 'turn-1', status: 'completed' } });
    }
  }
});
`;

describe('CodexDriver completed-item fallback (no deltas)', () => {
  let tmp: string; let fake: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-codex-done-'));
    fake = path.join(tmp, 'fake-codex.mjs');
    fs.writeFileSync(fake, FAKE_COMPLETED_ONLY_SERVER);
    fs.chmodSync(fake, 0o755);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('captures text + reasoning from completed items and streams them live', async () => {
    const { ctx, events } = ctxCollect();
    const result = await new CodexDriver(fake).run({ prompt: 'hi', workdir: tmp }, ctx);

    expect(result.ok).toBe(true);
    expect(result.text).toBe('FINAL-VIA-COMPLETED');
    expect(result.reasoning).toBe('REASONED-VIA-RAW');
    // Streamed live (not just present in the terminal result) so the snapshot fills mid-turn.
    expect(events.filter(e => e.type === 'text').map(e => (e as any).delta).join('')).toBe('FINAL-VIA-COMPLETED');
    expect(events.filter(e => e.type === 'reasoning').map(e => (e as any).delta).join('')).toBe('REASONED-VIA-RAW');
  }, 20_000);
});

describe('codexToolSummary (content items must NOT become Activity tools)', () => {
  it('returns null for agentMessage and reasoning — they are content, rendered below', () => {
    expect(codexToolSummary({ id: 'm1', type: 'agentMessage', phase: 'final_answer', text: 'the answer' })).toBeNull();
    expect(codexToolSummary({ id: 'r1', type: 'reasoning', summary: ['thinking'] })).toBeNull();
  });
  it('summarizes real tool calls (shell / edit / mcp+dynamic+collab)', () => {
    expect(codexToolSummary({ id: 'c1', type: 'commandExecution', command: 'ls -la' })).toMatchObject({ name: 'shell' });
    expect(codexToolSummary({ id: 'f1', type: 'fileChange', changes: [{ path: 'a/b.ts' }] })).toMatchObject({ name: 'edit' });
    expect(codexToolSummary({ id: 't1', type: 'mcpToolCall', tool: 'sim.run_case' })).toMatchObject({ name: 'run_case' });
    expect(codexToolSummary({ id: 'd1', type: 'dynamicToolCall', name: 'web.search' })).toMatchObject({ name: 'search' });
  });
  it('summarizes webSearch items — the query lives at top level or under action', () => {
    expect(codexToolSummary({ id: 'w1', type: 'webSearch', query: 'pikiloom naming' }))
      .toMatchObject({ name: 'web_search', summary: 'Search web: pikiloom naming' });
    expect(codexToolSummary({ id: 'w2', type: 'webSearch' })).toMatchObject({ summary: 'Search web' });
    expect(codexToolSummary({ id: 'w3', type: 'webSearch', action: { type: 'openPage', url: 'https://example.com' } }))
      .toMatchObject({ summary: 'Open https://example.com' });
    expect(codexToolSummary({ id: 'w4', type: 'webSearch', action: { type: 'search', query: 'q2' } }))
      .toMatchObject({ summary: 'Search web: q2' });
  });
  it('ignores unknown/content item types and id-less items', () => {
    expect(codexToolSummary({ id: 'x1', type: 'tokenCount' })).toBeNull();
    expect(codexToolSummary({ type: 'mcpToolCall', tool: 'x' })).toBeNull(); // no id
  });
});

describe('codexToolCall live detail projection', () => {
  it('projects shell input/output and marks non-zero commands failed', () => {
    const call = codexToolCall({
      id: 'c1', type: 'commandExecution', command: 'npm test', cwd: '/repo',
      status: 'failed', aggregatedOutput: '1 test failed', exitCode: 1,
    }, 'done');
    expect(call).toMatchObject({ name: 'shell', status: 'failed' });
    expect(call?.input).toContain('"command": "npm test"');
    expect(call?.input).toContain('"cwd": "/repo"');
    expect(call?.result).toBe('1 test failed\n\n(exit code 1)');
  });

  it('projects file diffs plus MCP/dynamic tool arguments and results', () => {
    const patch = codexToolCall({
      id: 'p1', type: 'fileChange', status: 'completed',
      changes: [{ path: '/repo/a.ts', kind: 'update', diff: '@@ -1 +1 @@' }],
    }, 'running');
    expect(patch).toMatchObject({ name: 'edit', status: 'done' });
    expect(patch?.input).toContain('@@ -1 +1 @@');

    const mcp = codexToolCall({
      id: 'm1', type: 'mcpToolCall', tool: 'browser.open', status: 'completed',
      arguments: { url: 'https://example.com' }, result: { content: [{ type: 'text', text: 'ok' }] },
    }, 'running');
    expect(mcp).toMatchObject({ name: 'open', status: 'done' });
    expect(mcp?.input).toContain('https://example.com');
    expect(mcp?.result).toContain('"text": "ok"');

    const dynamic = codexToolCall({
      id: 'd1', type: 'dynamicToolCall', tool: 'image.inspect', status: 'failed',
      arguments: { path: '/tmp/a.png' }, contentItems: [{ type: 'inputText', text: 'bad image' }], success: false,
    }, 'running');
    expect(dynamic).toMatchObject({ name: 'inspect', status: 'failed' });
    expect(dynamic?.input).toContain('/tmp/a.png');
    expect(dynamic?.result).toContain('bad image');
  });
});

describe('codex completed-item helpers (pure)', () => {
  const fresh = (): CodexContentState => ({ text: '', reasoning: '', streamedReasoning: false, msgs: [], thinkParts: [] });

  it('extracts reasoning text from string and {text}-object arrays', () => {
    expect(codexReasoningItemText({ summary: ['a', 'b'] })).toBe('a\nb');
    expect(codexReasoningItemText({ summary: [{ text: 'x' }], content: [{ text: 'y' }] })).toBe('x\ny');
    expect(codexReasoningItemText({ summary: [] })).toBe('');
  });

  it('does NOT re-emit completed reasoning when deltas already streamed (dedup)', () => {
    const emits: DriverEvent[] = [];
    const s = fresh(); s.reasoning = 'streamed'; s.streamedReasoning = true;
    captureCodexReasoning('completed dup', s, (e) => emits.push(e));
    expect(emits).toHaveLength(0);                 // not streamed again
    expect(s.thinkParts).toEqual(['completed dup']); // but kept as fallback material
    expect(s.reasoning).toBe('streamed');
  });

  it('does NOT re-emit a completed agentMessage already streamed via delta', () => {
    const emits: DriverEvent[] = [];
    const s = fresh(); s.text = 'streamed';
    const deltaItems = new Set<string>(['msg1']);
    captureCodexAgentMessage({ id: 'msg1', phase: 'final_answer', text: 'streamed' }, s, deltaItems, new Map(), (e) => emits.push(e));
    expect(emits).toHaveLength(0);
    expect(s.text).toBe('streamed');
  });

  it('captures a commentary (non-final-answer) agentMessage — the preamble 中间过程, not just final_answer', () => {
    const emits: DriverEvent[] = [];
    const s = fresh();
    captureCodexAgentMessage({ id: 'c1', phase: 'commentary', text: 'Let me list the files first.' }, s, new Set(), new Map(), (e) => emits.push(e));
    expect(emits).toEqual([{ type: 'text', delta: 'Let me list the files first.' }]);
    expect(s.text).toBe('Let me list the files first.');
    // A subsequent final answer is separated by a blank line.
    captureCodexAgentMessage({ id: 'm1', phase: 'final_answer', text: 'Here are the files.' }, s, new Set(), new Map(), (e) => emits.push(e));
    expect(s.text).toBe('Let me list the files first.\n\nHere are the files.');
  });

  it('finalizers prefer streamed content, fall back to completed-item parts', () => {
    const streamed: CodexContentState = { text: 'live', reasoning: 'think', streamedReasoning: true, msgs: ['m'], thinkParts: ['t'] };
    expect(codexFinalText(streamed)).toBe('live');
    expect(codexFinalReasoning(streamed)).toBe('think');
    const completedOnly: CodexContentState = { text: '', reasoning: '', streamedReasoning: false, msgs: ['m1', 'm2'], thinkParts: ['t1', 't2'] };
    expect(codexFinalText(completedOnly)).toBe('m1\n\nm2');
    expect(codexFinalReasoning(completedOnly)).toBe('t1\n\nt2');
  });
});

// Real codex narrates what it is about to do via phase=commentary agentMessages before tool
// calls. The kernel port used to gate on phase=final_answer and drop them, so the live preview
// showed nothing during the "中间过程" until the final answer landed.
const FAKE_COMMENTARY_SERVER = `#!/usr/bin/env node
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method, params }) + '\\n');
const TID = 'codex-thread-commentary';
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'thread/start') reply(m.id, { thread: { id: TID } });
    else if (m.method === 'turn/start') {
      reply(m.id, {});
      notify('turn/started', { threadId: TID, turn: { id: 'turn-1' } });
      notify('item/started', { threadId: TID, item: { type: 'agentMessage', id: 'c1', phase: 'commentary' } });
      notify('item/agentMessage/delta', { threadId: TID, itemId: 'c1', delta: "I'll list src/." });
      notify('item/completed', { threadId: TID, item: { type: 'agentMessage', id: 'c1', phase: 'commentary', text: "I'll list src/." } });
      notify('item/started', { threadId: TID, item: { type: 'commandExecution', id: 'cmd1', command: 'ls src' } });
      notify('item/completed', { threadId: TID, item: { type: 'commandExecution', id: 'cmd1', status: 'completed' } });
      notify('item/started', { threadId: TID, item: { type: 'agentMessage', id: 'm1', phase: 'final_answer' } });
      notify('item/agentMessage/delta', { threadId: TID, itemId: 'm1', delta: 'Done.' });
      notify('item/completed', { threadId: TID, item: { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: 'Done.' } });
      notify('turn/completed', { threadId: TID, turn: { id: 'turn-1', status: 'completed' } });
    }
  }
});
`;

describe('CodexDriver commentary (preamble) is surfaced live', () => {
  let tmp: string; let fake: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-codex-cm-'));
    fake = path.join(tmp, 'fake-codex.mjs');
    fs.writeFileSync(fake, FAKE_COMMENTARY_SERVER);
    fs.chmodSync(fake, 0o755);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('streams commentary then final_answer (separated), and keeps shell as the only Activity tool', async () => {
    const { ctx, events } = ctxCollect();
    const result = await new CodexDriver(fake).run({ prompt: 'go', workdir: tmp }, ctx);
    expect(result.ok).toBe(true);
    // Both the preamble and the final answer are in the text, blank-line separated.
    expect(result.text).toBe("I'll list src/.\n\nDone.");
    const textStream = events.filter(e => e.type === 'text').map(e => (e as any).delta).join('');
    expect(textStream).toBe("I'll list src/.\n\nDone.");
    // The commentary did NOT become a bogus Activity tool — only the shell call did.
    const tools = events.filter(e => e.type === 'tool').map(e => (e as any).call.name);
    expect(tools).toEqual(['shell', 'shell']); // running + done for cmd1
  }, 20_000);
});

// Regression: aborting a codex turn must RESOLVE run() (stopReason 'interrupted'), not hang.
// A long-running turn never sends turn/completed; onAbort interrupts and settles turnDone itself.
// Before the fix, srv.kill() alone left `await turnDone` pending forever — the task stayed
// "running" in the orchestrator even though the codex process was already dead.
const FAKE_HANGING_SERVER = `#!/usr/bin/env node
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method, params }) + '\\n');
const TID = 'codex-thread-hang';
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'thread/start') reply(m.id, { thread: { id: TID } });
    else if (m.method === 'turn/start') {
      reply(m.id, {});
      notify('turn/started', { threadId: TID, turn: { id: 'turn-1' } });
      // ...and then nothing: NO turn/completed (simulates an in-flight long turn).
    }
    else if (m.method === 'turn/interrupt') reply(m.id, {}); // ack the interrupt
  }
});
`;

describe('CodexDriver abort resolves the turn (no hang)', () => {
  let tmp: string; let fake: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-codex-hang-'));
    fake = path.join(tmp, 'fake-codex.mjs');
    fs.writeFileSync(fake, FAKE_HANGING_SERVER);
    fs.chmodSync(fake, 0o755);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('settles run() with stopReason interrupted when aborted mid-turn', async () => {
    const ac = new AbortController();
    const events: DriverEvent[] = [];
    // registerSteer fires from the turn/started handler, AFTER turnId is set — use it as the
    // "turn is underway" signal so the abort exercises the graceful turn/interrupt branch
    // (rather than racing the app-server cold-start spawn).
    let turnStarted: () => void = () => {};
    const turnUnderway = new Promise<void>((r) => { turnStarted = r; });
    const ctx: DriverContext = {
      signal: ac.signal,
      emit: (e) => events.push(e),
      askUser: async () => ({}),
      registerSteer: () => { turnStarted(); },
    };
    const runP = new CodexDriver(fake).run({ prompt: 'long task', workdir: tmp }, ctx);
    await turnUnderway;
    ac.abort();
    const result = await runP; // must NOT hang
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('interrupted');
    expect(result.error).toBe('Interrupted by user.');
  }, 15_000);
});

// Regression: if the app-server process DIES mid-turn without ever sending turn/completed
// (crash / external kill / disconnect), run() must RESOLVE as a failed turn — not hang. Before
// the fix, `await turnDone` only settled on turn/completed or abort, so a dead process stranded
// the session at runState:"running" forever (the "已经结束了但左上角还是绿色运行中" bug).
const FAKE_DYING_SERVER = `#!/usr/bin/env node
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method, params }) + '\\n');
const TID = 'codex-thread-die';
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'thread/start') reply(m.id, { thread: { id: TID } });
    else if (m.method === 'turn/start') {
      reply(m.id, {});
      notify('turn/started', { threadId: TID, turn: { id: 'turn-1' } });
      // ...then the process crashes: exit WITHOUT ever sending turn/completed.
      process.stderr.write('fatal: codex app-server crashed\\n');
      process.exit(1);
    }
  }
});
`;

describe('CodexDriver settles when the app-server dies mid-turn (no hang)', () => {
  let tmp: string; let fake: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-codex-die-'));
    fake = path.join(tmp, 'fake-codex.mjs');
    fs.writeFileSync(fake, FAKE_DYING_SERVER);
    fs.chmodSync(fake, 0o755);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('resolves run() as a failed turn instead of hanging when the process exits without turn/completed', async () => {
    const { ctx } = ctxCollect();
    const result = await new CodexDriver(fake).run({ prompt: 'boom', workdir: tmp }, ctx); // must NOT hang
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('error');
    expect(result.error).toBeTruthy();
  }, 15_000);
});
