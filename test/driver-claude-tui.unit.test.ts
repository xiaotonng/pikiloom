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
    await withEnv({ PIKILOOM_CLAUDE_PRINT: undefined, PIKILOOM_CLAUDE_TUI: undefined }, () => {
      expect(module.isClaudePrintModeForced()).toBe(false);
    });
    await withEnv({ PIKILOOM_CLAUDE_PRINT: '', PIKILOOM_CLAUDE_TUI: '' }, () => {
      expect(module.isClaudePrintModeForced()).toBe(false);
    });

    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', ' 1 ']) {
      await withEnv({ PIKILOOM_CLAUDE_PRINT: v, PIKILOOM_CLAUDE_TUI: undefined }, () => {
        expect(module.isClaudePrintModeForced()).toBe(true);
      });
    }

    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'No', ' off ']) {
      await withEnv({ PIKILOOM_CLAUDE_PRINT: undefined, PIKILOOM_CLAUDE_TUI: v }, () => {
        expect(module.isClaudePrintModeForced()).toBe(true);
      });
    }

    await withEnv({ PIKILOOM_CLAUDE_PRINT: undefined, PIKILOOM_CLAUDE_TUI: '1' }, () => {
      expect(module.isClaudePrintModeForced()).toBe(false);
    });
  });
});

