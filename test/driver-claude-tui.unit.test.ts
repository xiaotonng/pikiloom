/**
 * Unit tests for the Claude TUI driver path.
 *
 * The TUI driver requires `node-pty` (optional dep) and a working `claude`
 * binary to run end-to-end, which we cannot rely on in CI. These tests focus
 * on the contracts that are verifiable without those: env-var detection,
 * fallback to `-p` when node-pty is missing, hook script shape, JSONL
 * incremental tail correctness, and graceful error returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withEnv } from './support/env.ts';

describe('isClaudePrintModeForced — TUI is now the default; only opt-out flips it', () => {
  let module: typeof import('../src/agent/drivers/claude.ts');

  beforeEach(async () => {
    vi.resetModules();
    module = await import('../src/agent/drivers/claude.ts');
  });

  it('default false / PRINT truthy true / legacy TUI off true / legacy TUI=1 no-op', async () => {
    // returns false by default (TUI mode wins)
    await withEnv({ PIKICLAW_CLAUDE_PRINT: undefined, PIKICLAW_CLAUDE_TUI: undefined }, () => {
      expect(module.isClaudePrintModeForced()).toBe(false);
    });
    await withEnv({ PIKICLAW_CLAUDE_PRINT: '', PIKICLAW_CLAUDE_TUI: '' }, () => {
      expect(module.isClaudePrintModeForced()).toBe(false);
    });

    // returns true when PIKICLAW_CLAUDE_PRINT is truthy
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', ' 1 ']) {
      await withEnv({ PIKICLAW_CLAUDE_PRINT: v, PIKICLAW_CLAUDE_TUI: undefined }, () => {
        expect(module.isClaudePrintModeForced()).toBe(true);
      });
    }

    // returns true when legacy PIKICLAW_CLAUDE_TUI is explicitly off
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'No', ' off ']) {
      await withEnv({ PIKICLAW_CLAUDE_PRINT: undefined, PIKICLAW_CLAUDE_TUI: v }, () => {
        expect(module.isClaudePrintModeForced()).toBe(true);
      });
    }

    // treats legacy PIKICLAW_CLAUDE_TUI=1 as a no-op (matches default)
    await withEnv({ PIKICLAW_CLAUDE_PRINT: undefined, PIKICLAW_CLAUDE_TUI: '1' }, () => {
      expect(module.isClaudePrintModeForced()).toBe(false);
    });
  });
});

describe('Claude TUI driver — startup-failure fallback contract', () => {
  let tmpDir: string;
  const onText = vi.fn();

  beforeEach(() => {
    onText.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-claude-tui-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('throws (not returns) when pty.spawn cannot find the claude binary — lets the dispatcher fall back to -p', async () => {
    // Force PATH to point only at a directory that has no `claude` so the
    // driver's resolution falls back to the bare name, and pty.spawn then
    // fails with ENOENT. Contract: the TUI driver THROWS for startup
    // failures so the dispatcher in claude.ts catches it and falls back to
    // the print-mode path instead of leaving the user with a broken turn.
    const isolatedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-no-claude-'));
    const { doClaudeTuiStream } = await import('../src/agent/drivers/claude-tui.ts');
    try {
      let thrown: any = null;
      let result: any = null;
      try {
        result = await Promise.race([
          new Promise(resolve => setTimeout(() => resolve({ __sentinel: 'timeout' }), 8_000)),
          withEnv({ PATH: isolatedPath }, () =>
            doClaudeTuiStream({
              agent: 'claude',
              prompt: 'hello',
              workdir: tmpDir,
              timeout: 3,
              sessionId: null,
              model: null,
              thinkingEffort: 'medium',
              onText,
              extraEnv: { PATH: isolatedPath },
            }),
          ),
        ]);
      } catch (e) {
        thrown = e;
      }
      // Either the driver threw (the new, expected behaviour for startup
      // failures), or — if it managed to spawn something and produced a
      // StreamResult — that result must be a clean structured error. Both
      // are acceptable; what's NOT acceptable is an unhandled crash
      // somewhere else.
      if (thrown) {
        expect(String(thrown?.message || thrown)).toMatch(/pty\.spawn|claude|node-pty|posix_spawnp|ENOENT/i);
      } else if (result && !result.__sentinel) {
        expect(result.ok).toBe(false);
        expect(result.incomplete).toBe(true);
      }
    } finally {
      try { fs.rmSync(isolatedPath, { recursive: true, force: true }); } catch {}
    }
  }, 15_000);
});

describe('Claude TUI driver — upfront session-id promotion', () => {
  // Regression: a brand-new TUI session must fire opts.onSessionId with the
  // generated --session-id BEFORE the turn runs, so the pending pikiclaw record
  // is promoted to its native id immediately. Previously the driver pre-assigned
  // s.sessionId, which made emitSessionIdUpdate dedup and silently swallow the
  // callback — leaving the record `pending_*` for the whole run. Since
  // mergeManagedAndNativeSessions drops pending records, the dashboard never saw
  // the in-flight session as running on (re)load. The emit happens before
  // pty.spawn, so we force the spawn to fail (empty PATH) and assert the callback
  // already fired synchronously beforehand.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let tmpDir: string;
  const onText = vi.fn();

  beforeEach(() => {
    onText.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-tui-promote-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  async function runWithBrokenSpawn(sessionId: string | null, onSessionId: (id: string) => void) {
    const isolatedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-no-claude-'));
    const { doClaudeTuiStream } = await import('../src/agent/drivers/claude-tui.ts');
    try {
      await Promise.race([
        new Promise(resolve => setTimeout(() => resolve(null), 8_000)),
        withEnv({ PATH: isolatedPath }, () =>
          doClaudeTuiStream({
            agent: 'claude',
            prompt: 'hello',
            workdir: tmpDir,
            timeout: 3,
            sessionId,
            model: null,
            thinkingEffort: 'medium',
            onText,
            onSessionId,
            extraEnv: { PATH: isolatedPath },
          }),
        ),
      ]).catch(() => { /* spawn failure is expected; the emit already ran */ });
    } finally {
      try { fs.rmSync(isolatedPath, { recursive: true, force: true }); } catch {}
    }
  }

  it('fires onSessionId for a new (pending) session, but not when resuming a native session', async () => {
    // New (pending) session: fires onSessionId with the generated id.
    const seenNew: string[] = [];
    await runWithBrokenSpawn(null, id => seenNew.push(id));
    expect(seenNew.length).toBeGreaterThan(0);
    expect(seenNew[0]).toMatch(UUID_RE);

    // Resume: the id is already native, so there is nothing to promote. (A
    // mid-turn rotation would arrive via the SessionStart hook, but the spawn
    // fails before any hook runs.)
    const seenResume: string[] = [];
    await runWithBrokenSpawn('f7e0b5a8-ff07-45a4-8282-1a1bb99340ac', id => seenResume.push(id));
    expect(seenResume).toEqual([]);
  }, 20_000);
});

