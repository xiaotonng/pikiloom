import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { ensureResponsesBridge, shutdownResponsesBridge, upstreamToken } from '../src/model/responses-bridge.js';

// Spin up a fake chat-completions upstream that streams the given SSE lines, run it through
// the real responses-bridge, and collect the Responses events the bridge emits. This guards
// the Chat→Responses streaming translation — in particular that a thinking model's reasoning
// (delta.reasoning_content / delta.reasoning) is forwarded LIVE as reasoning-summary events
// instead of being dropped (which made the whole thinking phase silent).

let upstream: http.Server | null = null;

afterEach(() => {
  shutdownResponsesBridge();
  try { upstream?.close(); } catch { /* ignore */ }
  upstream = null;
});

async function runBridge(sseLines: string[]): Promise<Array<{ type: string; data: any }>> {
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const l of sseLines) res.write(`data: ${l}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>(r => upstream!.listen(0, '127.0.0.1', () => r()));
  const upstreamBase = `http://127.0.0.1:${(upstream!.address() as any).port}/v1`;

  const port = await ensureResponsesBridge();
  const url = `http://127.0.0.1:${port}/u/${upstreamToken(upstreamBase)}/responses`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake', input: [{ type: 'message', role: 'user', content: 'hi' }], stream: true }),
  });
  const text = await resp.text();
  const events: Array<{ type: string; data: any }> = [];
  for (const block of text.split('\n\n')) {
    const typeLine = block.split('\n').find(l => l.startsWith('event: '));
    const dataLine = block.split('\n').find(l => l.startsWith('data: '));
    if (!typeLine || !dataLine) continue;
    try { events.push({ type: typeLine.slice(7).trim(), data: JSON.parse(dataLine.slice(6)) }); } catch { /* skip */ }
  }
  return events;
}

describe('responses-bridge — reasoning (thinking) translation', () => {
  it('forwards delta.reasoning_content (DeepSeek/豆包) as live reasoning-summary deltas before the message', async () => {
    const events = await runBridge([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'Think' } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'ing' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }),
      JSON.stringify({ choices: [{ delta: { content: '!' } }] }),
    ]);
    const types = events.map(e => e.type);

    // A reasoning item is opened, its summary text streams as deltas, then it is closed.
    const reasoningAdded = types.indexOf('response.output_item.added');
    expect(events[reasoningAdded].data.item.type).toBe('reasoning');
    const reasonDeltas = events.filter(e => e.type === 'response.reasoning_summary_text.delta').map(e => e.data.delta);
    expect(reasonDeltas).toEqual(['Think', 'ing']);

    // The reasoning item must finish (output_item.done) BEFORE the message item opens.
    const reasoningDoneIdx = events.findIndex(e => e.type === 'response.output_item.done' && e.data.item.type === 'reasoning');
    const msgAddedIdx = events.findIndex(e => e.type === 'response.output_item.added' && e.data.item.type === 'message');
    expect(reasoningDoneIdx).toBeGreaterThanOrEqual(0);
    expect(msgAddedIdx).toBeGreaterThan(reasoningDoneIdx);

    // The completed reasoning item carries the full summary text (for the end-of-turn fallback).
    expect(events[reasoningDoneIdx].data.item.summary[0].text).toBe('Thinking');

    // The answer still streams as text deltas after the thinking.
    const textDeltas = events.filter(e => e.type === 'response.output_text.delta').map(e => e.data.delta);
    expect(textDeltas).toEqual(['Hi', '!']);
  });

  it('also forwards delta.reasoning (GLM/OpenRouter field name)', async () => {
    const events = await runBridge([
      JSON.stringify({ choices: [{ delta: { reasoning: 'Pondering' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'Answer' } }] }),
    ]);
    const reasonDeltas = events.filter(e => e.type === 'response.reasoning_summary_text.delta').map(e => e.data.delta);
    expect(reasonDeltas).toEqual(['Pondering']);
    const textDeltas = events.filter(e => e.type === 'response.output_text.delta').map(e => e.data.delta);
    expect(textDeltas).toEqual(['Answer']);
  });

  it('does not emit a reasoning item when the model sends no reasoning (plain answer)', async () => {
    const events = await runBridge([
      JSON.stringify({ choices: [{ delta: { content: 'Just' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' text' } }] }),
    ]);
    expect(events.some(e => e.type === 'response.reasoning_summary_text.delta')).toBe(false);
    expect(events.some(e => e.type === 'response.output_item.added' && e.data.item.type === 'reasoning')).toBe(false);
    const textDeltas = events.filter(e => e.type === 'response.output_text.delta').map(e => e.data.delta);
    expect(textDeltas).toEqual(['Just', ' text']);
  });
});
