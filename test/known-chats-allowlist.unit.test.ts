/**
 * Regression for #22: persisted "known chats" (recorded so the startup notice
 * can greet them) must never be folded into `allowedChatIds`. The allowlist is
 * explicit-only — `_isAllowed()` treats a non-empty set as allowlist-only mode,
 * so polluting it with known chats silently blocks every new chat. This also
 * guards the restart hand-off env, which must not smuggle known chats back into
 * the allowlist on the next boot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { TelegramBot } from '../src/channels/telegram/bot.ts';
import { FeishuBot } from '../src/channels/feishu/bot.ts';
import { recordKnownChatId } from '../src/core/config/user-config.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';

const ENV_KEYS = [
  'PIKILOOM_CONFIG', 'PIKILOOM_WORKDIR', 'PIKILOOM_ALLOWED_IDS',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ALLOWED_CHAT_IDS',
] as const;

const snapshot = captureEnv(ENV_KEYS);

beforeEach(() => {
  restoreEnv(snapshot);
  // Isolate setting.json so recordKnownChatId / loadKnownChatIds never touch the
  // real ~/.pikiloom/setting.json.
  process.env.PIKILOOM_CONFIG = path.join(makeTmpDir('known-allow-config-'), 'setting.json');
  process.env.PIKILOOM_WORKDIR = makeTmpDir('known-allow-work-');
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.FEISHU_APP_ID = 'test-app';
  process.env.FEISHU_APP_SECRET = 'test-secret';
  delete process.env.PIKILOOM_ALLOWED_IDS;
  delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  delete process.env.FEISHU_ALLOWED_CHAT_IDS;
});

describe('known chats never pollute the allowlist (regression for #22)', () => {
  it('Telegram: known chats stay out of allowedChatIds, config reload, and restart env', () => {
    recordKnownChatId('telegram', '12345');
    recordKnownChatId('telegram', '67890');

    const bot = new TelegramBot();
    // No explicit allowlist configured -> stays empty so the channel allows all
    // chats (size === 0 means allow-all in _isAllowed()).
    expect((bot as any).allowedChatIds.size).toBe(0);
    expect((bot as any).allowedChatIds.has(12345)).toBe(false);

    // A config reload must not fold known chats back in.
    (bot as any).onManagedConfigChange({}, { initial: true });
    expect((bot as any).allowedChatIds.size).toBe(0);

    // Restart hand-off must not carry known chats in the allowlist env.
    const env = (bot as any).buildRestartEnv();
    expect(env.TELEGRAM_ALLOWED_CHAT_IDS).toBeUndefined();
  });

  it('Telegram: an explicit allowlist is preserved without absorbing known chats', () => {
    recordKnownChatId('telegram', '12345');
    process.env.PIKILOOM_ALLOWED_IDS = '999';

    const bot = new TelegramBot();
    expect([...(bot as any).allowedChatIds]).toEqual([999]);
    expect((bot as any).allowedChatIds.has(12345)).toBe(false);

    const env = (bot as any).buildRestartEnv();
    expect(env.TELEGRAM_ALLOWED_CHAT_IDS).toBe('999');
  });

  it('Feishu: known chats stay out of allowedChatIds and the restart env', () => {
    recordKnownChatId('feishu', 'oc_known1');
    recordKnownChatId('feishu', 'oc_known2');

    const bot = new FeishuBot();
    expect((bot as any).allowedChatIds.size).toBe(0);
    expect((bot as any).allowedChatIds.has('oc_known1')).toBe(false);

    const env = (bot as any).buildRestartEnv();
    expect(env.FEISHU_ALLOWED_CHAT_IDS).toBeUndefined();
  });

  it('Feishu: an explicit allowlist is preserved without absorbing known chats', () => {
    recordKnownChatId('feishu', 'oc_known');
    process.env.FEISHU_ALLOWED_CHAT_IDS = 'oc_allow';

    const bot = new FeishuBot();
    expect([...(bot as any).allowedChatIds]).toEqual(['oc_allow']);
    expect((bot as any).allowedChatIds.has('oc_known')).toBe(false);

    const env = (bot as any).buildRestartEnv();
    expect(env.FEISHU_ALLOWED_CHAT_IDS).toBe('oc_allow');
  });
});
