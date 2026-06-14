import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/agent/index.ts')>();
  return {
    ...actual,
    doStream: vi.fn(),
    // Pin agent detection so the install-aware default-agent resolution is
    // deterministic regardless of which agent CLIs the test host has on PATH.
    listAgents: () => ({
      agents: [
        { agent: 'claude', installed: false, path: null, version: null },
        { agent: 'codex', installed: true, path: '/usr/bin/codex', version: null },
        { agent: 'gemini', installed: false, path: null, version: null },
        { agent: 'hermes', installed: false, path: null, version: null },
      ],
    }),
  };
});

import { doStream } from '../src/agent/index.ts';
import { ensureManagedSession } from '../src/agent/index.ts';
import { Bot } from '../src/bot/bot.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';
import { makeStreamResult } from './support/stream-result.ts';

const envSnapshot = captureEnv(['PIKILOOP_CONFIG', 'PIKILOOP_WORKDIR', 'DEFAULT_AGENT']);

beforeEach(() => {
  restoreEnv(envSnapshot);
  vi.clearAllMocks();
  const tmpConfig = makeTmpDir('bot-unit-config-');
  process.env.PIKILOOP_CONFIG = `${tmpConfig}/setting.json`;
  process.env.PIKILOOP_WORKDIR = makeTmpDir('bot-unit-workdir-');
  process.env.DEFAULT_AGENT = 'codex';
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

describe('Bot.runStream', () => {
  it('manages codex cumulative totals across turns/workdir switches and resumes from a session workdir', async () => {
    // === manages codex cumulative totals across turns and workdir switches ===
    // --- defaults to codex when DEFAULT_AGENT is unset ---
    delete process.env.DEFAULT_AGENT;

    const defaultBot = new Bot();

    expect(defaultBot.defaultAgent).toBe('codex');
    expect(defaultBot.chat(1).agent).toBe('codex');

    // --- passes prior Codex cumulative totals into resumed turns and stores updated totals ---
    process.env.DEFAULT_AGENT = 'codex';

    const doStreamMock = vi.mocked(doStream);
    doStreamMock
      .mockImplementationOnce(async opts => {
        expect(opts.codexPrevCumulative).toBeUndefined();
        return makeStreamResult('codex', {
          sessionId: 'sess-resume',
          inputTokens: 5000,
          cachedInputTokens: 4000,
          outputTokens: 300,
          codexCumulative: { input: 5000, output: 300, cached: 4000 },
        });
      })
      .mockImplementationOnce(async opts => {
        expect(opts.codexPrevCumulative).toEqual({ input: 5000, output: 300, cached: 4000 });
        return makeStreamResult('codex', {
          sessionId: 'sess-resume',
          message: 'Resumed turn',
          inputTokens: 3300,
          cachedInputTokens: 2500,
          outputTokens: 60,
          codexCumulative: { input: 8300, output: 360, cached: 6500 },
        });
      });

    const bot = new Bot();
    const cs = bot.chat(1);
    cs.agent = 'codex';

    await bot.runStream('start', cs, [], () => {});
    const result = await bot.runStream('continue', cs, [], () => {});

    expect(result.message).toBe('Resumed turn');
    expect(result.inputTokens).toBe(3300);
    expect(result.cachedInputTokens).toBe(2500);
    expect(result.outputTokens).toBe(60);
    expect(cs.codexCumulative).toEqual({ input: 8300, output: 360, cached: 6500 });

    // --- clears cached Codex cumulative totals when switching workdirs ---
    const bot2 = new Bot();
    const cs2 = bot2.chat(1);
    cs2.agent = 'codex';
    cs2.sessionId = 'sess-existing';
    cs2.codexCumulative = { input: 8300, output: 360, cached: 6500 };

    const nextWorkdir = makeTmpDir('bot-unit-next-');
    bot2.switchWorkdir(nextWorkdir);

    expect(cs2.sessionId).toBeNull();
    expect(cs2.codexCumulative).toBeUndefined();

    // === uses the session workdir when continuing a session from another project ===
    // Fresh mock queue so the resume turn below is the only implementation left.
    vi.mocked(doStream).mockReset();
    {
    const doStreamMock = vi.mocked(doStream);
    const bot = new Bot();
    const sessionWorkdir = makeTmpDir('bot-unit-session-workdir-');
    const workspacePath = path.join(sessionWorkdir, '.pikiloop', 'sessions', 'claude', 'session-1', 'workspace');
    const runtime: any = {
      key: 'claude:session-1',
      workdir: sessionWorkdir,
      agent: 'claude',
      sessionId: 'session-1',
      workspacePath,
      codexCumulative: undefined,
      modelId: null,
      runningTaskIds: new Set<string>(),
    };

    doStreamMock.mockImplementationOnce(async opts => {
      expect(opts.workdir).toBe(sessionWorkdir);
      return makeStreamResult('claude', {
        sessionId: 'session-1',
        workspacePath,
        elapsedS: 1,
        inputTokens: 1,
        outputTokens: 1,
      });
    });

    await bot.runStream('continue', runtime, [], () => {});
    }
  });
});

describe('Bot task lifecycle (steer / stop / reset)', () => {
  it('handoff-steers, stop-aborts-but-keeps-queued, and resets selection without interrupting tasks', async () => {
    // === steering handoff: interrupts the running task and preserves its preview instead of using in-process steer ===
    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-steer',
      workdir: process.env.PIKILOOP_WORKDIR!,
      workspacePath: null,
      modelId: null,
    });

    const runningAbort = vi.fn();
    const runningSteer = vi.fn(async () => true);
    bot.beginTask({
      taskId: 'run-1',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'first task',
      startedAt: Date.now() - 1000,
      sourceMessageId: 10,
    });
    bot.markTaskRunning('run-1', runningAbort);
    bot.activeTasks.get('run-1').steer = runningSteer;

    bot.beginTask({
      taskId: 'queued-1',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'name only',
      startedAt: Date.now(),
      sourceMessageId: 11,
    });

    const result = await bot.steerTaskByActionId(bot.actionIdForTask('queued-1'));

    expect(result.steered).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(runningSteer).not.toHaveBeenCalled();
    expect(runningAbort).toHaveBeenCalledTimes(1);
    expect(bot.activeTasks.get('run-1')?.freezePreviewOnAbort).toBe(true);
    expect(bot.activeTasks.get('queued-1')?.cancelled).toBe(false);
    }

    // === stopAllSessionTasks: aborts the running task but leaves queued tasks in place to run next ===
    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-stop',
      workdir: process.env.PIKILOOP_WORKDIR!,
      workspacePath: null,
      modelId: null,
    });

    const runningAbort = vi.fn();
    bot.beginTask({
      taskId: 'run-1',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'running task',
      startedAt: Date.now() - 1000,
      sourceMessageId: 200,
    });
    bot.markTaskRunning('run-1', runningAbort);

    bot.beginTask({
      taskId: 'queued-1',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'queued task 1',
      startedAt: Date.now(),
      sourceMessageId: 201,
    });
    bot.beginTask({
      taskId: 'queued-2',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'queued task 2',
      startedAt: Date.now(),
      sourceMessageId: 202,
    });

    const result = bot.stopAllSessionTasks(runtime.key);

    expect(result.interrupted).toBe(true);
    expect(result.cancelledQueued).toBe(0);
    expect(runningAbort).toHaveBeenCalledTimes(1);
    expect(bot.activeTasks.get('run-1')?.cancelled).toBe(true);
    expect(bot.activeTasks.get('queued-1')?.cancelled).toBeFalsy();
    expect(bot.activeTasks.get('queued-1')?.status).toBe('queued');
    expect(bot.activeTasks.get('queued-2')?.cancelled).toBeFalsy();
    expect(bot.activeTasks.get('queued-2')?.status).toBe('queued');
    }

    // === resetConversationForChat: clears the chat selection without interrupting running or queued tasks ===
    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-prev',
      workdir: process.env.PIKILOOP_WORKDIR!,
      workspacePath: null,
      modelId: null,
    });
    bot.applySessionSelection(bot.chat(1), runtime);

    const runningAbort = vi.fn();
    bot.beginTask({
      taskId: 'run-prev',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'long task',
      startedAt: Date.now() - 1000,
      sourceMessageId: 100,
    });
    bot.markTaskRunning('run-prev', runningAbort);

    bot.beginTask({
      taskId: 'queued-prev',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'queued task',
      startedAt: Date.now(),
      sourceMessageId: 101,
    });

    bot.resetConversationForChat(1);

    expect(runningAbort).not.toHaveBeenCalled();
    expect(bot.activeTasks.get('run-prev')?.status).toBe('running');
    expect(bot.activeTasks.get('queued-prev')?.cancelled).toBeFalsy();
    expect(bot.chat(1).activeSessionKey).toBeNull();
    expect(bot.chat(1).sessionId).toBeNull();
    }

    // === resetConversationForChat: clears chat selection when previous session is idle ===
    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-idle',
      workdir: process.env.PIKILOOP_WORKDIR!,
      workspacePath: null,
      modelId: null,
    });
    bot.applySessionSelection(bot.chat(1), runtime);

    bot.resetConversationForChat(1);

    expect(bot.chat(1).activeSessionKey).toBeNull();
    }
  });
});

