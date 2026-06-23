import { describe, expect, it, vi } from 'vitest';
import { LivePreview, type LivePreviewRenderer, type PreviewChannel } from '../src/channels/telegram/live-preview.ts';

const renderer: LivePreviewRenderer = {
  renderInitial: () => 'initial',
  renderStream: ({ bodyText }) => `stream:${bodyText}`,
};

function createChannel() {
  const editMessage = vi.fn();
  const sendTyping = vi.fn(async () => {});
  const channel: PreviewChannel = {
    editMessage,
    sendTyping,
  };
  return { channel, editMessage };
}

async function flush(preview: LivePreview) {
  await (preview as any).editChain;
}

describe('LivePreview placeholder lifecycle', () => {
  it('abandons on consecutive failures, resets counter on success, and no-ops without a placeholder', async () => {
    {
      const { channel, editMessage } = createChannel();
      editMessage.mockRejectedValue(Object.assign(new Error('edit card failed: code=230020'), { feishuEditFailed: true }));
      const preview = new LivePreview({
        agent: 'claude',
        chatId: 'c1',
        placeholderMessageId: 'placeholder',
        channel,
        renderer,
        streamEditIntervalMs: 0,
        startTimeMs: Date.now(),
        canEditMessages: true,
        canSendTyping: false,
        log: () => {},
      });

      expect(preview.isPlaceholderAbandoned()).toBe(false);

      preview.update('text-1', '', '');
      await flush(preview);
      preview.update('text-2', '', '');
      await flush(preview);
      preview.update('text-3', '', '');
      await flush(preview);

      expect(preview.isPlaceholderAbandoned()).toBe(true);
      const callsAtAbandon = editMessage.mock.calls.length;

      preview.update('text-4', '', '');
      await flush(preview);
      preview.update('text-5', '', '');
      await flush(preview);
      expect(editMessage.mock.calls.length).toBe(callsAtAbandon);
    }

    {
      const { channel, editMessage } = createChannel();
      editMessage
        .mockRejectedValueOnce(new Error('blip-1'))
        .mockRejectedValueOnce(new Error('blip-2'))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('blip-3'))
        .mockResolvedValueOnce(undefined);

      const preview = new LivePreview({
        agent: 'claude',
        chatId: 'c1',
        placeholderMessageId: 'placeholder',
        channel,
        renderer,
        streamEditIntervalMs: 0,
        startTimeMs: Date.now(),
        canEditMessages: true,
        canSendTyping: false,
        log: () => {},
      });

      for (const txt of ['a', 'b', 'c', 'd', 'e']) {
        preview.update(txt, '', '');
        await flush(preview);
      }
      expect(preview.isPlaceholderAbandoned()).toBe(false);
    }

    {
      const { channel, editMessage } = createChannel();
      const preview = new LivePreview({
        agent: 'claude',
        chatId: 'c1',
        placeholderMessageId: null,
        channel,
        renderer,
        streamEditIntervalMs: 0,
        startTimeMs: Date.now(),
        canEditMessages: true,
        canSendTyping: false,
        log: () => {},
      });
      preview.update('hello', '', '');
      await flush(preview);
      expect(editMessage).not.toHaveBeenCalled();
      expect(preview.isPlaceholderAbandoned()).toBe(false);
    }
  });
});
