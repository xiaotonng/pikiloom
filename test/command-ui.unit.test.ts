/**
 * Tests for the shared command-UI action codec.
 *
 * Telegram and Feishu encode `CommandAction` values into 64-byte button
 * callback strings; WeChat (no card support) uses the same codec as the
 * `value` field of `HumanLoopQuestion.options`. A round-trip regression here
 * would silently break interactive `/agents` / `/models` / `/sessions` flows
 * on every IM, so we cover the full surface explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeCommandAction,
  encodeCommandAction,
  type CommandAction,
} from '../src/bot/command-ui.ts';

describe('CommandAction codec', () => {
  const samples: CommandAction[] = [
    { kind: 'sessions.page', page: 0 },
    { kind: 'sessions.page', page: 7 },
    { kind: 'session.new' },
    { kind: 'session.switch', sessionId: 'abc-123-def' },
    { kind: 'agent.switch', agent: 'claude' },
    { kind: 'agent.switch', agent: 'codex' },
    { kind: 'agent.switch', agent: 'gemini' },
    { kind: 'agent.switch', agent: 'hermes' },
    { kind: 'model.switch', modelId: 'claude-opus-4-7' },
    { kind: 'effort.set', effort: 'xhigh' },
    // Two flavours: native pick (profileId: null) and BYOK Profile pick
    // (profileId: uuid). Both round-trip through the codec.
    { kind: 'models.select.model', modelId: 'gpt-5', profileId: null },
    { kind: 'models.select.model', modelId: 'gpt-5', profileId: 'prof-xyz-1' },
    { kind: 'models.select.effort', effort: 'medium' },
    { kind: 'models.confirm' },
    { kind: 'skill.run', command: 'sk_review' },
    { kind: 'mode.switch', mode: 'plan' },
    { kind: 'mode.switch', mode: 'bypassPermissions' },
    { kind: 'workflow.toggle', enabled: true },
    { kind: 'workflow.toggle', enabled: false },
  ];

  it('round-trips every CommandAction kind', () => {
    for (const action of samples) {
      const encoded = encodeCommandAction(action);
      const decoded = decodeCommandAction(encoded);
      expect(decoded).toEqual(action);
    }
  });

  it('rejects malformed payloads', () => {
    expect(decodeCommandAction('')).toBeNull();
    expect(decodeCommandAction('unknown:foo')).toBeNull();
    expect(decodeCommandAction('sess:')).toBeNull();   // empty sessionId
    expect(decodeCommandAction('ag:notAnAgent')).toBeNull();
    expect(decodeCommandAction('sp:-1')).toBeNull();   // negative page
    expect(decodeCommandAction('sp:abc')).toBeNull();  // non-numeric page
    expect(decodeCommandAction('wf:')).toBeNull();     // missing flag
    expect(decodeCommandAction('wf:2')).toBeNull();    // non-boolean flag
  });

  it('keeps typical encoded payloads short enough for IM button callbacks (<= 64 bytes)', () => {
    // Telegram limits inline button callback data to 64 bytes. Short native ids
    // fit comfortably; long BYOK ids (uuid + provider/model) can overflow and
    // are handled by the Telegram callback registry (see telegram-render test),
    // not by this codec — so here we only assert the common short case.
    for (const action of samples) {
      expect(Buffer.byteLength(encodeCommandAction(action))).toBeLessThanOrEqual(64);
    }
  });

  it('a realistic BYOK model pick overflows the raw codec (why the registry exists)', () => {
    // Regression guard for the BUTTON_DATA_INVALID crash: `md:p:<uuid>:<id>`
    // carries ~42 bytes of overhead, so any normal provider/model id tips it
    // past 64. Documenting it here keeps the Telegram registry honest.
    const action: CommandAction = {
      kind: 'models.select.model',
      modelId: 'deepseek/deepseek-chat-v3-0324',
      profileId: '7f3c1a2b-9d4e-4f60-8a11-2c3d4e5f6a7b',
    };
    expect(Buffer.byteLength(encodeCommandAction(action))).toBeGreaterThan(64);
    // ...but it must still round-trip once resolved back from the registry.
    expect(decodeCommandAction(encodeCommandAction(action))).toEqual(action);
  });
});
