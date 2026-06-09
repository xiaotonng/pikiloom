/**
 * Tests for the unified human-in-the-loop interaction flow.
 *
 * Covers:
 *   1. AgentInteraction creation from Codex driver format
 *   2. Bot.createInteractionHandler wiring (IM + Dashboard paths)
 *   3. SSE event emission (interaction / interaction-resolved)
 *   4. Public interaction API on Bot (select, text, skip, cancel)
 *   5. Dashboard submitSessionTask auto-wiring
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/agent/index.ts')>();
  return {
    ...actual,
    doStream: vi.fn(),
  };
});

import { doStream, type AgentInteraction, type StreamOpts } from '../src/agent/index.ts';
import { Bot, type StreamEvent, type InteractionSnapshot } from '../src/bot/bot.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';
import { makeStreamResult } from './support/stream-result.ts';

const envSnapshot = captureEnv(['PIKICLAW_CONFIG', 'PIKICLAW_WORKDIR', 'DEFAULT_AGENT']);

beforeEach(() => {
  restoreEnv(envSnapshot);
  vi.clearAllMocks();
  const tmpConfig = makeTmpDir('interaction-unit-config-');
  process.env.PIKICLAW_CONFIG = `${tmpConfig}/setting.json`;
  process.env.PIKICLAW_WORKDIR = makeTmpDir('interaction-unit-workdir-');
  process.env.DEFAULT_AGENT = 'codex';
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

// ---- helpers ----------------------------------------------------------------

function buildTestInteraction(overrides: Partial<AgentInteraction> = {}): AgentInteraction {
  return {
    kind: 'user-input',
    id: 'req-1',
    title: 'User Input Required',
    hint: 'Use the buttons when available.',
    questions: [
      {
        id: 'q1',
        header: 'Question',
        prompt: 'Choose a tool approval policy:',
        options: [
          { label: 'Allow', description: 'Allow the tool', value: 'Allow' },
          { label: 'Deny', description: 'Deny the tool', value: 'Deny' },
        ],
        allowFreeform: false,
        allowEmpty: true,
      },
    ],
    resolveWith: (answers) => ({
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, vals]) => [id, { answers: vals }]),
      ),
    }),
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------------

describe('Bot interaction handler via submitSessionTask (dashboard path)', () => {
  it('creates interaction prompts and resolves via select, cancel, and freeform text APIs', async () => {
    const doStreamMock = vi.mocked(doStream);
    const events: StreamEvent[] = [];

    // --- select: creates interaction prompts, emits SSE events, resolves via selectOption ---
    doStreamMock.mockImplementationOnce(async (opts) => {
      const interactionPromise = opts.onInteraction?.(buildTestInteraction());
      expect(interactionPromise).toBeInstanceOf(Promise);
      const response = await interactionPromise;
      expect(response).toEqual({ answers: { q1: { answers: ['Allow'] } } });
      return makeStreamResult('codex', { sessionId: 'sess-interaction', message: 'done after interaction' });
    });

    const bot = new Bot();
    bot.onStreamSnapshot((key, snap) => {
      if (snap?.interactions?.length) {
        events.push({ type: 'interaction', taskId: snap.taskId, interaction: snap.interactions[0] });
      }
    });
    const submitted = bot.submitSessionTask({ agent: 'codex', sessionId: 'sess-interaction', workdir: process.env.PIKICLAW_WORKDIR!, prompt: 'do work' });
    expect(submitted.ok).toBe(true);

    let deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot.getStreamSnapshot('codex:sess-interaction')?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }

    const snap = bot.getStreamSnapshot('codex:sess-interaction');
    expect(snap?.interactions).toHaveLength(1);
    expect(snap!.interactions![0]).toMatchObject({ kind: 'user-input', title: 'User Input Required' });
    const promptId = snap!.interactions![0].promptId;

    const promptState = bot.interactionPrompt(promptId);
    expect(promptState).toBeTruthy();
    expect(promptState!.title).toBe('User Input Required');
    expect(promptState!.questions).toHaveLength(1);

    const selectResult = bot.interactionSelectOption(promptId, 'Allow');
    expect(selectResult).toBeTruthy();
    expect(selectResult!.completed).toBe(true);

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot.getStreamSnapshot('codex:sess-interaction')?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(bot.getStreamSnapshot('codex:sess-interaction')?.phase).toBe('done');
    expect(bot.getStreamSnapshot('codex:sess-interaction')?.interactions).toBeUndefined();
    expect(bot.interactionPrompt(promptId)).toBeNull();

    // --- cancel: cancels interaction and rejects the agent promise ---
    doStreamMock.mockImplementationOnce(async (opts) => {
      try {
        await opts.onInteraction?.(buildTestInteraction());
        return makeStreamResult('codex', { message: 'unexpected' });
      } catch (error: any) {
        expect(error.message).toContain('Cancelled');
        return makeStreamResult('codex', { sessionId: 'sess-cancel', message: 'cancelled interaction', incomplete: true });
      }
    });

    const bot2 = new Bot();
    bot2.submitSessionTask({ agent: 'codex', sessionId: 'sess-cancel', workdir: process.env.PIKICLAW_WORKDIR!, prompt: 'do work' });

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot2.getStreamSnapshot('codex:sess-cancel')?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }
    const cancelPromptId = bot2.getStreamSnapshot('codex:sess-cancel')!.interactions![0].promptId;
    const cancelResult = bot2.interactionCancel(cancelPromptId);
    expect(cancelResult).toBeTruthy();

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot2.getStreamSnapshot('codex:sess-cancel')?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(bot2.getStreamSnapshot('codex:sess-cancel')?.phase).toBe('done');

    // --- freeform text: handles freeform text submission through the public API ---
    const freeformInteraction = buildTestInteraction({
      questions: [{ id: 'q1', header: 'Question', prompt: 'Enter your API key:', secret: true, allowFreeform: true }],
    });
    doStreamMock.mockImplementationOnce(async (opts) => {
      const response = await opts.onInteraction?.(freeformInteraction);
      expect(response).toEqual({ answers: { q1: { answers: ['my-secret-key'] } } });
      return makeStreamResult('codex', { sessionId: 'sess-freeform', message: 'done' });
    });

    const bot3 = new Bot();
    bot3.submitSessionTask({ agent: 'codex', sessionId: 'sess-freeform', workdir: process.env.PIKICLAW_WORKDIR!, prompt: 'do work' });

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot3.getStreamSnapshot('codex:sess-freeform')?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }
    const freeformPromptId = bot3.getStreamSnapshot('codex:sess-freeform')!.interactions![0].promptId;
    const textResult = bot3.interactionSubmitText(freeformPromptId, 'my-secret-key');
    expect(textResult).toBeTruthy();
    expect(textResult!.completed).toBe(true);

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot3.getStreamSnapshot('codex:sess-freeform')?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(bot3.getStreamSnapshot('codex:sess-freeform')?.phase).toBe('done');
  });

  it('handles dashboard "Other" path, rejects disallowed freeform, and resolves via skip', async () => {
    const doStreamMock = vi.mocked(doStream);

    // --- options+freeform: accepts custom freeform answer on an options question (dashboard "Other" path) ---
    const optionsWithFreeform = buildTestInteraction({
      questions: [{
        id: 'q1', header: 'Question', prompt: 'Pick one, or type your own:',
        options: [{ label: 'A', description: 'first', value: 'A' }, { label: 'B', description: 'second', value: 'B' }],
        allowFreeform: true,
      }],
    });
    doStreamMock.mockImplementationOnce(async (opts) => {
      const response = await opts.onInteraction?.(optionsWithFreeform);
      expect(response).toEqual({ answers: { q1: { answers: ['my own answer'] } } });
      return makeStreamResult('codex', { sessionId: 'sess-other', message: 'done' });
    });

    const bot4 = new Bot();
    bot4.submitSessionTask({ agent: 'codex', sessionId: 'sess-other', workdir: process.env.PIKICLAW_WORKDIR!, prompt: 'do work' });

    let deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot4.getStreamSnapshot('codex:sess-other')?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }
    const otherPromptId = bot4.getStreamSnapshot('codex:sess-other')!.interactions![0].promptId;
    const otherResult = bot4.interactionSubmitText(otherPromptId, 'my own answer');
    expect(otherResult).toBeTruthy();
    expect(otherResult!.completed).toBe(true);

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot4.getStreamSnapshot('codex:sess-other')?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(bot4.getStreamSnapshot('codex:sess-other')?.phase).toBe('done');

    // --- reject freeform: rejects freeform text on an options question that disallows freeform ---
    doStreamMock.mockImplementationOnce(async (opts) => {
      const response = await opts.onInteraction?.(buildTestInteraction());
      expect(response).toEqual({ answers: { q1: { answers: ['Allow'] } } });
      return makeStreamResult('codex', { sessionId: 'sess-noff', message: 'done' });
    });

    const bot5 = new Bot();
    bot5.submitSessionTask({ agent: 'codex', sessionId: 'sess-noff', workdir: process.env.PIKICLAW_WORKDIR!, prompt: 'do work' });

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot5.getStreamSnapshot('codex:sess-noff')?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }
    const noffPromptId = bot5.getStreamSnapshot('codex:sess-noff')!.interactions![0].promptId;
    expect(bot5.interactionSubmitText(noffPromptId, 'sneaky text')).toBeNull();
    const noffSelectResult = bot5.interactionSelectOption(noffPromptId, 'Allow');
    expect(noffSelectResult!.completed).toBe(true);

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot5.getStreamSnapshot('codex:sess-noff')?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(bot5.getStreamSnapshot('codex:sess-noff')?.phase).toBe('done');

    // --- skip: handles skip via the public API ---
    doStreamMock.mockImplementationOnce(async (opts) => {
      const response = await opts.onInteraction?.(buildTestInteraction());
      expect(response).toEqual({ answers: { q1: { answers: [] } } });
      return makeStreamResult('codex', { sessionId: 'sess-skip', message: 'done' });
    });

    const bot6 = new Bot();
    bot6.submitSessionTask({ agent: 'codex', sessionId: 'sess-skip', workdir: process.env.PIKICLAW_WORKDIR!, prompt: 'do work' });

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot6.getStreamSnapshot('codex:sess-skip')?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }
    const skipPromptId = bot6.getStreamSnapshot('codex:sess-skip')!.interactions![0].promptId;
    const skipResult = bot6.interactionSkip(skipPromptId);
    expect(skipResult).toBeTruthy();
    expect(skipResult!.completed).toBe(true);

    deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (bot6.getStreamSnapshot('codex:sess-skip')?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(bot6.getStreamSnapshot('codex:sess-skip')?.phase).toBe('done');
  });
});

describe('Bot.runStream interaction handler (IM path)', () => {
  it('invokes onInteraction and the response resolves back into the stream', async () => {
    const doStreamMock = vi.mocked(doStream);

    doStreamMock.mockImplementationOnce(async (opts) => {
      expect(opts.onInteraction).toBeDefined();

      const response = await opts.onInteraction?.(buildTestInteraction());
      // Verify the response shape
      expect(response).toEqual({
        answers: { q1: { answers: ['Deny'] } },
      });

      return makeStreamResult('codex', {
        sessionId: 'sess-im',
        message: 'done after IM interaction',
      });
    });

    const bot = new Bot();
    const cs = bot.chat(1);
    cs.agent = 'codex';

    // Simulate the IM path: provide onInteraction to runStream
    const interactionHandler = (bot as any).createInteractionHandler(1, 'task-im');

    const resultPromise = bot.runStream('do something', cs, [], () => {}, undefined, undefined, undefined, interactionHandler);

    // Wait for the interaction prompt to appear
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const prompt = (bot as any).pendingHumanLoopPrompt(1);
      if (prompt) break;
      await new Promise(r => setTimeout(r, 10));
    }

    // Find and answer the prompt
    const prompt = (bot as any).pendingHumanLoopPrompt(1);
    expect(prompt).toBeTruthy();
    expect(prompt.title).toBe('User Input Required');

    // Select an option (Deny)
    const selectResult = (bot as any).humanLoopSelectOption(prompt.promptId, 'Deny');
    expect(selectResult.completed).toBe(true);

    const result = await resultPromise;
    expect(result.message).toBe('done after IM interaction');
  });
});

describe('dashboard chats skip IM-side renderInteractionPrompt', () => {
  it('does not invoke renderInteractionPrompt when chatId is the dashboard sentinel', async () => {
    const doStreamMock = vi.mocked(doStream);

    doStreamMock.mockImplementationOnce(async (opts) => {
      const response = await opts.onInteraction?.(buildTestInteraction());
      expect(response).toEqual({ answers: { q1: { answers: ['Allow'] } } });
      return makeStreamResult('codex', { sessionId: 'sess-dash-skip', message: 'done' });
    });

    const renderSpy = vi.fn(async () => {
      // Simulate an IM subclass whose channel SDK (e.g. Feishu/axios) rejects
      // `chatId='dashboard'` with a 400 — the bug this test guards against.
      throw new Error('Request failed with status code 400');
    });

    class IMBot extends Bot {
      // @ts-expect-error narrow ChatId only matters at runtime here
      protected override renderInteractionPrompt(...args: unknown[]) {
        return renderSpy(...args);
      }
    }

    const bot = new IMBot();
    const submitted = bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'sess-dash-skip',
      workdir: process.env.PIKICLAW_WORKDIR!,
      prompt: 'do work',
      // No chatId — defaults to the dashboard sentinel.
    });
    expect(submitted.ok).toBe(true);

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const snap = bot.getStreamSnapshot('codex:sess-dash-skip');
      if (snap?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }

    const snap = bot.getStreamSnapshot('codex:sess-dash-skip');
    expect(snap?.interactions).toHaveLength(1);
    const promptId = snap!.interactions![0].promptId;
    bot.interactionSelectOption(promptId, 'Allow');

    const doneDeadline = Date.now() + 2000;
    while (Date.now() < doneDeadline) {
      const s = bot.getStreamSnapshot('codex:sess-dash-skip');
      if (s?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }

    expect(renderSpy).not.toHaveBeenCalled();
    expect(bot.getStreamSnapshot('codex:sess-dash-skip')?.phase).toBe('done');
  });
});

describe('interaction on nonexistent prompts', () => {
  it('returns null for all operations on nonexistent prompt IDs', () => {
    const bot = new Bot();
    expect(bot.interactionSelectOption('nope', 'x')).toBeNull();
    expect(bot.interactionSubmitText('nope', 'x')).toBeNull();
    expect(bot.interactionSkip('nope')).toBeNull();
    expect(bot.interactionCancel('nope')).toBeNull();
    expect(bot.interactionPrompt('nope')).toBeNull();
  });
});