describe('Bot emitStream queue tracking', () => {
  it('tracks queued ids through start/cancel/done and drops the snapshot on active cancel', () => {
    // === accumulates multiple queued task ids while a task is streaming ===
    {
    const bot = new Bot() as any;
    const sessionKey = 'claude:sess-multi-queue';

    bot.emitStream(sessionKey, { type: 'start', taskId: 'run-1', agent: 'claude', sessionId: 'sess-multi-queue' });
    bot.emitStream(sessionKey, { type: 'queued', taskId: 'q-1', position: 1 });
    bot.emitStream(sessionKey, { type: 'queued', taskId: 'q-2', position: 2 });
    bot.emitStream(sessionKey, { type: 'queued', taskId: 'q-3', position: 3 });

    let snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.taskId).toBe('run-1');
    expect(snap?.queuedTaskIds).toEqual(['q-1', 'q-2', 'q-3']);

    // Cancelling a queued task removes it from the list, keeps the active task.
    bot.emitStream(sessionKey, { type: 'cancelled', taskId: 'q-2' });
    snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.taskId).toBe('run-1');
    expect(snap?.queuedTaskIds).toEqual(['q-1', 'q-3']);

    // Active task finishing keeps the remaining queued list.
    bot.emitStream(sessionKey, { type: 'done', taskId: 'run-1', sessionId: 'sess-multi-queue' });
    snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.phase).toBe('done');
    expect(snap?.queuedTaskIds).toEqual(['q-1', 'q-3']);

    // Next task starting drops itself from the queued list.
    bot.emitStream(sessionKey, { type: 'start', taskId: 'q-1', agent: 'claude', sessionId: 'sess-multi-queue' });
    snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.phase).toBe('streaming');
    expect(snap?.taskId).toBe('q-1');
    expect(snap?.queuedTaskIds).toEqual(['q-3']);

    // Last queued task starting clears the queued list entirely.
    bot.emitStream(sessionKey, { type: 'done', taskId: 'q-1', sessionId: 'sess-multi-queue' });
    bot.emitStream(sessionKey, { type: 'start', taskId: 'q-3', agent: 'claude', sessionId: 'sess-multi-queue' });
    snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.taskId).toBe('q-3');
    expect(snap?.queuedTaskIds).toBeUndefined();
    }

    // === cancelling the active task drops the whole snapshot ===
    {
    const bot = new Bot() as any;
    const sessionKey = 'claude:sess-active-cancel';

    bot.emitStream(sessionKey, { type: 'start', taskId: 'run-1', agent: 'claude', sessionId: 'sess-active-cancel' });
    bot.emitStream(sessionKey, { type: 'queued', taskId: 'q-1', position: 1 });
    bot.emitStream(sessionKey, { type: 'cancelled', taskId: 'run-1' });

    expect(bot.getStreamSnapshot(sessionKey)).toBeNull();
    }
  });
});

