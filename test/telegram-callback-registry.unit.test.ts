import { describe, expect, it } from 'vitest';
import {
  renderCommandSelectionKeyboard,
  unpackCallbackData,
} from '../src/channels/telegram/render.ts';
import {
  decodeCommandAction,
  type CommandActionButton,
  type CommandSelectionView,
} from '../src/bot/command-ui.ts';

function viewWith(rows: CommandActionButton[][]): CommandSelectionView {
  return { kind: 'models', title: 'Models', metaLines: [], items: [], rows };
}

describe('Telegram callback_data registry', () => {
  it('packs an over-length BYOK model action under Telegram’s 64-byte cap', () => {
    const action = {
      kind: 'models.select.model' as const,
      modelId: 'deepseek/deepseek-chat-v3-0324',
      profileId: '7f3c1a2b-9d4e-4f60-8a11-2c3d4e5f6a7b',
    };
    const keyboard = renderCommandSelectionKeyboard(viewWith([[{ label: 'DeepSeek', action }]]))!;
    const data = keyboard.inline_keyboard[0][0].callback_data;

    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(data.startsWith('r:')).toBe(true);
    expect(decodeCommandAction(unpackCallbackData(data))).toEqual(action);
  });

  it('leaves short actions untouched (no needless indirection)', () => {
    const action = { kind: 'models.select.model' as const, modelId: 'gpt-5', profileId: null };
    const keyboard = renderCommandSelectionKeyboard(viewWith([[{ label: 'GPT-5', action }]]))!;
    const data = keyboard.inline_keyboard[0][0].callback_data;

    expect(data).toBe('md:n:gpt-5');
    expect(decodeCommandAction(unpackCallbackData(data))).toEqual(action);
  });

  it('every button in a mixed menu stays within the 64-byte cap', () => {
    const rows: CommandActionButton[][] = [
      [{ label: '— Cloud Profiles —', action: { kind: 'models.confirm' } }],
      [{ label: 'A', action: { kind: 'models.select.model', modelId: 'qwen/qwen-2.5-72b-instruct', profileId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }],
      [{ label: 'B', action: { kind: 'models.select.model', modelId: 'meta-llama/llama-3.1-405b-instruct', profileId: '11111111-2222-3333-4444-555555555555' } }],
    ];
    const keyboard = renderCommandSelectionKeyboard(viewWith(rows))!;
    for (const row of keyboard.inline_keyboard) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64);
      }
    }
  });

  it('passes through unknown / stale tokens instead of throwing', () => {
    expect(unpackCallbackData('r:999999')).toBe('r:999999');
    expect(unpackCallbackData('md:n:gpt-5')).toBe('md:n:gpt-5');
    expect(decodeCommandAction(unpackCallbackData('r:999999'))).toBeNull();
  });
});
