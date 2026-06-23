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
    expect(decodeCommandAction('sess:')).toBeNull();
    expect(decodeCommandAction('ag:notAnAgent')).toBeNull();
    expect(decodeCommandAction('sp:-1')).toBeNull();
    expect(decodeCommandAction('sp:abc')).toBeNull();
    expect(decodeCommandAction('wf:')).toBeNull();
    expect(decodeCommandAction('wf:2')).toBeNull();
  });

  it('keeps typical encoded payloads short enough for IM button callbacks (<= 64 bytes)', () => {
    for (const action of samples) {
      expect(Buffer.byteLength(encodeCommandAction(action))).toBeLessThanOrEqual(64);
    }
  });

  it('a realistic BYOK model pick overflows the raw codec (why the registry exists)', () => {
    const action: CommandAction = {
      kind: 'models.select.model',
      modelId: 'deepseek/deepseek-chat-v3-0324',
      profileId: '7f3c1a2b-9d4e-4f60-8a11-2c3d4e5f6a7b',
    };
    expect(Buffer.byteLength(encodeCommandAction(action))).toBeGreaterThan(64);
    expect(decodeCommandAction(encodeCommandAction(action))).toEqual(action);
  });
});