describe('Claude TUI driver — startup-failure fallback contract', () => {
  let tmpDir: string;
  const onText = vi.fn();

  beforeEach(() => {
    onText.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-claude-tui-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('throws (not returns) when pty.spawn cannot find the claude binary — lets the dispatcher fall back to -p', async () => {
    const isolatedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-no-claude-'));
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
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let tmpDir: string;
  const onText = vi.fn();

  beforeEach(() => {
    onText.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-tui-promote-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  async function runWithBrokenSpawn(sessionId: string | null, onSessionId: (id: string) => void) {
    const isolatedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-no-claude-'));
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
      ]).catch(() => {  });
    } finally {
      try { fs.rmSync(isolatedPath, { recursive: true, force: true }); } catch {}
    }
  }

  it('fires onSessionId for a new (pending) session, but not when resuming a native session', async () => {
    const seenNew: string[] = [];
    await runWithBrokenSpawn(null, id => seenNew.push(id));
    expect(seenNew.length).toBeGreaterThan(0);
    expect(seenNew[0]).toMatch(UUID_RE);

    const seenResume: string[] = [];
    await runWithBrokenSpawn('f7e0b5a8-ff07-45a4-8282-1a1bb99340ac', id => seenResume.push(id));
    expect(seenResume).toEqual([]);
  }, 20_000);
});

describe('Claude TUI driver — terminal limit notices', () => {
  it('detects synthetic + screen-only limit notices but ignores ordinary rate-limit prose', async () => {
    const { detectClaudeTuiTerminalLimitNotice } = await import('../src/agent/drivers/claude-tui.ts');
    const notice = detectClaudeTuiTerminalLimitNotice({
      model: '<synthetic>',
      content: [{ type: 'text', text: "You've hit your session limit · resets 9:40pm (Asia/Shanghai)" }],
    });
    expect(notice).toContain("You've hit your session limit");
    expect(detectClaudeTuiTerminalLimitNotice(
      "You're now using usage credits · Your session limit resets 3pm(Asia/Shanghai)",
    )).toContain('usage credits');
    expect(detectClaudeTuiTerminalLimitNotice('Usage limit reached. Please try again later.')).toContain('Usage limit reached');
    expect(detectClaudeTuiTerminalLimitNotice('Please explain how rate limit handling works in this codebase.')).toBeNull();
  });

  it('arbitrates a notice by turn liveness: output or post-notice activity → info, dead turn → fatal', async () => {
    const { resolveClaudeTuiLimitOutcome } = await import('../src/agent/drivers/claude-tui.ts');
    const noticeAt = 1_000_000;
    const banner = "You're now using usage credits · Your session limit resets 3pm(Asia/Shanghai)";

    expect(resolveClaudeTuiLimitOutcome({
      noticeText: null, noticeAt: 0, lastSubstantiveEventAt: 0, hasOutputText: false,
    })).toBe('none');

    expect(resolveClaudeTuiLimitOutcome({
      noticeText: banner, noticeAt, lastSubstantiveEventAt: 0, hasOutputText: true,
    })).toBe('info');

    expect(resolveClaudeTuiLimitOutcome({
      noticeText: banner, noticeAt, lastSubstantiveEventAt: noticeAt + 5_000, hasOutputText: false,
    })).toBe('info');

    expect(resolveClaudeTuiLimitOutcome({
      noticeText: "You've hit your session limit · resets 9:40pm (Asia/Shanghai)",
      noticeAt, lastSubstantiveEventAt: noticeAt - 60_000, hasOutputText: false,
    })).toBe('fatal');
  });
});

describe('Claude TUI driver — selected-model-unavailable detection', () => {
  it('detects the banner from clean -p text AND the whitespace-mangled TUI screen, but not ordinary prose', async () => {
    const { detectClaudeModelError } = await import('../src/agent/utils.ts');
    expect(detectClaudeModelError(
      "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it. Run --model to pick a different model.",
    )).toBe(true);
    expect(detectClaudeModelError(
      "⏺There's an issuewiththeselectedmodel(claude-fable-5).Itmaynotexistor\nyoumaynothaveaccesstoit.Run/modeltopickadifferentmodel.",
    )).toBe(true);
    expect(detectClaudeModelError('Please explain why the selected model failed to load in this codebase.')).toBe(false);
    expect(detectClaudeModelError('The service account may not have access to the storage bucket.')).toBe(false);
    expect(detectClaudeModelError('')).toBe(false);
    expect(detectClaudeModelError(null)).toBe(false);
  });

  it('composes a user-facing message with and without a model id', async () => {
    const { claudeModelErrorMessage } = await import('../src/agent/utils.ts');
    const withId = claudeModelErrorMessage('claude-fable-5');
    expect(withId).toContain('(claude-fable-5)');
    expect(withId.toLowerCase()).toContain('unavailable');
    const noId = claudeModelErrorMessage(null);
    expect(noId).not.toContain('(');
    expect(noId.toLowerCase()).toContain('unavailable');
  });
});

describe('Claude TUI driver — bypass-permissions prompt auto-answer', () => {
  it('detects spaceless + spaced + real-byte bypass frames, ignores prose/partial/empty inputs', async () => {
    const { detectClaudeBypassPrompt } = await import('../src/agent/drivers/claude-tui.ts');

    const realScreen =
      '\x1b[2J\x1b[H\x1b[200GWARNING:ClaudeCoderunninginBypassPermissionsmode\r\n\r\n' +
      'InBypassPermissionsmode,ClaudeCodewillnotaskforyourapproval\r\n\r\n' +
      '\x1b[36m❯1.No,exit\x1b[0m\r\n2.Yes,Iaccept\r\n\r\nEntertoconfirm·Esctocancel\r\n';
    expect(detectClaudeBypassPrompt(realScreen)).toBe(true);

    const spaced =
      '\x1b[1m WARNING: Claude Code running in Bypass Permissions mode\x1b[0m\r\n\r\n' +
      '\x1b[36m❯ 1. No, exit\x1b[0m\r\n   2. Yes, I accept\r\n';
    expect(detectClaudeBypassPrompt(spaced)).toBe(true);

    expect(detectClaudeBypassPrompt('Explain how Bypass Permissions mode works in Claude Code.')).toBe(false);
    expect(detectClaudeBypassPrompt('1. No, exit\n2. Yes, I accept')).toBe(false);
    expect(detectClaudeBypassPrompt('Choose the text style that looks best with your terminal')).toBe(false);
    expect(detectClaudeBypassPrompt('')).toBe(false);
    expect(detectClaudeBypassPrompt(null)).toBe(false);
    expect(detectClaudeBypassPrompt(undefined)).toBe(false);

    const REAL_BYPASS_FRAME_B64 =
      'GzcbW3IbOBtbPzI1aBtbPzI1bBtbPzIwMDRoG1s/MTAwNGgbWz8yMDMxaBtbPHUbWz4xdRtbPjQ7Mm0bWz8yMDI2aA0NChtbMzg7MjsyNTU7MTA3OzEyOG3ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAbWzM5bQ0NChtbM0cbWzM4OzI7MjU1OzEwNzsxMjhtG1sxbVdBUk5JTkc6G1sxMkdDbGF1ZGUbWzE5R0NvZGUbWzI0R3J1bm5pbmcbWzMyR2luG1szNUdCeXBhc3MbWzQyR1Blcm1pc3Npb25zG1s1NEdtb2RlG1syMm0bWzM5bQ0NCg0NChtbM0dJbhtbNkdCeXBhc3MbWzEzR1Blcm1pc3Npb25zG1syNUdtb2RlLBtbMzFHQ2xhdWRlG1szOEdDb2RlG1s0M0d3aWxsG1s0OEdub3QbWzUyR2FzaxtbNTZHZm9yG1s2MEd5b3VyG1s2NUdhcHByb3ZhbA0NChtbM0diZWZvcmUbWzEwR3J1bm5pbmcbWzE4R3BvdGVudGlhbGx5G1szMEdkYW5nZXJvdXMbWzQwR2NvbW1hbmRzLg0NChtbM0dUaGlzG1s4R21vZGUbWzEzR3Nob3VsZBtbMjBHb25seRtbMjVHYmUbWzI4R3VzZWQbWzMzR2luG1szNkdhG1szOEdzYW5kYm94ZWQbWzQ4R2NvbnRhaW5lci9WTRtbNjFHdGhhdBtbNjZHaGFzDQ0KG1szR3Jlc3RyaWN0ZWQbWzE0R2ludGVybmV0G1syM0dhY2Nlc3MbWzMwR2FuZBtbMzRHY2FuG1szOEdlYXNpbHkbWzQ1R2JlG1s0OEdyZXN0b3JlZBtbNTdHaWYbWzYwR2RhbWFnZWQuDQ0KDQ0KG1szR0J5G1s2R3Byb2NlZWRpbmcsG1sxOEd5b3UbWzIyR2FjY2VwdBtbMjlHYWxsG1szM0dyZXNwb25zaWJpbGl0eRtbNDhHZm9yG1s1MkdhY3Rpb25zG1s2MEd0YWtlbhtbNjZHd2hpbGUbWzcyR3J1bm5pbmcNDQobWzNHaW4bWzZHQnlwYXNzG1sxM0dQZXJtaXNzaW9ucxtbMjVHbW9kZS4NDQoNDQobWzNHG104O2lkPXpheG1kYTtodHRwczovL2NvZGUuY2xhdWRlLmNvbS9kb2NzL2VuL3NlY3VyaXR5B2h0dHBzOi8vY29kZS5jbGF1ZGUuY29tL2RvY3MvZW4vc2VjdXJpdHkbXTg7OwcNDQoNDQobWzNHG1szODsyOzE3NzsxODU7MjQ5beKdrxtbNUcbWzM4OzI7MTUzOzE1MzsxNTNtMS4bWzhHG1szODsyOzE3NzsxODU7MjQ5bU5vLBtbMTJHZXhpdBtbMzltDQ0KG1s1RxtbMzg7MjsxNTM7MTUzOzE1M20yLhtbOEcbWzM5bVllcywbWzEzR0kbWzE1R2FjY2VwdA0NCg0NChtbM0cbWzM4OzI7MTUzOzE1MzsxNTNtG1szbUVudGVyG1s5R3RvG1sxMkdjb25maXJtG1syMEfCtxtbMjJHRXNjG1syNkd0bxtbMjlHY2FuY2VsG1syM20bWzM5bQ0NChtbMkMbWzRBG1s/MjAyNmw=';
    const realFrame = Buffer.from(REAL_BYPASS_FRAME_B64, 'base64').toString('utf8');
    expect(detectClaudeBypassPrompt(realFrame)).toBe(true);
  });
});

describe('Claude TUI driver — mid-turn permission prompt auto-answer', () => {
  it('detects the proceed dialog (spaceless + spaced), stays disjoint from bypass + prose', async () => {
    const { detectClaudeProceedPrompt, detectClaudeBypassPrompt } =
      await import('../src/agent/drivers/claude-tui.ts');

    const realScreen =
      '\x1b[2J\x1b[H\x1b[36mPermissionruleBash(gittag:*)requiresconfirmationforthiscommand.\r\n' +
      '/permissionstoupdaterules\r\n\r\nDoyouwanttoproceed?\r\n' +
      '\x1b[36m❯1.Yes\x1b[0m\r\n2.Yes,anddon’taskagainfor:node-p\r\n3.No\r\n\r\n' +
      'Esctocancel·Tabtoamend·ctrl+etoexplain\r\n';
    expect(detectClaudeProceedPrompt(realScreen)).toBe(true);

    const spaced =
      'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don’t ask again for: git tag\r\n  3. No\r\n\r\nEsc to cancel · Tab to amend\r\n';
    expect(detectClaudeProceedPrompt(spaced)).toBe(true);

    const truncatedFooter =
      'Dangerousrmoperationonpossibly-emptyvariablepath:"$DST/$1.svg"\r\nDoyouwanttoproceed?\r\n' +
      '❯1.Yes\r\n2.No\r\nsctocancel·Tabtoamend·ctrl+etoexplain\r\n';
    expect(detectClaudeProceedPrompt(truncatedFooter)).toBe(true);

    const bypass =
      '\x1b[1mWARNING: Claude Code running in Bypass Permissions mode\x1b[0m\r\n' +
      '\x1b[36m❯ 1. No, exit\x1b[0m\r\n  2. Yes, I accept\r\nEnter to confirm · Esc to cancel\r\n';
    expect(detectClaudeProceedPrompt(bypass)).toBe(false);
    expect(detectClaudeBypassPrompt(bypass)).toBe(true);

    expect(detectClaudeProceedPrompt('Do you want to proceed? (just prose, no menu)')).toBe(false);
    expect(detectClaudeProceedPrompt('❯ 1. Yes\n2. No\nEsc to cancel')).toBe(false);
    expect(detectClaudeProceedPrompt('The CLI asks "Do you want to proceed?" with 1. Yes / 2. No.')).toBe(false);
    expect(detectClaudeProceedPrompt('')).toBe(false);
    expect(detectClaudeProceedPrompt(null)).toBe(false);
    expect(detectClaudeProceedPrompt(undefined)).toBe(false);
  });
});

describe('Claude TUI driver — screen state classifier (classifyClaudeScreen)', () => {
  it('classifies bypass / confirm / plan / idle / model-error / unknown with the right affirmativeKey', async () => {
    const { classifyClaudeScreen } = await import('../src/agent/drivers/claude-tui.ts');

    const bypass =
      '\x1b[1mWARNING: Claude Code running in Bypass Permissions mode\x1b[0m\r\n' +
      '\x1b[36m❯ 1. No, exit\x1b[0m\r\n  2. Yes, I accept\r\nEnter to confirm · Esc to cancel\r\n';
    expect(classifyClaudeScreen(bypass)).toMatchObject({ state: 'bypass-startup', affirmativeKey: '2' });

    const confirm =
      'PermissionruleBash(gittag:*)requiresconfirmation\r\nDoyouwanttoproceed?\r\n❯1.Yes\r\n2.No\r\nEsctocancel\r\n';
    expect(classifyClaudeScreen(confirm)).toMatchObject({ state: 'confirm-prompt', affirmativeKey: '1' });
    expect(classifyClaudeScreen('Doyouwanttoproceed?\r\n❯1.Yes\r\n2.No\r\nsctocancel·Tabtoamend').state)
      .toBe('confirm-prompt');
    expect(classifyClaudeScreen('Do you want to proceed with this edit? (y/n)'))
      .toMatchObject({ state: 'confirm-prompt', affirmativeKey: 'y' });
    expect(classifyClaudeScreen('Quick safety check: Is this a project you trust this folder...').state)
      .toBe('confirm-prompt');

    const plan =
      'Claude has written up a plan and is ready to execute. Would you like to proceed?\r\n' +
      '❯ 1. Yes, and bypass permissions\r\n  2. Yes, manually approve edits\r\n  3. No, refine\r\n' +
      'shift+tab to approve with this feedback\r\n';
    expect(classifyClaudeScreen(plan)).toMatchObject({ state: 'plan-approval', affirmativeKey: null });

    expect(classifyClaudeScreen('❯\r\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents').state)
      .toBe('idle-repl');
    expect(classifyClaudeScreen('❯ /install\r\n⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage').state)
      .toBe('idle-repl');

    expect(classifyClaudeScreen(
      "There's an issuewiththeselectedmodel(claude-fable-5).Itmaynotexistor\nyoumaynothaveaccesstoit.Run/modeltopickadifferentmodel.").state)
      .toBe('model-error');

    expect(classifyClaudeScreen('\x1b[2m✻ Cogitating… (45s · esc to interrupt)\x1b[0m').state).toBe('unknown');
    expect(classifyClaudeScreen('✻ Working… esc to interrupt\r\n⏵⏵ bypass permissions on (shift+tab to cycle)').state)
      .toBe('unknown');
    expect(classifyClaudeScreen('Running tests…\n  ✓ 325 passed').state).toBe('unknown');
    expect(classifyClaudeScreen('').state).toBe('unknown');
    expect(classifyClaudeScreen(null).state).toBe('unknown');

    expect(classifyClaudeScreen('✻ Cogitating…').sample.length).toBeGreaterThan(0);
  });

  it('classifyStallScreen wrapper still reports looksLikePrompt for blocking dialogs only', async () => {
    const { classifyStallScreen } = await import('../src/agent/drivers/claude-tui.ts');
    expect(classifyStallScreen('Doyouwanttoproceed?\r\n❯1.Yes\r\n2.No\r\nEsctocancel').looksLikePrompt).toBe(true);
    expect(classifyStallScreen('Running tests…\n  ✓ 325 passed').looksLikePrompt).toBe(false);
    expect(classifyStallScreen('').looksLikePrompt).toBe(false);
    expect(classifyStallScreen(null).looksLikePrompt).toBe(false);
  });
});

describe('Claude TUI driver — decideStallAction (kill-point gating)', () => {
  it('routes confirm→answer-retry→unanswered, idle→clean(only w/o pending bg), model→error, unknown→stalled', async () => {
    const { decideStallAction } = await import('../src/agent/drivers/claude-tui.ts');
    const base = { pendingBgAgents: 0, alreadyTriedAnswer: false };

    expect(decideStallAction({ ...base, state: 'confirm-prompt', affirmativeKey: '1' })).toBe('answer-retry');
    expect(decideStallAction({ ...base, state: 'confirm-prompt', affirmativeKey: '1', alreadyTriedAnswer: true }))
      .toBe('terminate-prompt-unanswered');
    expect(decideStallAction({ ...base, state: 'bypass-startup', affirmativeKey: '2' })).toBe('answer-retry');
    expect(decideStallAction({ ...base, state: 'plan-approval', affirmativeKey: null }))
      .toBe('terminate-prompt-unanswered');

    expect(decideStallAction({ ...base, state: 'idle-repl', affirmativeKey: null })).toBe('terminate-clean');
    expect(decideStallAction({ ...base, state: 'idle-repl', affirmativeKey: null, pendingBgAgents: 2 }))
      .toBe('terminate-stalled');

    expect(decideStallAction({ ...base, state: 'model-error', affirmativeKey: null })).toBe('model-error');

    expect(decideStallAction({ ...base, state: 'unknown', affirmativeKey: null })).toBe('terminate-stalled');
    expect(decideStallAction({ ...base, state: 'unknown', affirmativeKey: null, pendingBgAgents: 3 }))
      .toBe('terminate-stalled');
  });
});

describe('Claude TUI driver — stall diagnostics classifier', () => {
  it('labels assistant/user events and degrades gracefully on missing/odd shapes', async () => {
    const { classifyClaudeJsonlEvent } = await import('../src/agent/drivers/claude-tui.ts');
    expect(classifyClaudeJsonlEvent({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } })).toBe('assistant:tool_use');
    expect(classifyClaudeJsonlEvent({ type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'text' }] } })).toBe('assistant:thinking');
    expect(classifyClaudeJsonlEvent({ type: 'assistant', message: { content: [{ type: 'text' }] } })).toBe('assistant:text');
    expect(classifyClaudeJsonlEvent({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe('user:tool_result');

    expect(classifyClaudeJsonlEvent({ type: 'system' })).toBe('system');
    expect(classifyClaudeJsonlEvent({ type: 'user', message: { content: 'plain string' } })).toBe('user');
    expect(classifyClaudeJsonlEvent({})).toBe('unknown');
    expect(classifyClaudeJsonlEvent(null)).toBe('unknown');
  });
});

describe('Claude TUI driver — chunked text streaming', () => {

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
      expect(s.thinking).toBe('pondering...');
      expect(s.text).toBe('');
      expect(buf.trueText).toBe('Hello, world!');
    }

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

    {
      const s = { text: '', thinking: '' };
      const buf = makeBuf();
      apply(s, { model: 'haiku', content: [{ type: 'text', text: 'first' }] }, buf);
      apply(s, { model: 'haiku', content: [{ type: 'text', text: 'second' }] }, buf);
      expect(buf.trueText).toBe('first\n\nsecond');
    }

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
  let workDir: string;
  let hookPath: string;
  let statePath: string;

  beforeEach(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-hook-test-'));
    hookPath = path.join(workDir, 'hook.cjs');
    statePath = path.join(workDir, 'state.json');
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

    fs.writeFileSync(statePath, JSON.stringify({ events: [] }));
    const { spawn } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, [hookPath, 'Stop', statePath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let captured = '';
      proc.stdout.on('data', d => { captured += d.toString('utf8'); });
      proc.on('exit', code => code === 0 ? resolve(captured) : reject(new Error(`exit ${code}`)));
      proc.stdin.end();
    });
    expect(JSON.parse(out.trim())).toEqual({ continue: true });
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(finalState.stoppedAt).toBeGreaterThan(0);
  });
});