describe('Bot selection switching (model / effort)', () => {
  it('switches model inline or as a default, and decomposes/clears the ultra effort rung', () => {
    // === switchModelForChat: applies the new model to the active session inline without dropping it ===
    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-active',
      workdir: process.env.PIKILOOP_WORKDIR!,
      workspacePath: null,
      modelId: 'old-model',
    });
    bot.applySessionSelection(bot.chat(1), runtime);
    bot.setModelForAgent('claude', 'old-model');

    bot.switchModelForChat(1, 'new-model');

    // Active selection preserved — user can keep talking to the same session
    expect(bot.chat(1).activeSessionKey).toBe(runtime.key);
    expect(bot.chat(1).sessionId).toBe('sess-active');
    // Session + chat now both report the new model so the next runStream
    // will pick it up regardless of which fallback layer wins
    expect(bot.chat(1).modelId).toBe('new-model');
    expect(runtime.modelId).toBe('new-model');
    // Global agent default is updated too (so a brand-new session inherits)
    expect(bot.modelForAgent('claude')).toBe('new-model');
    }

    // === switchModelForChat: updates global default even when no session is active ===
    {
    const bot = new Bot() as any;
    bot.chat(1).agent = 'claude';
    bot.setModelForAgent('claude', 'old-model');

    bot.switchModelForChat(1, 'new-model');

    expect(bot.modelForAgent('claude')).toBe('new-model');
    expect(bot.chat(1).modelId).toBe('new-model');
    expect(bot.chat(1).activeSessionKey).toBeNull();
    }

    // === switchEffortForChat (ultra rung): decomposes the synthetic "ultra" rung into max effort + workflow on ===
    {
    const bot = new Bot() as any;
    bot.chat(1).agent = 'claude';

    bot.switchEffortForChat(1, 'ultra');

    // "ultra" is never stored verbatim — the claude CLI rejects it as an
    // --effort value, so it maps to "max" depth plus the orthogonal workflow
    // opt-in. The CLI only ever sees a real effort value.
    expect(bot.effortForAgent('claude')).toBe('max');
    expect(bot.workflowEnabledForAgent('claude')).toBe(true);
    // ...but the picker folds that pairing back into the single "ultra" rung.
    expect(bot.effortSelectionForAgent('claude')).toBe('ultra');
    }

    // === switchEffortForChat (ultra rung): clears the workflow opt-in when a concrete rung is picked ===
    {
    const bot = new Bot() as any;
    bot.chat(1).agent = 'claude';

    bot.switchEffortForChat(1, 'ultra');
    expect(bot.workflowEnabledForAgent('claude')).toBe(true);

    // Rungs are mutually exclusive: stepping down to a concrete effort turns
    // orchestration back off so "Max" and "Ultra" stay distinct.
    bot.switchEffortForChat(1, 'xhigh');
    expect(bot.effortForAgent('claude')).toBe('xhigh');
    expect(bot.workflowEnabledForAgent('claude')).toBe(false);
    expect(bot.effortSelectionForAgent('claude')).toBe('xhigh');
    }
  });
});