describe('Claude TUI driver — terminal limit notices', () => {
  it('detects synthetic + screen-only limit notices but ignores ordinary rate-limit prose', async () => {
    const { detectClaudeTuiTerminalLimitNotice } = await import('../src/agent/drivers/claude-tui.ts');
    // Synthetic subscription/session limit notice.
    const notice = detectClaudeTuiTerminalLimitNotice({
      model: '<synthetic>',
      content: [{ type: 'text', text: "You've hit your session limit · resets 9:40pm (Asia/Shanghai)" }],
    });
    expect(notice).toContain("You've hit your session limit");
    // Screen-only limit text vs. ordinary prose about rate limits.
    expect(detectClaudeTuiTerminalLimitNotice('Usage limit reached. Please try again later.')).toContain('Usage limit reached');
    expect(detectClaudeTuiTerminalLimitNotice('Please explain how rate limit handling works in this codebase.')).toBeNull();
  });
});

describe('Claude TUI driver — bypass-permissions prompt auto-answer', () => {
  // The fix for the cross-machine startup hang: when the TUI paints its
  // "Bypass Permissions mode" confirmation (default highlight on "No, exit"),
  // the driver must recognise it from the raw PTY screen and select "Yes, I
  // accept" rather than letting the blind prompt-submit Enter pick "No, exit".
  it('detects spaceless + spaced + real-byte bypass frames, ignores prose/partial/empty inputs', async () => {
    const { detectClaudeBypassPrompt } = await import('../src/agent/drivers/claude-tui.ts');

    // Detects the bypass dialog in the real (spaceless, cursor-positioned) PTY screen.
    // Claude's TUI positions words with cursor-move escapes, so after ANSI strip
    // the words run together. This mirrors the bytes captured live from claude
    // 2.1.168 — note: NO spaces between words.
    const realScreen =
      '\x1b[2J\x1b[H\x1b[200GWARNING:ClaudeCoderunninginBypassPermissionsmode\r\n\r\n' +
      'InBypassPermissionsmode,ClaudeCodewillnotaskforyourapproval\r\n\r\n' +
      '\x1b[36m❯1.No,exit\x1b[0m\r\n2.Yes,Iaccept\r\n\r\nEntertoconfirm·Esctocancel\r\n';
    expect(detectClaudeBypassPrompt(realScreen)).toBe(true);

    // Also detects the space-preserving rendering.
    const spaced =
      '\x1b[1m WARNING: Claude Code running in Bypass Permissions mode\x1b[0m\r\n\r\n' +
      '\x1b[36m❯ 1. No, exit\x1b[0m\r\n   2. Yes, I accept\r\n';
    expect(detectClaudeBypassPrompt(spaced)).toBe(true);

    // Does not fire on ordinary text or partial matches.
    // Prose that merely mentions bypass mode — no option lines.
    expect(detectClaudeBypassPrompt('Explain how Bypass Permissions mode works in Claude Code.')).toBe(false);
    // Only one of the three required fragments present.
    expect(detectClaudeBypassPrompt('1. No, exit\n2. Yes, I accept')).toBe(false);
    // Unrelated startup screen.
    expect(detectClaudeBypassPrompt('Choose the text style that looks best with your terminal')).toBe(false);
    // Non-string / empty inputs.
    expect(detectClaudeBypassPrompt('')).toBe(false);
    expect(detectClaudeBypassPrompt(null)).toBe(false);
    expect(detectClaudeBypassPrompt(undefined)).toBe(false);

    // Matches the real PTY bytes captured live from claude 2.1.168.
    // Raw bytes of the actual "Bypass Permissions mode" dialog frame, captured
    // off a real PTY (claude 2.1.168) and decoded as UTF-8 exactly as node-pty
    // delivers it to onData. This is the load-bearing case: the dialog lays
    // words out with cursor-position escapes (\x1b[<col>G), so the detector must
    // survive the real strip → no synthetic string can stand in for it.
    const REAL_BYPASS_FRAME_B64 =
      'GzcbW3IbOBtbPzI1aBtbPzI1bBtbPzIwMDRoG1s/MTAwNGgbWz8yMDMxaBtbPHUbWz4xdRtbPjQ7Mm0bWz8yMDI2aA0NChtbMzg7MjsyNTU7MTA3OzEyOG3ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAbWzM5bQ0NChtbM0cbWzM4OzI7MjU1OzEwNzsxMjhtG1sxbVdBUk5JTkc6G1sxMkdDbGF1ZGUbWzE5R0NvZGUbWzI0R3J1bm5pbmcbWzMyR2luG1szNUdCeXBhc3MbWzQyR1Blcm1pc3Npb25zG1s1NEdtb2RlG1syMm0bWzM5bQ0NCg0NChtbM0dJbhtbNkdCeXBhc3MbWzEzR1Blcm1pc3Npb25zG1syNUdtb2RlLBtbMzFHQ2xhdWRlG1szOEdDb2RlG1s0M0d3aWxsG1s0OEdub3QbWzUyR2FzaxtbNTZHZm9yG1s2MEd5b3VyG1s2NUdhcHByb3ZhbA0NChtbM0diZWZvcmUbWzEwR3J1bm5pbmcbWzE4R3BvdGVudGlhbGx5G1szMEdkYW5nZXJvdXMbWzQwR2NvbW1hbmRzLg0NChtbM0dUaGlzG1s4R21vZGUbWzEzR3Nob3VsZBtbMjBHb25seRtbMjVHYmUbWzI4R3VzZWQbWzMzR2luG1szNkdhG1szOEdzYW5kYm94ZWQbWzQ4R2NvbnRhaW5lci9WTRtbNjFHdGhhdBtbNjZHaGFzDQ0KG1szR3Jlc3RyaWN0ZWQbWzE0R2ludGVybmV0G1syM0dhY2Nlc3MbWzMwR2FuZBtbMzRHY2FuG1szOEdlYXNpbHkbWzQ1R2JlG1s0OEdyZXN0b3JlZBtbNTdHaWYbWzYwR2RhbWFnZWQuDQ0KDQ0KG1szR0J5G1s2R3Byb2NlZWRpbmcsG1sxOEd5b3UbWzIyR2FjY2VwdBtbMjlHYWxsG1szM0dyZXNwb25zaWJpbGl0eRtbNDhHZm9yG1s1MkdhY3Rpb25zG1s2MEd0YWtlbhtbNjZHd2hpbGUbWzcyR3J1bm5pbmcNDQobWzNHaW4bWzZHQnlwYXNzG1sxM0dQZXJtaXNzaW9ucxtbMjVHbW9kZS4NDQoNDQobWzNHG104O2lkPXpheG1kYTtodHRwczovL2NvZGUuY2xhdWRlLmNvbS9kb2NzL2VuL3NlY3VyaXR5B2h0dHBzOi8vY29kZS5jbGF1ZGUuY29tL2RvY3MvZW4vc2VjdXJpdHkbXTg7OwcNDQoNDQobWzNHG1szODsyOzE3NzsxODU7MjQ5beKdrxtbNUcbWzM4OzI7MTUzOzE1MzsxNTNtMS4bWzhHG1szODsyOzE3NzsxODU7MjQ5bU5vLBtbMTJHZXhpdBtbMzltDQ0KG1s1RxtbMzg7MjsxNTM7MTUzOzE1M20yLhtbOEcbWzM5bVllcywbWzEzR0kbWzE1R2FjY2VwdA0NCg0NChtbM0cbWzM4OzI7MTUzOzE1MzsxNTNtG1szbUVudGVyG1s5R3RvG1sxMkdjb25maXJtG1syMEfCtxtbMjJHRXNjG1syNkd0bxtbMjlHY2FuY2VsG1syM20bWzM5bQ0NChtbMkMbWzRBG1s/MjAyNmw=';
    const realFrame = Buffer.from(REAL_BYPASS_FRAME_B64, 'base64').toString('utf8');
    expect(detectClaudeBypassPrompt(realFrame)).toBe(true);
  });
});