describe('Claude TUI driver — readJsonlIncrement', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-jsonl-')), 'session.jsonl');
  });

  afterEach(() => {
    try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
  });

  it('exposes the incremental tail used to follow a growing JSONL', async () => {
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

    fs.appendFileSync(tmpFile, '{"type":"assist');
    const second = readIncrement(tmpFile, offset);
    expect(second.lines).toEqual([]);
    expect(second.offset).toBe(offset);

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

      claudeParse({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg1', content: 'Agent launched in background.' }] },
      }, s);
      expect(s.subAgents.get('toolu_bg1')?.status).toBe('running');
      expect(pendingClaudeBackgroundAgentCount(s)).toBe(1);

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

    {
      const s = await makeState();
      claudeParse({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_bg2', name: 'Task', input: { description: 'B', run_in_background: true } }] },
      }, s);
      s.bgTaskIdToToolUse.set('abab6f3fdb6d53772', 'toolu_bg2');

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

    expect(extractClaudeTaskNotification('plain user text')).toBeNull();
    expect(extractClaudeTaskNotification([{ type: 'text', text: '<system-reminder>x</system-reminder>' }])).toBeNull();
    expect(extractClaudeTaskNotification(undefined)).toBeNull();

    {
      const {
        registerClaudeBackgroundBashLaunch, pendingClaudeBackgroundBashCount,
        applyClaudeTaskNotification, extractClaudeBackgroundTaskId,
      } = await import('../src/agent/drivers/claude.ts');

      {
        const s: any = {};
        registerClaudeBackgroundBashLaunch(s, 'toolu_bash1');
        expect(pendingClaudeBackgroundAgentCount(s)).toBe(1);
        expect(pendingClaudeBackgroundBashCount(s)).toBe(1);
      }

      {
        const s: any = { recentActivity: [] };
        registerClaudeBackgroundBashLaunch(s, 'toolu_bash2');
        const taskId = extractClaudeBackgroundTaskId(
          'Command running in background with ID: bash_7\nOutput will stream to the transcript.');
        expect(taskId).toBe('bash_7');
        s.bgTaskIdToToolUse.set(taskId!, 'toolu_bash2');
        applyClaudeTaskNotification(s, { taskId: 'bash_7', toolUseId: null, status: 'completed' }, Date.now());
        expect(pendingClaudeBackgroundAgentCount(s)).toBe(0);
      }

      expect(extractClaudeBackgroundTaskId('regular output, ID: 42 mentioned casually')).toBeNull();
      expect(extractClaudeBackgroundTaskId([{ type: 'text', text: 'no ids here' }])).toBeNull();
    }
  });
});

