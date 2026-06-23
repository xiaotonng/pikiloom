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
    {
      const { ch, patchMock } = createTestChannel();
      patchMock.mockResolvedValue({ code: 0, msg: 'success', data: {} });
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: 'updated text' }),
      ).resolves.toBeUndefined();
      expect(patchMock).toHaveBeenCalledTimes(1);
    }

    {
      const { ch, patchMock } = createTestChannel();
      patchMock.mockResolvedValue({ code: 99991401, msg: 'content not modified' });
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: 'same' }),
      ).resolves.toBeUndefined();
    }

    {
      const { ch, patchMock } = createTestChannel();
      patchMock.mockRejectedValue(new Error('content not modified'));
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: 'same' }),
      ).resolves.toBeUndefined();
    }

    {
      const { ch, patchMock } = createTestChannel();
      await expect(
        ch.editCard('chat1', 'msg1', { markdown: '' }),
      ).resolves.toBeUndefined();
      expect(patchMock).not.toHaveBeenCalled();
    }
  });

  it('throws feishuEditFailed for non-zero application errors and real network errors', async () => {
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
