/**
 * Unit tests for FeishuChannel — verifying the editCard / send-fresh fallback
 * behaviour that fixes silent-failure of stream / final-reply edits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuChannel } from '../src/channels/feishu/channel.ts';

function createTestChannel() {
  const ch = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });
  const patchMock = vi.fn();
  const createMock = vi.fn();
  const replyMock = vi.fn();
  (ch as any).client = {
    im: {
      message: {
        patch: patchMock,
        create: createMock,
        reply: replyMock,
        delete: vi.fn(async () => ({ code: 0 })),
      },
    },
    request: vi.fn(),
  };
  return { ch, patchMock, createMock, replyMock };
}

describe('FeishuChannel.editCard', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('succeeds silently, swallows not-modified responses, and no-ops on empty markdown', async () => {
    // returns silently when patch succeeds (code === 0)
    {
      const { ch, patchMock } = createTestChannel();
      patchMock.mockResolvedValue({ code: 0, msg: 'success', data: {} });
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: 'updated text' }),
      ).resolves.toBeUndefined();
      expect(patchMock).toHaveBeenCalledTimes(1);
    }

    // swallows "not modified" response (content unchanged is a no-op)
    {
      const { ch, patchMock } = createTestChannel();
      patchMock.mockResolvedValue({ code: 99991401, msg: 'content not modified' });
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: 'same' }),
      ).resolves.toBeUndefined();
    }

    // swallows thrown "not modified" errors from older SDK paths
    {
      const { ch, patchMock } = createTestChannel();
      patchMock.mockRejectedValue(new Error('content not modified'));
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: 'same' }),
      ).resolves.toBeUndefined();
    }

    // no-ops when markdown is empty
    {
      const { ch, patchMock } = createTestChannel();
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: '' }),
      ).resolves.toBeUndefined();
      expect(patchMock).not.toHaveBeenCalled();
    }
  });

  it('throws feishuEditFailed for non-zero application errors and real network errors', async () => {
    // throws a feishuEditFailed error when Feishu returns code !== 0 with HTTP 200
    // This is the silent-failure path before the fix: SDK does not throw on
    // application errors, it just returns the body. editCard must detect
    // the non-zero code and throw so callers can fall back to a fresh send.
    {
      const { ch, patchMock } = createTestChannel();
      patchMock.mockResolvedValue({ code: 230020, msg: 'edit is not allowed for this message' });
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: 'updated text' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('edit card failed'),
        feishuEditFailed: true,
        feishuCode: 230020,
      });
    }

    // re-throws real network errors with feishuEditFailed tag
    {
      const { ch, patchMock } = createTestChannel();
      patchMock.mockRejectedValue(new Error('socket hang up'));
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: 'x' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('socket hang up'),
        feishuEditFailed: true,
      });
    }
  });
});