describe('Claude TUI driver — mid-turn permission prompt auto-answer', () => {
  // bypassPermissions does NOT suppress explicit `ask` rules (e.g. Bash(git tag:*)),
  // so the TUI paints a "Do you want to proceed? ❯ 1. Yes … 3. No" confirmation
  // mid-turn. The driver must recognise it and select "1. Yes" rather than let it
  // hang until the stall watchdog SIGTERMs and mislabels it a "CLI freeze".
  it('detects the proceed dialog (spaceless + spaced), stays disjoint from bypass + prose', async () => {
    const { detectClaudeProceedPrompt, detectClaudeBypassPrompt } =
      await import('../src/agent/drivers/claude-tui.ts');

    // Real (spaceless, cursor-positioned) git-tag confirmation frame — mirrors
    // the bytes captured live in ~/.pikiclaw/diagnostics/claude-tui-stall.jsonl.
    const realScreen =
      '\x1b[2J\x1b[H\x1b[36mPermissionruleBash(gittag:*)requiresconfirmationforthiscommand.\r\n' +
      '/permissionstoupdaterules\r\n\r\nDoyouwanttoproceed?\r\n' +
      '\x1b[36m❯1.Yes\x1b[0m\r\n2.Yes,anddon’taskagainfor:node-p\r\n3.No\r\n\r\n' +
      'Esctocancel·Tabtoamend·ctrl+etoexplain\r\n';
    expect(detectClaudeProceedPrompt(realScreen)).toBe(true);

    // Space-preserving rendering also matches.
    const spaced =
      'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don’t ask again for: git tag\r\n  3. No\r\n\r\nEsc to cancel · Tab to amend\r\n';
    expect(detectClaudeProceedPrompt(spaced)).toBe(true);

    // Disjoint from the startup bypass dialog: its option 1 is "No, exit", so a
    // "1" keystroke would quit — the proceed handler must never claim that frame.
    const bypass =
      '\x1b[1mWARNING: Claude Code running in Bypass Permissions mode\x1b[0m\r\n' +
      '\x1b[36m❯ 1. No, exit\x1b[0m\r\n  2. Yes, I accept\r\nEnter to confirm · Esc to cancel\r\n';
    expect(detectClaudeProceedPrompt(bypass)).toBe(false);
    expect(detectClaudeBypassPrompt(bypass)).toBe(true); // sanity: bypass owns this frame

    // Conservative: needs the proceed question AND "1. Yes" AND the Esc footer.
    expect(detectClaudeProceedPrompt('Do you want to proceed? (just prose, no menu)')).toBe(false);
    expect(detectClaudeProceedPrompt('❯ 1. Yes\n2. No\nEsc to cancel')).toBe(false); // no question
    // Assistant prose describing a prompt must not trigger a keystroke injection
    // (no Ink "Esc to cancel" footer, so it stays inert).
    expect(detectClaudeProceedPrompt('The CLI asks "Do you want to proceed?" with 1. Yes / 2. No.')).toBe(false);
    expect(detectClaudeProceedPrompt('')).toBe(false);
    expect(detectClaudeProceedPrompt(null)).toBe(false);
    expect(detectClaudeProceedPrompt(undefined)).toBe(false);
  });
});