describe('Bot thread-aware agent switching', () => {
  it('resumes the existing session for the target agent inside the same thread', () => {
    const workdir = process.env.PIKILOOP_WORKDIR!;
    ensureManagedSession({
      agent: 'codex',
      workdir,
      sessionId: 'sess-codex',
      title: 'codex side',
      threadId: 'thread-shared',
    });
    ensureManagedSession({
      agent: 'claude',
      workdir,
      sessionId: 'sess-claude',
      title: 'claude side',
      threadId: 'thread-shared',
    });

    const bot = new Bot();
    bot.adoptExistingSessionForChat(1, {
      agent: 'codex',
      sessionId: 'sess-codex',
      workdir,
      workspacePath: null,
      model: 'gpt-5.4',
      title: 'codex side',
      threadId: 'thread-shared',
    });

    const switched = bot.switchAgentForChat(1, 'claude');
    const selected = bot.selectedSession(1);

    expect(switched).toBe(true);
    expect(selected).toMatchObject({
      agent: 'claude',
      sessionId: 'sess-claude',
      threadId: 'thread-shared',
    });
    expect(bot.chat(1).activeThreadId).toBe('thread-shared');

    bot.switchAgentForChat(1, 'codex');
    expect(bot.selectedSession(1)).toMatchObject({
      agent: 'codex',
      sessionId: 'sess-codex',
      threadId: 'thread-shared',
    });
  });
});

