import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AcpDriver, applyAcpUpdate, toAcpMcpServers, buildAcpPromptBlocks,
} from '../src/drivers/acp.js';
import { runTurn } from '../src/index.js';
import type { DriverEvent } from '../src/contracts/driver.js';

// ── A hermetic ACP agent (ndjson JSON-RPC over stdio) used to drive the real AcpDriver
// through a real subprocess: exercises initialize, MCP forwarding, set_model, the
// permission HITL round-trip, the fs/write+read bridge, usage, and stopReason. ──────────
const MOCK_ACP_AGENT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let model = '(none)';
let mcpCount = -1;
const pending = new Map();
let permId = 1000;
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
function note(sessionId, update) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }); }
rl.on('line', async (line) => {
  const t = line.trim(); if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  // response to our (agent->client) permission request
  if (m.id != null && !m.method) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m.result); } return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  if (m.method === 'session/new') { mcpCount = Array.isArray(m.params.mcpServers) ? m.params.mcpServers.length : 0; return send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'mock-1' } }); }
  if (m.method === 'session/set_model') { model = m.params.modelId; return send({ jsonrpc: '2.0', id: m.id, result: {} }); }
  if (m.method === 'session/set_mode') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'session/prompt') {
    const sid = m.params.sessionId;
    note(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking ' } });
    note(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    // fs bridge: ask the client to write then read a file, prove the round-trip
    const target = m.params.prompt.find(b => b.type === 'text' && b.text.startsWith('FILE:')).text.slice(5);
    await new Promise((res) => { const id = permId++; pending.set(id, res); send({ jsonrpc: '2.0', id, method: 'fs/write_text_file', params: { sessionId: sid, path: target, content: 'written-by-agent' } }); });
    const readBack = await new Promise((res) => { const id = permId++; pending.set(id, res); send({ jsonrpc: '2.0', id, method: 'fs/read_text_file', params: { sessionId: sid, path: target } }); });
    // permission HITL: ask the client; branch the answer into the message
    const outcome = await new Promise((res) => { const id = permId++; pending.set(id, res); send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: sid, toolCall: { title: 'delete everything' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } }); });
    const decision = outcome && outcome.outcome && outcome.outcome.outcome === 'selected' ? outcome.outcome.optionId : 'cancelled';
    note(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'edit', status: 'in_progress' });
    note(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' });
    note(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'model=' + model + ' mcp=' + mcpCount + ' perm=' + decision + ' file=' + (readBack && readBack.content) } });
    note(sid, { sessionUpdate: 'usage_update', size: 100000, used: 4242 });
    return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 11, outputTokens: 7 } } });
  }
  if (m.id != null) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

describe('AcpDriver (generic ACP) — pure helpers', () => {
  it('parses plan, tool statuses, and usage from session/update', () => {
    const out: DriverEvent[] = [];
    const s: any = {};
    const tools = new Set<string>();
    const updates = [
      { sessionUpdate: 'plan', entries: [{ content: 'step A', status: 'in_progress' }, { content: 'step B', status: 'pending' }] },
      { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'grep', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed' },
      { sessionUpdate: 'usage_update', size: 200000, used: 1000 },
    ];
    for (const u of updates) applyAcpUpdate(u, s, tools, (e) => out.push(e));
    const plan = out.find(e => e.type === 'plan') as any;
    expect(plan.plan.steps).toEqual([{ text: 'step A', status: 'inProgress' }, { text: 'step B', status: 'pending' }]);
    expect(out.filter(e => e.type === 'tool').map(e => (e as any).call.status)).toEqual(['running', 'failed']);
    const usage = out.find(e => e.type === 'usage') as any;
    expect(usage.usage).toMatchObject({ contextUsedTokens: 1000, contextPercent: 0.5 });
  });

  it('converts kernel McpServerSpec[] to ACP mcpServers (stdio + http)', () => {
    const acp = toAcpMcpServers([
      { name: 'fs', command: 'mcp-fs', args: ['--root', '/tmp'], env: { TOKEN: 'x' } },
      { name: 'remote', type: 'http', url: 'https://h/mcp', headers: { Authorization: 'Bearer y' } },
      { name: 'skipme' } as any,
    ]);
    expect(acp).toEqual([
      { name: 'fs', command: 'mcp-fs', args: ['--root', '/tmp'], env: [{ name: 'TOKEN', value: 'x' }] },
      { type: 'http', name: 'remote', url: 'https://h/mcp', headers: [{ name: 'Authorization', value: 'Bearer y' }] },
    ]);
  });

  it('builds prompt blocks with a trailing text block', () => {
    const blocks = buildAcpPromptBlocks('do it', ['/no/such/file.txt']);
    expect(blocks[blocks.length - 1]).toEqual({ type: 'text', text: 'do it' });
    expect(blocks[0]).toEqual({ type: 'text', text: '[Attached file: /no/such/file.txt]' });
  });
});

describe('AcpDriver — end-to-end against a mock ACP agent', () => {
  it('runs a turn: MCP forward, set_model, permission HITL, fs bridge, usage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-mock-'));
    const agentPath = path.join(dir, 'mock-acp-agent.cjs');
    fs.writeFileSync(agentPath, MOCK_ACP_AGENT);
    const filePath = path.join(dir, 'out.txt');

    const driver = new AcpDriver({ id: 'mock', command: process.execPath, args: [agentPath] });
    const { result, snapshot } = await runTurn(
      driver,
      {
        prompt: `FILE:${filePath}`,
        workdir: dir,
        model: 'opencode-x',
        extraMcpServers: [{ name: 'fs', command: 'x' }, { name: 'web', type: 'http', url: 'https://h/mcp' }],
      },
      // a terminal that always grants the first (allow) option
      { interactionHandler: { async askUser(i) { return { choice: [i.questions[0].choices![0].value!] }; } } },
    );

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('mock-1');
    expect(result.stopReason).toBe('end_turn');
    expect(result.reasoning).toContain('thinking');
    // proves: set_model applied, both MCP servers forwarded, permission granted ('ok'), fs round-trip
    expect(result.text).toContain('model=opencode-x');
    expect(result.text).toContain('mcp=2');
    expect(result.text).toContain('perm=ok');
    expect(result.text).toContain('file=written-by-agent');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('written-by-agent');
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, contextUsedTokens: 4242 });
    expect(snapshot.toolCalls?.some(t => t.status === 'done')).toBe(true);
  });

  it('applies the permission fallback when no terminal answers (headless auto-cancel -> allow)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-mock-'));
    const agentPath = path.join(dir, 'mock-acp-agent.cjs');
    fs.writeFileSync(agentPath, MOCK_ACP_AGENT);
    const filePath = path.join(dir, 'out.txt');

    const driver = new AcpDriver({ id: 'mock', command: process.execPath, args: [agentPath], permissionFallback: 'allow' });
    // no interactionHandler -> AutoCancelInteractionHandler -> {} -> fallback picks the allow_once option
    const { result } = await runTurn(driver, { prompt: `FILE:${filePath}`, workdir: dir });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('perm=ok');
  });
});