describe('Claude TUI driver — stall screen classifier', () => {
  // Capture-only: when a turn goes quiet, classifyStallScreen flags whether the
  // screen looks like a blocking interactive prompt (the mid-turn dialog-hang
  // we cannot otherwise distinguish from a long think or a frozen stream).
  it('flags interactive prompts but not spinner/plain/empty screens, and returns a sample', async () => {
    const { classifyStallScreen } = await import('../src/agent/drivers/claude-tui.ts');
    // Flags interactive prompts (confirm footer / numbered select / trust).
    expect(classifyStallScreen('\x1b[36m❯ 1. No, exit\x1b[0m\r\n2. Yes, I accept\r\nEnter to confirm · Esc to cancel').looksLikePrompt).toBe(true);
    expect(classifyStallScreen('Do you want to proceed with this edit? (y/n)').looksLikePrompt).toBe(true);
    expect(classifyStallScreen('Quick safety check: Is this a project you trust this folder...').looksLikePrompt).toBe(true);

    // Does not flag a spinner / thinking screen or plain output, and returns a sample.
    const thinking = classifyStallScreen('\x1b[2m✻ Cogitating… (45s · esc to interrupt)\x1b[0m');
    expect(thinking.looksLikePrompt).toBe(false);
    expect(thinking.sample.length).toBeGreaterThan(0);
    expect(classifyStallScreen('Running tests…\n  ✓ 325 passed').looksLikePrompt).toBe(false);
    expect(classifyStallScreen('').looksLikePrompt).toBe(false);
    expect(classifyStallScreen(null).looksLikePrompt).toBe(false);
  });
});

describe('Claude TUI driver — stall diagnostics classifier', () => {
  // classifyClaudeJsonlEvent labels the last transcript event before a quiet
  // stretch. The labels are load-bearing for the freeze diagnostics: the known
  // freeze signature is a `user:tool_result` with no following assistant, so
  // these must be precise.
  it('labels assistant/user events and degrades gracefully on missing/odd shapes', async () => {
    const { classifyClaudeJsonlEvent } = await import('../src/agent/drivers/claude-tui.ts');
    // Labels assistant tool_use / text / thinking and user tool_result.
    expect(classifyClaudeJsonlEvent({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } })).toBe('assistant:tool_use');
    expect(classifyClaudeJsonlEvent({ type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'text' }] } })).toBe('assistant:thinking');
    expect(classifyClaudeJsonlEvent({ type: 'assistant', message: { content: [{ type: 'text' }] } })).toBe('assistant:text');
    // The freeze signature: a tool_result lands, then the model never resumes.
    expect(classifyClaudeJsonlEvent({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe('user:tool_result');

    // Degrades gracefully on missing/odd shapes.
    expect(classifyClaudeJsonlEvent({ type: 'system' })).toBe('system');
    expect(classifyClaudeJsonlEvent({ type: 'user', message: { content: 'plain string' } })).toBe('user');
    expect(classifyClaudeJsonlEvent({})).toBe('unknown');
    expect(classifyClaudeJsonlEvent(null)).toBe('unknown');
  });
});