describe('Bot external session control', () => {
  it('submits dashboard tasks/publishes stream state and migrates state on codex session-id promotion', async () => {
    // === submits dashboard session tasks through the public API and publishes stream state ===
    {
    const doStreamMock = vi.mocked(doStream);
    doStreamMock.mockImplementationOnce(async opts => {
      opts.onText('partial reply', 'thinking...');
      return makeStreamResult('codex', {
        sessionId: 'sess-dashboard',
        message: 'done',
        elapsedS: 1,
      });
    });

    const bot = new Bot();
    const submitted = bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'sess-dashboard',
      workdir: process.env.PIKILOOP_WORKDIR!,
      prompt: 'continue',
    });

    expect(submitted.ok).toBe(true);
    expect(submitted.sessionKey).toBe('codex:sess-dashboard');
    await new Promise(resolve => setImmediate(resolve));

    expect(bot.getStreamSnapshot('codex:sess-dashboard')).toMatchObject({
      phase: 'done',
      taskId: submitted.taskId,
      sessionId: 'sess-dashboard',
      text: 'partial reply',
      thinking: 'thinking...',
    });
    }

    // Fresh mock queue so the promotion turn below is the only implementation left.
    vi.mocked(doStream).mockReset();

    // === migrates dashboard stream state and runtime tracking when codex promotes a pending session id ===
    {
    const doStreamMock = vi.mocked(doStream);
    doStreamMock.mockImplementationOnce(async opts => {
      opts.onSessionId?.('sess-promoted');
      opts.onText('partial reply', 'thinking...');
      return makeStreamResult('codex', {
        sessionId: 'sess-promoted',
        message: 'done',
        elapsedS: 1,
      });
    });

    const bot = new Bot();
    const submitted = bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'pending_dashboard',
      workdir: process.env.PIKILOOP_WORKDIR!,
      prompt: 'continue',
    });

    expect(submitted.ok).toBe(true);
    const deadline = Date.now() + 1000;
    let promotedSnapshot = bot.getStreamSnapshot('codex:sess-promoted');
    while (!promotedSnapshot && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      promotedSnapshot = bot.getStreamSnapshot('codex:sess-promoted');
    }

    expect(promotedSnapshot).toMatchObject({
      phase: 'done',
      taskId: submitted.taskId,
      sessionId: 'sess-promoted',
      text: 'partial reply',
      thinking: 'thinking...',
    });
    // After promotion, the old key transparently redirects to the promoted snapshot
    expect(bot.getStreamSnapshot('codex:pending_dashboard')).toMatchObject({
      sessionId: 'sess-promoted',
    });

    const runtime = bot.sessionStates.get('codex:sess-promoted');
    expect(runtime?.runningTaskIds.size ?? 0).toBe(0);
    expect(bot.activeTasks.size).toBe(0);
    expect(bot.sessionStates.has('codex:pending_dashboard')).toBe(false);
    }
  });
});

describe('Bot gitignore management', () => {
  it('keeps .pikiloop/skills tracked while ignoring managed runtime state', () => {
    const workdir = makeTmpDir('bot-unit-gitignore-');
    fs.writeFileSync(path.join(workdir, '.gitignore'), '.env\n.pikiloop/\n');
    process.env.PIKILOOP_WORKDIR = workdir;

    new Bot();

    expect(fs.readFileSync(path.join(workdir, '.gitignore'), 'utf8')).toBe([
      '.env',
      '.pikiloop/*',
      '!.pikiloop/skills/',
      '!.pikiloop/skills/**',
      '',
    ].join('\n'));
  });
});
