import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractLastSessionTurn } from '../src/bot/commands.ts';
import { getSessionTail } from '../src/agent/index.ts';
import { withTempHome } from './support/env.ts';

// Regression suite for the IM session-selection preview ("Recent Context") showing a raw
// harness-injected <task-notification> record instead of the user's actual question.

const TASK_NOTIFICATION = [
  '<task-notification>',
  '<task-id>a9e6baa2fb0728355</task-id>',
  '<tool-use-id>toolu_013VEgMTbMgStg3PNb2taGtQ</tool-use-id>',
  '<output-file>/private/tmp/claude-501/tasks/a9e6baa2fb0728355.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "Map pikiloom server-side src/" finished</summary>',
  '<note>A task-notification fires each time this agent stops.</note>',
  '</task-notification>',
].join('\n');

describe('extractLastSessionTurn', () => {
  it('anchors on the real user question, not a trailing harness-injected record', () => {
    const turn = extractLastSessionTurn([
      { role: 'user', text: '帮我梳理一下 server-side src 的结构' },
      { role: 'assistant', text: '好的，我起了一个后台 agent 来梳理。' },
      { role: 'user', text: TASK_NOTIFICATION },
      { role: 'assistant', text: '梳理完成：src 分为 core/agent/bot/channels 四层。' },
    ]);
    expect(turn?.userText).toBe('帮我梳理一下 server-side src 的结构');
    expect(turn?.assistantText).toContain('后台 agent');
    expect(turn?.assistantText).toContain('四层');
    expect(turn?.assistantText).not.toContain('task-notification');
  });

  it('skips <system-reminder> records and interrupt markers too', () => {
    const turn = extractLastSessionTurn([
      { role: 'user', text: 'real question' },
      { role: 'assistant', text: 'real answer' },
      { role: 'user', text: '<system-reminder>background context</system-reminder>' },
      { role: 'user', text: '[Request interrupted by user]' },
    ]);
    expect(turn?.userText).toBe('real question');
    expect(turn?.assistantText).toBe('real answer');
  });

  it('falls back to assistant-only when every user record is synthetic', () => {
    const turn = extractLastSessionTurn([
      { role: 'user', text: TASK_NOTIFICATION },
      { role: 'assistant', text: 'continuation after wake-up' },
    ]);
    expect(turn?.userText).toBeNull();
    expect(turn?.assistantText).toBe('continuation after wake-up');
  });
});

describe('claude getSessionTail', () => {
  it('drops harness-injected user events, isMeta records, and synthetic resume noise', async () => {
    await withTempHome(async (homeDir) => {
      const workdir = '/Users/test/preview';
      const projectDir = path.join(homeDir, '.claude', 'projects', '-Users-test-preview');
      const sessionId = 'sess-preview';
      fs.mkdirSync(projectDir, { recursive: true });
      const events = [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '帮我梳理一下 src 的结构' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '好的，起了一个后台 agent。' }] } },
        // Harness-injected wake-up record: string content, so extractClaudeText cannot
        // skip it as a system block — the tag filter must catch it.
        { type: 'user', message: { role: 'user', content: TASK_NOTIFICATION } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '梳理完成。' }] } },
        { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
        { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), events.map(e => JSON.stringify(e)).join('\n'));

      const tail = await getSessionTail({ agent: 'claude', sessionId, workdir, limit: 10 });
      expect(tail.ok).toBe(true);
      expect(tail.messages).toEqual([
        { role: 'user', text: '帮我梳理一下 src 的结构' },
        { role: 'assistant', text: '好的，起了一个后台 agent。' },
        { role: 'assistant', text: '梳理完成。' },
      ]);

      const turn = extractLastSessionTurn(tail.messages);
      expect(turn?.userText).toBe('帮我梳理一下 src 的结构');
      expect(turn?.assistantText).toBe('好的，起了一个后台 agent。\n\n梳理完成。');
    });
  });
});