describe('Claude TUI driver — chunked text streaming', () => {
  // The TUI driver replaces print-mode's per-token deltas with a simulated
  // stream: JSONL writes complete content blocks, the driver chunks them out
  // to `onText` over time. These tests exercise the helpers directly because
  // wiring real PTY + claude into a unit test is out of scope.
  //
  // We reach into the module via dynamic import so the helpers we declare
  // here mirror the ones in claude-tui.ts. If the public contract changes
  // (chunk size, separator, thinking-vs-text routing) these break loudly.

  function makeBuf() {
    return { trueText: '', displayedLen: 0, timer: null as any };
  }

  function apply(s: any, msg: any, buf: { trueText: string }): void {
    if (!msg || msg.model === '<synthetic>') return;
    const contents = Array.isArray(msg.content) ? msg.content : [];
    let appendText = '';
    let appendThinking = '';
    for (const block of contents) {
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        appendText += (appendText ? '\n\n' : '') + block.text;
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        appendThinking += (appendThinking ? '\n\n' : '') + block.thinking;
      }
    }
    if (appendText) buf.trueText = buf.trueText ? `${buf.trueText}\n\n${appendText}` : appendText;
    if (appendThinking) s.thinking = s.thinking ? `${s.thinking}\n\n${appendThinking}` : appendThinking;
  }

  it('routes text/thinking, skips synthetic, and joins segments with paragraph breaks', () => {
    // Routes text to the buffer (slow) and thinking straight to state (instant).
    {
      const s = { text: '', thinking: '' };
      const buf = makeBuf();
      apply(s, {
        model: 'claude-haiku',
        content: [
          { type: 'thinking', thinking: 'pondering...' },
          { type: 'text', text: 'Hello, world!' },
        ],
      }, buf);
      // Thinking lands instantly; text is buffered for the chunker.
      expect(s.thinking).toBe('pondering...');
      expect(s.text).toBe('');
      expect(buf.trueText).toBe('Hello, world!');
    }

    // Skips <synthetic> messages so resume-noise does not leak into the buffer.
    {
      const s = { text: '', thinking: '' };
      const buf = makeBuf();
      apply(s, {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
      }, buf);
      expect(buf.trueText).toBe('');
      expect(s.text).toBe('');
    }

    // Appends consecutive assistant text segments with paragraph break.
    {
      const s = { text: '', thinking: '' };
      const buf = makeBuf();
      apply(s, { model: 'haiku', content: [{ type: 'text', text: 'first' }] }, buf);
      apply(s, { model: 'haiku', content: [{ type: 'text', text: 'second' }] }, buf);
      expect(buf.trueText).toBe('first\n\nsecond');
    }

    // Mid-event multiple text blocks join with paragraph break inside one event.
    {
      const s = { text: '', thinking: '' };
      const buf = makeBuf();
      apply(s, {
        model: 'haiku',
        content: [
          { type: 'text', text: 'intro' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          { type: 'text', text: 'after-tool' },
        ],
      }, buf);
      expect(buf.trueText).toBe('intro\n\nafter-tool');
    }
  });
});

