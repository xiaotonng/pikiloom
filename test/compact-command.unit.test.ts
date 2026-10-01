import { describe, expect, it, vi } from 'vitest';
import { handleCompactCommand } from '../src/bot/commands.ts';

describe('handleCompactCommand', () => {
  it('reports failure when bot has no active session to compact', async () => {
    const mockBot = {
      compactConversationForChat: vi.fn().mockResolvedValue({
        ok: false,
        error: 'No active session to compact.',
      }),
    };

    const res = await handleCompactCommand(mockBot as any, 123);
    expect(mockBot.compactConversationForChat).toHaveBeenCalledWith(123);
    expect(res).toContain('Compact failed: No active session to compact.');
  });

  it('reports success with message and turn statistics', async () => {
    const mockBot = {
      compactConversationForChat: vi.fn().mockResolvedValue({
        ok: true,
        sessionId: 'abc12345-6789',
        messagesIncluded: 6,
        messagesTotal: 30,
        turnsTotal: 15,
        charsIncluded: 4200,
      }),
    };

    const res = await handleCompactCommand(mockBot as any, 456);
    expect(mockBot.compactConversationForChat).toHaveBeenCalledWith(456);
    expect(res).toContain('Compacted session abc12345:');
    expect(res).toContain('Retained 6/30 messages across 15 turns (~4200 chars).');
    expect(res).toContain('Send a message to continue in a fresh session with this context.');
  });
});
