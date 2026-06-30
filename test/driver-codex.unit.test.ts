import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSessionMessages, shutdownCodexServer } from '../src/agent/index.ts';
import { withTempHome } from './support/env.ts';

afterEach(() => {
  shutdownCodexServer();
});

describe('Codex session history', () => {
  it('reconstructs rich history (commentary/tools/plan/thinking) and surfaces generated images', async () => {
    await withTempHome(async homeDir => {
      const workdir = path.join(homeDir, 'project');
      const workspacePath = path.join(workdir, '.pikiloom', 'sessions', 'codex', 'sess-rich', 'workspace');
      const rolloutDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '29');
      fs.mkdirSync(workdir, { recursive: true });
      fs.mkdirSync(workspacePath, { recursive: true });
      fs.mkdirSync(rolloutDir, { recursive: true });

      const rolloutPath = path.join(rolloutDir, 'rollout-2026-03-29T10-25-14-test.jsonl');
      fs.writeFileSync(rolloutPath, [
        JSON.stringify({
          timestamp: '2026-03-29T10:25:14.000Z',
          type: 'session_meta',
          payload: { id: 'sess-rich', cwd: workdir },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T10:25:15.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Please fix the live preview.' },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T10:25:16.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'Tracing the Codex stream pipeline first.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T10:25:17.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_exec_1',
            arguments: JSON.stringify({ cmd: 'rg -n "activity|thinking|plan" src dashboard' }),
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T10:25:18.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_exec_1',
            output: 'src/bot.ts:610:          snap.plan = event.plan?.steps?.length ? event.plan : null;',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T10:25:19.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'call_plan_1',
            arguments: JSON.stringify({
              explanation: 'Keep completion previews and rebuild Codex rich history.',
              plan: [
                { step: 'Preserve done snapshot text/thinking/activity', status: 'completed' },
                { step: 'Parse rollout response items into rich messages', status: 'completed' },
                { step: 'Render historical plan blocks in SessionPanel', status: 'completed' },
              ],
            }),
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T10:25:20.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_plan_1',
            output: 'Plan updated',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-29T10:25:21.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Fixed the panel to keep activity, thinking, and plan after completion.' }],
          },
        }),
      ].join('\n'));

      const sessionIndexPath = path.join(workdir, '.pikiloom', 'sessions', 'index.json');
      fs.mkdirSync(path.dirname(sessionIndexPath), { recursive: true });
      fs.writeFileSync(sessionIndexPath, JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: 'sess-rich',
            agent: 'codex',
            workdir,
            workspacePath,
            threadId: 'legacy:codex:sess-rich',
            createdAt: '2026-03-29T10:25:14.000Z',
            updatedAt: '2026-03-29T10:25:22.000Z',
            title: 'Fix Codex live preview',
            model: 'gpt-5.4',
            stagedFiles: [],
            runState: 'completed',
            runDetail: null,
            runUpdatedAt: '2026-03-29T10:25:22.000Z',
            classification: null,
            userStatus: null,
            userNote: null,
            lastQuestion: 'Please fix the live preview.',
            lastAnswer: 'Fixed the panel to keep activity, thinking, and plan after completion.',
            lastMessageText: 'Fixed the panel to keep activity, thinking, and plan after completion.',
            lastThinking: 'Overlay thinking recovered from session metadata.',
            lastPlan: null,
            migratedFrom: null,
            migratedTo: null,
            linkedSessions: [],
          },
        ],
      }, null, 2));

      const result = await getSessionMessages({
        agent: 'codex',
        sessionId: 'sess-rich',
        workdir,
        rich: true,
      });

      expect(result.ok).toBe(true);
      expect(result.messages).toEqual([
        { role: 'user', text: 'Please fix the live preview.' },
        { role: 'assistant', text: 'Fixed the panel to keep activity, thinking, and plan after completion.' },
      ]);

      const assistant = result.richMessages?.[1];
      expect(assistant).toBeTruthy();
      expect(assistant?.blocks.map(block => block.type)).toEqual([
        'text',
        'tool_use',
        'tool_result',
        'plan',
        'thinking',
        'text',
      ]);
      expect(assistant?.blocks[0]).toMatchObject({
        type: 'text',
        phase: 'commentary',
        content: 'Tracing the Codex stream pipeline first.',
      });
      expect(assistant?.blocks[1]).toMatchObject({
        type: 'tool_use',
        toolName: 'exec_command',
      });
      expect(assistant?.blocks[2]).toMatchObject({
        type: 'tool_result',
        toolId: 'call_exec_1',
      });
      expect(assistant?.blocks[3].plan).toEqual({
        explanation: 'Keep completion previews and rebuild Codex rich history.',
        steps: [
          { step: 'Preserve done snapshot text/thinking/activity', status: 'completed' },
          { step: 'Parse rollout response items into rich messages', status: 'completed' },
          { step: 'Render historical plan blocks in SessionPanel', status: 'completed' },
        ],
      });
      expect(assistant?.blocks[4]).toMatchObject({
        type: 'thinking',
        content: 'Overlay thinking recovered from session metadata.',
      });
      expect(assistant?.blocks[5]).toMatchObject({
        type: 'text',
        phase: 'final_answer',
        content: 'Fixed the panel to keep activity, thinking, and plan after completion.',
      });
    });

    await withTempHome(async homeDir => {
      const sessionId = 'sess-img';
      const workdir = path.join(homeDir, 'project');
      const workspacePath = path.join(workdir, '.pikiloom', 'sessions', 'codex', sessionId, 'workspace');
      const rolloutDir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '23');
      const imageDir = path.join(homeDir, '.codex', 'generated_images', sessionId);
      const imageId = 'ig_test_image_id';
      const imagePath = path.join(imageDir, `${imageId}.png`);
      fs.mkdirSync(workdir, { recursive: true });
      fs.mkdirSync(workspacePath, { recursive: true });
      fs.mkdirSync(rolloutDir, { recursive: true });
      fs.mkdirSync(imageDir, { recursive: true });

      const pngBytes = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
        + '890000000a49444154789c63000100000005000156c2c4360000000049454e44ae426082',
        'hex',
      );
      fs.writeFileSync(imagePath, pngBytes);

      const rolloutPath = path.join(rolloutDir, `rollout-2026-05-23T15-26-11-${sessionId}.jsonl`);
      fs.writeFileSync(rolloutPath, [
        JSON.stringify({ timestamp: '2026-05-23T15:26:14Z', type: 'session_meta', payload: { id: sessionId, cwd: workdir } }),
        JSON.stringify({ timestamp: '2026-05-23T15:26:16Z', type: 'event_msg', payload: { type: 'user_message', message: 'generate a cover image' } }),
        JSON.stringify({
          timestamp: '2026-05-23T15:27:43Z',
          type: 'response_item',
          payload: {
            type: 'image_generation_call',
            id: imageId,
            status: 'generating',
            revised_prompt: 'Use case: infographic-diagram\nPrimary request: cover image',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-23T15:27:50Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Done — generated the cover image.' }],
          },
        }),
      ].join('\n'));

      const result = await getSessionMessages({ agent: 'codex', sessionId, workdir, rich: true });
      expect(result.ok).toBe(true);

      const assistant = result.richMessages?.find(m => m.role === 'assistant');
      expect(assistant).toBeTruthy();
      const imageBlock = assistant?.blocks.find(b => b.type === 'image');
      expect(imageBlock).toBeTruthy();
      expect(imageBlock?.imagePath).toBe(imagePath);
      expect(imageBlock?.imageMime).toBe('image/png');
      expect(imageBlock?.imageCaption).toContain('infographic-diagram');
      expect(imageBlock?.content.startsWith('data:image/png;base64,')).toBe(true);
    });
  });

  it('reconstructs a user-attached (pasted) image from a rollout input_image item', async () => {
    await withTempHome(async homeDir => {
      const sessionId = 'sess-userimg';
      const workdir = path.join(homeDir, 'project');
      const workspacePath = path.join(workdir, '.pikiloom', 'sessions', 'codex', sessionId, 'workspace');
      const rolloutDir = path.join(homeDir, '.codex', 'sessions', '2026', '06', '30');
      fs.mkdirSync(workspacePath, { recursive: true });
      fs.mkdirSync(rolloutDir, { recursive: true });

      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const imgPath = path.join(workspacePath, '2026-06-30_17-20-21.png');

      // Codex writes the user turn TWICE: a rich response_item (role=user) that carries the image as
      // an input_image data URL, then a text-only event_msg/user_message. The bubble is built from the
      // latter, so the image must be recovered from the former — this is the regression under test.
      const rolloutPath = path.join(rolloutDir, `rollout-2026-06-30T18-01-28-${sessionId}.jsonl`);
      fs.writeFileSync(rolloutPath, [
        JSON.stringify({ timestamp: '2026-06-30T18:01:28Z', type: 'session_meta', payload: { id: sessionId, cwd: workdir } }),
        JSON.stringify({
          timestamp: '2026-06-30T18:01:29Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: `<image: ${imgPath}>` },
              { type: 'input_image', image_url: dataUrl, detail: 'high' },
            ],
          },
        }),
        JSON.stringify({ timestamp: '2026-06-30T18:01:29Z', type: 'event_msg', payload: { type: 'user_message', message: '你能看到这张图吗' } }),
        JSON.stringify({
          timestamp: '2026-06-30T18:01:40Z',
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '能看到，是一张登录报错截图。' }] },
        }),
      ].join('\n'));

      const result = await getSessionMessages({ agent: 'codex', sessionId, workdir, rich: true });
      expect(result.ok).toBe(true);

      const user = result.richMessages?.find(m => m.role === 'user');
      expect(user).toBeTruthy();
      expect(user?.text).toBe('你能看到这张图吗');
      const imageBlock = user?.blocks.find(b => b.type === 'image');
      expect(imageBlock).toBeTruthy();
      expect(imageBlock?.content).toBe(dataUrl);
      // text block precedes the image block
      expect(user?.blocks[0]).toMatchObject({ type: 'text', content: '你能看到这张图吗' });
    });
  });
});