describe('Claude TUI driver — decideClaudeTuiStop + decideClaudeTuiStall watchdogs', () => {
  const MIN = 60_000;

  it('decideClaudeTuiStop gating + phantom-hold TTL, then decideClaudeTuiStall watchdog (fresh/threshold/mid-tool/custom/dead-PTY)', async () => {
    const { decideClaudeTuiStop } = await import('../src/agent/drivers/claude-tui.ts');

    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 3,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 900, now: 2_000,
    })).toBe('hold-background');

    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 0,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 900, now: 1_200,
    })).toBe('terminate');

    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 0,
      lastTaskNotificationAt: 5_000, lastJsonlEventAt: 5_100, now: 6_000,
    })).toBe('hold-resettle');

    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 0,
      lastTaskNotificationAt: 5_000, lastJsonlEventAt: 5_100, now: 5_100 + 30_000,
    })).toBe('terminate');

    expect(decideClaudeTuiStop({
      stoppedAt: 9_000, pendingBackgroundAgents: 0,
      lastTaskNotificationAt: 5_000, lastJsonlEventAt: 8_900, now: 9_100,
    })).toBe('terminate');

    expect(decideClaudeTuiStop({
      stoppedAt: 100 * MIN, pendingBackgroundAgents: 2,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 100 * MIN,
      lastHookOrSidecarEventAt: 119 * MIN,
      now: 120 * MIN,
    })).toBe('hold-background');

    expect(decideClaudeTuiStop({
      stoppedAt: 100 * MIN, pendingBackgroundAgents: 1,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 100 * MIN,
      lastHookOrSidecarEventAt: 100 * MIN,
      now: 111 * MIN,
    })).toBe('terminate');

    expect(decideClaudeTuiStop({
      stoppedAt: 1_000, pendingBackgroundAgents: 1,
      lastTaskNotificationAt: 0, lastJsonlEventAt: 1_000,
      lastHookOrSidecarEventAt: 1_000, holdQuietTtlMs: 5_000,
      now: 7_000,
    })).toBe('terminate');

    const { decideClaudeTuiStall } = await import('../src/agent/drivers/claude-tui.ts');

    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 99 * MIN, pendingToolCount: 0,
    })).toBe('wait');

    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 100 * MIN - 9 * MIN, pendingToolCount: 0,
    })).toBe('wait');

    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 100 * MIN - 11 * MIN, pendingToolCount: 0,
    })).toBe('stall');

    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 100 * MIN - 11 * MIN, pendingToolCount: 1,
    })).toBe('wait');
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 100 * MIN - 31 * MIN, pendingToolCount: 1,
    })).toBe('stall');

    expect(decideClaudeTuiStall({
      now: 10_000, lastProgressAt: 0, pendingToolCount: 0, quietMs: 5_000,
    })).toBe('stall');
    expect(decideClaudeTuiStall({
      now: 10_000, lastProgressAt: 0, pendingToolCount: 2, pendingToolMs: 20_000,
    })).toBe('wait');

    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 96 * MIN, pendingToolCount: 1,
      lastPtyDataAt: 96 * MIN,
    })).toBe('stall');

    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 91 * MIN, pendingToolCount: 0,
      lastPtyDataAt: 100 * MIN - 1_000,
    })).toBe('wait');
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 80 * MIN, pendingToolCount: 1,
      lastPtyDataAt: 100 * MIN - 1_000,
    })).toBe('wait');

    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 96 * MIN, pendingToolCount: 0,
      lastPtyDataAt: 0,
    })).toBe('wait');

    expect(decideClaudeTuiStall({
      now: 100_000, lastProgressAt: 0, pendingToolCount: 0,
      lastPtyDataAt: 10_000, ptyDeadMs: 60_000,
    })).toBe('stall');

    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 0, pendingToolCount: 1,
      awaitingUserReply: true, lastPtyDataAt: 0,
    })).toBe('wait');
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 0, pendingToolCount: 1,
      awaitingUserReply: true, lastPtyDataAt: 0  + 1,
    })).toBe('wait');
    expect(decideClaudeTuiStall({
      now: 100 * MIN, lastProgressAt: 0, pendingToolCount: 0,
      awaitingUserReply: false, lastPtyDataAt: 0,
    })).toBe('stall');
  });
});

