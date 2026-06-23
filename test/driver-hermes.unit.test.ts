import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamOpts, StreamResult } from '../src/agent/types.ts';

const RESPONDER_HEADER = `#!/usr/bin/env python3
import json, sys, time, os, threading

def write(obj):
    sys.stdout.write(json.dumps(obj) + "\\n"); sys.stdout.flush()

def read_request():
    line = sys.stdin.readline()
    if not line: return None
    line = line.strip()
    if not line: return read_request()
    try: return json.loads(line)
    except Exception: return read_request()

# Scenario script tells us what to do for each prompt the driver sends.
SCRIPT = json.loads(os.environ.get("HERMES_SCRIPT", "{}"))

# ---- ACP methods ------------------------------------------------------------

session_id = "sess-test-001"
loaded = False
mode_id = None
model_id = None

while True:
    req = read_request()
    if req is None: break
    method = req.get("method")
    rid = req.get("id")
    params = req.get("params", {}) or {}

    if method == "initialize":
        write({"jsonrpc":"2.0","id":rid,"result":{
            "protocolVersion":1,
            "agentInfo":{"name":"hermes-test","version":"0.0.0"},
            "agentCapabilities":{"loadSession":True,"promptCapabilities":{"image":False}},
        }})
    elif method == "session/new":
        write({"jsonrpc":"2.0","id":rid,"result":{"sessionId": session_id}})
    elif method == "session/load":
        load_behavior = SCRIPT.get("loadBehavior", "ok")
        if load_behavior == "null":
            write({"jsonrpc":"2.0","id":rid,"result":None})
        elif load_behavior == "error":
            write({"jsonrpc":"2.0","id":rid,"error":{"code":-32603,"message":"load failed"}})
        else:
            # Replay events: stream a couple of "old assistant" chunks AFTER
            # the response, simulating how Hermes pushes history-replay
            # session/update events on the event loop.
            write({"jsonrpc":"2.0","id":rid,"result":{}})
            def replay():
                time.sleep(0.05)
                for chunk in SCRIPT.get("replayChunks", []):
                    write({"jsonrpc":"2.0","method":"session/update","params":{
                        "sessionId": session_id,
                        "update":{"sessionUpdate":"agent_message_chunk","content":{"text":chunk}},
                    }})
            threading.Thread(target=replay, daemon=True).start()
    elif method == "session/set_model":
        model_id = params.get("modelId")
        write({"jsonrpc":"2.0","id":rid,"result":{}})
    elif method == "session/set_mode":
        mode_id = params.get("modeId")
        write({"jsonrpc":"2.0","id":rid,"result":{}})
    elif method == "session/prompt":
        # Capture the received prompt blocks for the test to assert against.
        capture_path = os.environ.get("HERMES_PROMPT_CAPTURE_PATH")
        if capture_path:
            try:
                with open(capture_path, "w") as f:
                    json.dump(params.get("prompt"), f)
            except Exception: pass
        # Optionally interleave tool_call / tool_call_update events so the
        # driver's activity-accumulator code path gets exercised.
        for ev in SCRIPT.get("toolEvents", []):
            write({"jsonrpc":"2.0","method":"session/update","params":{
                "sessionId": session_id,
                "update": ev,
            }})
            time.sleep(0.01)
        # Stream chunks for the prompt response, then return stopReason.
        for chunk in SCRIPT.get("promptChunks", ["Hello!"]):
            write({"jsonrpc":"2.0","method":"session/update","params":{
                "sessionId": session_id,
                "update":{"sessionUpdate":"agent_message_chunk","content":{"text":chunk}},
            }})
            time.sleep(0.01)
        write({"jsonrpc":"2.0","id":rid,"result":{"stopReason": SCRIPT.get("stopReason", "end_turn")}})
    elif method == "session/cancel":
        # No response (notification)
        pass
    else:
        if rid is not None:
            write({"jsonrpc":"2.0","id":rid,"error":{"code":-32601,"message":"unknown method"}})
`;

interface Scenario {
  promptChunks?: string[];
  stopReason?: string;
  loadBehavior?: 'ok' | 'null' | 'error';
  replayChunks?: string[];
  toolEvents?: any[];
}