describe('Claude TUI driver — hook script', () => {
  // The hook script is written to a temp dir and run by the real `claude`
  // process as a subprocess each time a SessionStart / UserPromptSubmit /
  // Stop hook fires. We exercise it here in isolation by re-creating the
  // same scaffolding the driver builds and piping a synthetic hook payload
  // into a freshly spawned `node` subprocess. That keeps the test free of
  // node-pty / claude dependencies while still verifying the wire format
  // the parent's polling loop relies on.
  let workDir: string;
  let hookPath: string;
  let statePath: string;

  beforeEach(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-hook-test-'));
    hookPath = path.join(workDir, 'hook.cjs');
    statePath = path.join(workDir, 'state.json');
    // Reproduce the same constant the driver writes (kept as a duplicate
    // here on purpose — if the driver's script body changes, this test
    // breaks loudly until updated, guarding the wire format).
    const HOOK_SCRIPT = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const event = process.argv[2] || "";
const stateFile = process.argv[3] || "";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  let payload = {};
  try { payload = stdin ? JSON.parse(stdin) : {}; } catch (_) {}
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (_) {}
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({ event, at: Date.now() });
  const sid = typeof payload.session_id === "string" ? payload.session_id : null;
  const tpath = typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  if (sid) state.sessionId = sid;
  if (tpath) state.transcriptPath = tpath;
  if (event === "SessionStart") state.sessionStartedAt = Date.now();
  else if (event === "UserPromptSubmit") state.promptSubmittedAt = Date.now();
  else if (event === "Stop") state.stoppedAt = Date.now();
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (_) {}
  process.stdout.write(JSON.stringify({ continue: true }) + "\\n");
});
`;
    fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
    fs.writeFileSync(statePath, JSON.stringify({ events: [] }));
  });

  afterEach(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  async function runHook(event: string, payload: object): Promise<string> {
    const { spawn } = await import('node:child_process');
    return new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, [hookPath, event, statePath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString('utf8'); });
      proc.on('error', reject);
      proc.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`hook exited ${code}`)));
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    });
  }

  it('records lifecycle events and survives empty stdin', async () => {
    // --- Records SessionStart + UserPromptSubmit + Stop into the shared state file. ---
    const sessionId = 'abc-123-uuid';
    const transcriptPath = path.join(workDir, 'fake.jsonl');

    const out1 = await runHook('SessionStart', { session_id: sessionId, transcript_path: transcriptPath });
    expect(JSON.parse(out1.trim())).toEqual({ continue: true });
    let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.sessionId).toBe(sessionId);
    expect(state.transcriptPath).toBe(transcriptPath);
    expect(state.sessionStartedAt).toBeGreaterThan(0);

    await runHook('UserPromptSubmit', { session_id: sessionId, transcript_path: transcriptPath, prompt: 'hi' });
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.promptSubmittedAt).toBeGreaterThan(0);

    await runHook('Stop', { session_id: sessionId, transcript_path: transcriptPath });
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.stoppedAt).toBeGreaterThan(0);
    expect(state.events.map((e: any) => e.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);

    // --- Survives an empty stdin (returns continue:true and does not crash state). ---
    // Reset the state file to the same pristine shape beforeEach would, so the
    // empty-stdin path is exercised from a clean slate (not the lifecycle above).
    fs.writeFileSync(statePath, JSON.stringify({ events: [] }));
    const { spawn } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, [hookPath, 'Stop', statePath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let captured = '';
      proc.stdout.on('data', d => { captured += d.toString('utf8'); });
      proc.on('exit', code => code === 0 ? resolve(captured) : reject(new Error(`exit ${code}`)));
      proc.stdin.end(); // no payload
    });
    expect(JSON.parse(out.trim())).toEqual({ continue: true });
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(finalState.stoppedAt).toBeGreaterThan(0);
  });
});

describe('Claude TUI driver — readJsonlIncrement', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-jsonl-')), 'session.jsonl');
  });

  afterEach(() => {
    try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
  });

  it('exposes the incremental tail used to follow a growing JSONL', async () => {
    // We test the helper indirectly through its observable contract: write
    // partial JSONL, advance the offset, append more, verify the second read
    // picks up only the new lines. We use a tiny in-test reimplementation
    // because the helper is intentionally private to claude-tui.ts.
    function readIncrement(filePath: string, fromOffset: number): { offset: number; lines: string[] } {
      const stat = fs.statSync(filePath);
      if (stat.size <= fromOffset) return { offset: fromOffset, lines: [] };
      const buf = Buffer.alloc(stat.size - fromOffset);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, fromOffset);
      fs.closeSync(fd);
      const chunk = buf.toString('utf8');
      const endsWithNewline = chunk[chunk.length - 1] === '\n';
      const segments = chunk.split('\n');
      if (endsWithNewline) {
        segments.pop();
        return { offset: stat.size, lines: segments };
      }
      const last = segments.pop() || '';
      return { offset: stat.size - Buffer.byteLength(last, 'utf8'), lines: segments };
    }

    fs.writeFileSync(tmpFile, '{"type":"user","seq":1}\n{"type":"assistant","seq":2}\n');
    let { offset, lines } = readIncrement(tmpFile, 0);
    expect(lines).toEqual(['{"type":"user","seq":1}', '{"type":"assistant","seq":2}']);

    // Append a partial line (no trailing newline) — should be held back.
    fs.appendFileSync(tmpFile, '{"type":"assist');
    const second = readIncrement(tmpFile, offset);
    expect(second.lines).toEqual([]); // partial line not yet flushed
    expect(second.offset).toBe(offset);

    // Complete the line and append another full one.
    fs.appendFileSync(tmpFile, 'ant","seq":3}\n{"type":"user","seq":4}\n');
    const third = readIncrement(tmpFile, offset);
    expect(third.lines).toEqual(['{"type":"assistant","seq":3}', '{"type":"user","seq":4}']);
  });
});

describe('Claude TUI driver — background sub-agent + background Bash lifecycle (run_in_background)', () => {
  async function makeState() {
    const { createClaudeStreamState } = await import('../src/agent/drivers/claude.ts');
    return createClaudeStreamState({ sessionId: null, model: 'claude-opus-4-8' } as any);
  }

  it('tracks bg agent launch-ack/completion, sidecar+killed, foreground done, hook path, bg-Bash pending+resolution, and ignores non-notifications', async () => {
    const { claudeParse, pendingClaudeBackgroundAgentCount, extractClaudeTaskNotification }
      = await import('../src/agent/drivers/claude.ts');
    const { applyHookToolEvent } = await import('../src/agent/drivers/claude-tui.ts');

    // --- Keeps a backgrounded agent "running" through its launch-ack tool_result, completes it on <task-notification>. ---
    {
      const s = await makeState();
      claudeParse({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', id: 'toolu_bg1', name: 'Agent',
            input: { description: 'Build module A', subagent_type: 'general-purpose', run_in_background: true },
          }],
        },
      }, s);
      expect(s.subAgents.get('toolu_bg1')?.status).toBe('running');
      expect(pendingClaudeBackgroundAgentCount(s)).toBe(1);

      // Immediate tool_result = launch ack — must NOT flip the card to done.
      claudeParse({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg1', content: 'Agent launched in background.' }] },
      }, s);
      expect(s.subAgents.get('toolu_bg1')?.status).toBe('running');
      expect(pendingClaudeBackgroundAgentCount(s)).toBe(1);

      // Real completion arrives later as a task-notification user event.
      claudeParse({
        type: 'user',
        timestamp: '2026-06-02T10:05:07.605Z',
        message: {
          content: '<task-notification>\n<task-id>a83657bb8bfba7de0</task-id>\n'
            + '<tool-use-id>toolu_bg1</tool-use-id>\n<status>completed</status>\n'
            + '<summary>done</summary>\n</task-notification>',
        },
      }, s);
      expect(s.subAgents.get('toolu_bg1')?.status).toBe('done');
      expect(pendingClaudeBackgroundAgentCount(s)).toBe(0);
      expect(s.lastTaskNotificationAt).toBe(Date.parse('2026-06-02T10:05:07.605Z'));
    }

    // --- Resolves notifications without <tool-use-id> via the sidecar task-id mapping, and maps killed → failed. ---
    {
      const s = await makeState();
      claudeParse({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_bg2', name: 'Task', input: { description: 'B', run_in_background: true } }] },
      }, s);
      s.bgTaskIdToToolUse.set('abab6f3fdb6d53772', 'toolu_bg2'); // sidecar meta discovery

      claudeParse({
        type: 'user',
        message: {
          content: [{
            type: 'text',
            text: '<task-notification>\n<task-id>abab6f3fdb6d53772</task-id>\n<status>killed</status>\n</task-notification>',
          }],
        },
      }, s);
      expect(pendingClaudeBackgroundAgentCount(s)).toBe(0);
      expect(s.subAgents.get('toolu_bg2')?.status).toBe('failed');
    }

    // --- Foreground agents still flip to done on their tool_result. ---
    {
      const s = await makeState();
      claudeParse({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'fg' } }] },
      }, s);
      claudeParse({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'full result' }] },
      }, s);
      expect(s.subAgents.get('toolu_fg')?.status).toBe('done');
      expect(pendingClaudeBackgroundAgentCount(s)).toBe(0);
    }

    // --- Hook path: PreToolUse registers the background launch, PostToolUse ack keeps it running. ---
    {
      const s = await makeState();
      applyHookToolEvent({
        event: 'PreToolUse', tool_use_id: 'toolu_hk', tool_name: 'Agent',
        tool_input: { description: 'C', run_in_background: true },
      }, s);
      expect(pendingClaudeBackgroundAgentCount(s)).toBe(1);
      expect(s.subAgents.get('toolu_hk')?.status).toBe('running');

      applyHookToolEvent({
        event: 'PostToolUse', tool_use_id: 'toolu_hk', tool_name: 'Agent',
        tool_input: { description: 'C', run_in_background: true },
        tool_response: 'Agent launched in background',
      }, s);
      expect(s.subAgents.get('toolu_hk')?.status).toBe('running');
      expect(pendingClaudeBackgroundAgentCount(s)).toBe(1);
    }

    // --- extractClaudeTaskNotification ignores non-notification user content. ---
    expect(extractClaudeTaskNotification('plain user text')).toBeNull();
    expect(extractClaudeTaskNotification([{ type: 'text', text: '<system-reminder>x</system-reminder>' }])).toBeNull();
    expect(extractClaudeTaskNotification(undefined)).toBeNull();

    // ===== Background Bash — pending registration + notification resolution =====
    {
      const {
        registerClaudeBackgroundBashLaunch, pendingClaudeBackgroundBashCount,
        applyClaudeTaskNotification, extractClaudeBackgroundTaskId,
      } = await import('../src/agent/drivers/claude.ts');

      // Counts a backgrounded Bash launch as pending background work.
      {
        const s: any = {};
        registerClaudeBackgroundBashLaunch(s, 'toolu_bash1');
        expect(pendingClaudeBackgroundAgentCount(s)).toBe(1);   // 总 pending(hold 判定用)
        expect(pendingClaudeBackgroundBashCount(s)).toBe(1);    // bash 专项(TTL 选择用)
      }

      // Resolves a bash <task-notification> via the launch-ack task-id mapping.
      {
        const s: any = { recentActivity: [] };
        registerClaudeBackgroundBashLaunch(s, 'toolu_bash2');
        // launch ack(tool_result)→ 提取 task id 并建映射(call-site 行为的最小重演)
        const taskId = extractClaudeBackgroundTaskId(
          'Command running in background with ID: bash_7\nOutput will stream to the transcript.');
        expect(taskId).toBe('bash_7');
        s.bgTaskIdToToolUse.set(taskId!, 'toolu_bash2');
        // 完成通知只带 task-id,不带 tool-use-id(bash 常态)→ 仍应清零 pending
        applyClaudeTaskNotification(s, { taskId: 'bash_7', toolUseId: null, status: 'completed' }, Date.now());
        expect(pendingClaudeBackgroundAgentCount(s)).toBe(0);
      }

      // extractClaudeBackgroundTaskId ignores non-background results.
      expect(extractClaudeBackgroundTaskId('regular output, ID: 42 mentioned casually')).toBeNull();
      expect(extractClaudeBackgroundTaskId([{ type: 'text', text: 'no ids here' }])).toBeNull();
    }
  });
});

describe('Claude TUI driver — decideClaudeTuiStop + decideClaudeTuiStall watchdogs', () => {
  const MIN = 60_000;

  it('decideClaudeTuiStop gating + phantom-hold TTL, then decideClaudeTuiStall watchdog (fresh/threshold/mid-tool/custom/dead-PTY)', async () => {
    const { decideClaudeTuiStop } = await import('../src/agent/drivers/claude-tui.ts');

    // === Stop gating ===
    // Holds while background agents are pending, regardless of Stop freshness.
    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 3,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 900, now: 2_000,
    })).toBe('hold-background');

    // Terminates immediately on a normal turn (no background work ever).
    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 0,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 900, now: 1_200,
    })).toBe('terminate');

    // Holds for the wrap-up segment when the Stop predates the last notification.
    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 0,
      lastTaskNotificationAt: 5_000, lastJsonlEventAt: 5_100, now: 6_000,
    })).toBe('hold-resettle');

    // Accepts a stale Stop after the resettle quiet window expires.
    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 0,
      lastTaskNotificationAt: 5_000, lastJsonlEventAt: 5_100, now: 5_100 + 30_000,
    })).toBe('terminate');

    // Terminates on a fresh Stop fired after the last notification.
    expect(decideClaudeTuiStop({
      stoppedAt: 9_000, pendingBackgroundAgents: 0,
      lastTaskNotificationAt: 5_000, lastJsonlEventAt: 8_900, now: 9_100,
    })).toBe('terminate');

    // === Phantom-hold TTL ===
    // Keeps holding while background agents emit hook/sidecar traffic.
    expect(decideClaudeTuiStop({
      stoppedAt: 100 * MIN, pendingBackgroundAgents: 2,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 100 * MIN,
      lastHookOrSidecarEventAt: 119 * MIN,           // 1m ago — agents alive
      now: 120 * MIN,
    })).toBe('hold-background');

    // Releases a phantom hold once every channel is quiet past the TTL.
    // Counted pending, but nothing (JSONL / notification / hooks / sidecars)
    // has moved for 11m — the completion was lost; treat the Stop as final.
    expect(decideClaudeTuiStop({
      stoppedAt: 100 * MIN, pendingBackgroundAgents: 1,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 100 * MIN,
      lastHookOrSidecarEventAt: 100 * MIN,
      now: 111 * MIN,
    })).toBe('terminate');

    // Honours a custom holdQuietTtlMs.
    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 1,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 1_000,
      lastHookOrSidecarEventAt: 1_000, holdQuietTtlMs: 5_000,
      now: 7_000,
    })).toBe('terminate');

    // === decideClaudeTuiStall: waits on fresh signals, stalls past threshold,
    //     extends for mid-tool, honours custom thresholds, fast-stalls on dead PTY ===
    const { decideClaudeTuiStall } = await import('../src/agent/drivers/claude-tui.ts');

    // Waits while any liveness signal is fresh.
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 99 * MIN, pendingToolCount: 0,
    })).toBe('wait');

    // Waits through a long max-effort inference gap (under the quiet threshold).
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 100 * MIN - 9 * MIN, pendingToolCount: 0,
    })).toBe('wait');

    // Stalls once everything has been quiet past the threshold with no pending tool.
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 100 * MIN - 11 * MIN, pendingToolCount: 0,
    })).toBe('stall');

    // Extends the threshold while a hook-reported tool is mid-execution.
    // 11m silent but a tool is still running (e.g. blocking TaskOutput) — hold.
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 100 * MIN - 11 * MIN, pendingToolCount: 1,
    })).toBe('wait');
    // Past the pending-tool ceiling the freeze hit mid-execution — stall.
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 100 * MIN - 31 * MIN, pendingToolCount: 1,
    })).toBe('stall');

    // Honours custom thresholds.
    expect(decideClaudeTuiStall({
      now: 10_000, lastProgressAt: 0, pendingToolCount: 0, quietMs: 5_000,
    })).toBe('stall');
    expect(decideClaudeTuiStall({
      now: 10_000, lastProgressAt: 0, pendingToolCount: 2, pendingToolMs: 20_000,
    })).toBe('wait');

    // PTY fast path — the 2.1.160 hard freeze (event loop dead, zero repaint).
    // Stalls fast when the PTY itself has been byte-silent past ptyDeadMs:
    // 4m of total silence (PTY + signals): hard freeze → stall well before the
    // 10m quiet threshold, even with a pending tool (which alone would allow 30m).
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 96 * MIN, pendingToolCount: 1,
      lastPtyDataAt: 96 * MIN,
    })).toBe('stall');

    // Does NOT fast-stall while the TUI is still painting (long thinking / long Bash).
    // Signals quiet 9m (long inference) but the spinner repainted 1s ago — wait.
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 91 * MIN, pendingToolCount: 0,
      lastPtyDataAt: 100 * MIN - 1_000,
    })).toBe('wait');
    // Same but mid-tool: a healthy long foreground command keeps painting — wait.
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 80 * MIN, pendingToolCount: 1,
      lastPtyDataAt: 100 * MIN - 1_000,
    })).toBe('wait');

    // Falls back to the slow thresholds when the PTY signal is unavailable.
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 96 * MIN, pendingToolCount: 0,
      lastPtyDataAt: 0,
    })).toBe('wait');

    // Honours a custom ptyDeadMs.
    expect(decideClaudeTuiStall({
      now: 100_000, lastProgressAt: 0, pendingToolCount: 0,
      lastPtyDataAt: 10_000, ptyDeadMs: 60_000,
    })).toBe('stall');
  });
});

describe('Live preview toolCalls — expandable tool rows during a running turn', () => {
  it('claudeParse + hook path register tool input/result detail, with plan/sub-agent tools filtered out', async () => {
    const { claudeParse, createClaudeStreamState } = await import('../src/agent/drivers/claude.ts');
    const { applyHookToolEvent } = await import('../src/agent/drivers/claude-tui.ts');
    const { buildStreamPreviewMeta } = await import('../src/agent/utils.ts');

    // --- claudeParse registers input detail on tool_use and result detail on tool_result, surfaced via buildStreamPreviewMeta. ---
    {
      const s = createClaudeStreamState({ sessionId: null, model: 'claude-opus-4-8' } as any);

      claudeParse({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', id: 'toolu_x1', name: 'Bash',
            input: { command: 'grep -rn "needle" src/ | head -5', description: 'Search for needle' },
          }],
        },
      }, s);

      let meta = buildStreamPreviewMeta(s);
      expect(meta.toolCalls).toHaveLength(1);
      expect(meta.toolCalls![0]).toMatchObject({
        id: 'toolu_x1',
        name: 'Bash',
        status: 'running',
        input: 'grep -rn "needle" src/ | head -5',
      });
      expect(meta.toolCalls![0].result).toBeNull();

      claudeParse({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x1', content: 'src/a.ts:3: needle' }] },
      }, s);

      meta = buildStreamPreviewMeta(s);
      expect(meta.toolCalls![0]).toMatchObject({ status: 'done', result: 'src/a.ts:3: needle' });
    }

    // --- Hook path mirrors the same lifecycle and plan/sub-agent tools stay out of toolCalls. ---
    {
      const s = createClaudeStreamState({ sessionId: null, model: 'claude-opus-4-8' } as any);

      applyHookToolEvent({
        event: 'PreToolUse', tool_use_id: 'toolu_h1', tool_name: 'Read',
        tool_input: { file_path: '/tmp/x.ts' },
      }, s);
      applyHookToolEvent({
        event: 'PreToolUse', tool_use_id: 'toolu_plan', tool_name: 'TodoWrite',
        tool_input: { todos: [{ content: 'step', status: 'pending' }] },
      }, s);
      applyHookToolEvent({
        event: 'PreToolUse', tool_use_id: 'toolu_sub', tool_name: 'Agent',
        tool_input: { description: 'child' },
      }, s);
      applyHookToolEvent({
        event: 'PostToolUse', tool_use_id: 'toolu_h1', tool_name: 'Read',
        tool_input: { file_path: '/tmp/x.ts' },
        tool_response: 'file contents here',
      }, s);

      const meta = buildStreamPreviewMeta(s);
      // Only the Read row — TodoWrite feeds the plan card, Agent has its own card.
      expect(meta.toolCalls).toHaveLength(1);
      expect(meta.toolCalls![0]).toMatchObject({
        id: 'toolu_h1', name: 'Read', status: 'done', result: 'file contents here',
      });
      expect(meta.toolCalls![0].input).toContain('/tmp/x.ts');
    }
  });
});