describe('Claude TUI driver — isAskUserToolName (im_ask_user detection)', () => {
  it('matches the bare + MCP-namespaced im_ask_user tool, nothing else', async () => {
    const { isAskUserToolName } = await import('../src/agent/drivers/claude-tui.ts');
    expect(isAskUserToolName('mcp__pikiloom__im_ask_user')).toBe(true);
    expect(isAskUserToolName('mcp__something__im_ask_user')).toBe(true);
    expect(isAskUserToolName('im_ask_user')).toBe(true);
    expect(isAskUserToolName('mcp__pikiloom__im_send_file')).toBe(false);
    expect(isAskUserToolName('mcp__pikiloom__await_background')).toBe(false);
    expect(isAskUserToolName('im_ask_user_extra')).toBe(false);
    expect(isAskUserToolName('Bash')).toBe(false);
    expect(isAskUserToolName('')).toBe(false);
    expect(isAskUserToolName(null)).toBe(false);
    expect(isAskUserToolName(undefined)).toBe(false);
    expect(isAskUserToolName(123)).toBe(false);
  });
});

describe('Live preview toolCalls — expandable tool rows during a running turn', () => {
  it('claudeParse + hook path register tool input/result detail, with plan/sub-agent tools filtered out', async () => {
    const { claudeParse, createClaudeStreamState } = await import('../src/agent/drivers/claude.ts');
    const { applyHookToolEvent } = await import('../src/agent/drivers/claude-tui.ts');
    const { buildStreamPreviewMeta } = await import('../src/agent/utils.ts');

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
      expect(meta.toolCalls).toHaveLength(1);
      expect(meta.toolCalls![0]).toMatchObject({
        id: 'toolu_h1', name: 'Read', status: 'done', result: 'file contents here',
      });
      expect(meta.toolCalls![0].input).toContain('/tmp/x.ts');
    }
  });
});