let tmpDir: string;
let responderPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-hermes-test-'));
  responderPath = path.join(tmpDir, 'responder.py');
  fs.writeFileSync(responderPath, RESPONDER_HEADER, { mode: 0o755 });
  vi.resetModules();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function runDriver(scenario: Scenario, opts: Partial<StreamOpts> = {}): Promise<{ result: StreamResult; deltas: string[]; activities: string[]; capturedPrompt: any }> {
  const { doHermesStream } = await import('../src/agent/drivers/hermes.ts');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, 'hermes');
  fs.writeFileSync(shim,
    `#!/bin/sh\nexec python3 ${JSON.stringify(responderPath)} "$@"\n`,
    { mode: 0o755 },
  );
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath || ''}`;
  process.env.HERMES_SCRIPT = JSON.stringify(scenario);
  const capturePath = path.join(tmpDir, 'prompt-capture.json');
  process.env.HERMES_PROMPT_CAPTURE_PATH = capturePath;

  const deltas: string[] = [];
  const activities: string[] = [];
  const baseOpts: StreamOpts = {
    agent: 'hermes',
    prompt: '你好',
    workdir: tmpDir,
    timeout: 30,
    sessionId: null,
    model: 'openai/gpt-5.4-mini',
    thinkingEffort: 'medium',
    onText: (text, _thinking, activity) => { deltas.push(text); activities.push(activity || ''); },
    ...opts,
  };

  try {
    const result = await doHermesStream(baseOpts);
    let capturedPrompt: any = null;
    try { capturedPrompt = JSON.parse(fs.readFileSync(capturePath, 'utf8')); } catch {}
    return { result, deltas, activities, capturedPrompt };
  } finally {
    if (prevPath == null) delete process.env.PATH;
    else process.env.PATH = prevPath;
    delete process.env.HERMES_SCRIPT;
    delete process.env.HERMES_PROMPT_CAPTURE_PATH;
  }
}

describe('Hermes ACP driver', () => {
  it('handles happy path, resume, refusals, images, tool-call chains, and missing sessions', async () => {
    {
      const { result, deltas } = await runDriver({
        promptChunks: ['Hi! ', 'How can I ', 'help you today?'],
        stopReason: 'end_turn',
      });

      expect(result.ok).toBe(true);
      expect(result.message).toBe('Hi! How can I help you today?');
      expect(result.sessionId).toBe('sess-test-001');
      expect(result.stopReason).toBe('end_turn');
      expect(result.error).toBeNull();
      expect(deltas.length).toBeGreaterThanOrEqual(3);
      expect(deltas[deltas.length - 1]).toBe('Hi! How can I help you today?');
    }

    {
      const { result } = await runDriver(
        {
          promptChunks: ['Fresh reply. '],
          replayChunks: ['OLD-USER: prior turn\n', 'OLD-ASSISTANT: prior reply\n'],
          stopReason: 'end_turn',
        },
        { sessionId: 'sess-test-001' },
      );

      expect(result.ok).toBe(true);
      expect(result.message).toBe('Fresh reply.');
      expect(result.message).not.toContain('OLD-USER');
      expect(result.message).not.toContain('OLD-ASSISTANT');
    }

    {
      const { result } = await runDriver({
        promptChunks: ["I'm sorry, but I cannot assist with that request."],
        stopReason: 'end_turn',
      });

      expect(result.message).toBe("I'm sorry, but I cannot assist with that request.");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/safety refusal/i);
      expect(result.stopReason).toBe('end_turn');
    }

    {
      const { result } = await runDriver({
        promptChunks: ['ok'],
        stopReason: 'end_turn',
      });
      expect(result.ok).toBe(true);
      expect(result.message).toBe('ok');
      expect(result.error).toBeNull();
    }

    {
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00,
      ]);
      const imagePath = path.join(tmpDir, 'shot.png');
      fs.writeFileSync(imagePath, pngBytes);

      const { result, capturedPrompt } = await runDriver(
        { promptChunks: ['ack'], stopReason: 'end_turn' },
        { attachments: [imagePath] },
      );

      expect(result.ok).toBe(true);
      expect(Array.isArray(capturedPrompt)).toBe(true);
      const imageBlocks = capturedPrompt.filter((b: any) => b?.type === 'image');
      expect(imageBlocks).toHaveLength(1);
      expect(imageBlocks[0].mimeType).toBe('image/png');
      expect(imageBlocks[0].data).toBe(pngBytes.toString('base64'));
      const textBlocks = capturedPrompt.filter((b: any) => b?.type === 'text');
      expect(textBlocks.map((b: any) => b.text)).toContain('你好');
    }

    {
      const { activities } = await runDriver({
        promptChunks: ['Done.'],
        stopReason: 'end_turn',
        toolEvents: [
          { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read foo.py', status: 'in_progress' },
          { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
          { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Grep bar', status: 'in_progress' },
          { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' },
          { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Edit baz.py', status: 'in_progress' },
          { sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'failed' },
        ],
      });
      const final = activities[activities.length - 1] || '';
      expect(final).toContain('Read foo.py');
      expect(final).toContain('Read foo.py done');
      expect(final).toContain('Grep bar');
      expect(final).toContain('Grep bar done');
      expect(final).toContain('Edit baz.py');
      expect(final).toContain('Edit baz.py failed');
      expect(final.indexOf('Read foo.py')).toBeLessThan(final.indexOf('Grep bar'));
      expect(final.indexOf('Grep bar')).toBeLessThan(final.indexOf('Edit baz.py'));
    }

    {
      const { result } = await runDriver(
        {
          loadBehavior: 'null',
          promptChunks: ['Recovered.'],
          stopReason: 'end_turn',
        },
        { sessionId: 'unknown-id' },
      );
      expect(result.ok).toBe(true);
      expect(result.message).toBe('Recovered.');
    }
  });
});
