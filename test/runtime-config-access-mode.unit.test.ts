import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveClaudeAccessMode,
  claudeAccessModeEnv,
  setClaudeAccessModeEnv,
  DEFAULT_CLAUDE_ACCESS_MODE,
} from '../src/core/config/runtime-config.js';

describe('resolveClaudeAccessMode', () => {
  const ENV_KEYS = ['PIKILOOM_CLAUDE_PRINT', 'PIKILOOM_CLAUDE_TUI'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to api (claude -p) with no config and no env', () => {
    expect(resolveClaudeAccessMode({})).toBe('api');
    expect(DEFAULT_CLAUDE_ACCESS_MODE).toBe('api');
  });

  it('honours the persisted config field over everything', () => {
    expect(resolveClaudeAccessMode({ claudeAccessMode: 'api' })).toBe('api');
    expect(resolveClaudeAccessMode({ claudeAccessMode: 'subscription' })).toBe('subscription');
    process.env.PIKILOOM_CLAUDE_PRINT = '1';
    expect(resolveClaudeAccessMode({ claudeAccessMode: 'subscription' })).toBe('subscription');
  });

  it('falls back to env when config is unset', () => {
    process.env.PIKILOOM_CLAUDE_PRINT = '1';
    expect(resolveClaudeAccessMode({})).toBe('api');
    delete process.env.PIKILOOM_CLAUDE_PRINT;
    process.env.PIKILOOM_CLAUDE_TUI = '0';
    expect(resolveClaudeAccessMode({})).toBe('api');
  });

  it('PIKILOOM_CLAUDE_PRINT takes precedence over a stale legacy TUI var', () => {
    process.env.PIKILOOM_CLAUDE_PRINT = '0';
    process.env.PIKILOOM_CLAUDE_TUI = '0';
    expect(claudeAccessModeEnv()).toBe('subscription');
    expect(resolveClaudeAccessMode({})).toBe('subscription');
  });

  it('ignores an invalid config value and falls through to the default', () => {
    expect(resolveClaudeAccessMode({ claudeAccessMode: 'bogus' as never })).toBe('api');
  });

  it('setClaudeAccessModeEnv round-trips through the env reader', () => {
    setClaudeAccessModeEnv('api');
    expect(process.env.PIKILOOM_CLAUDE_PRINT).toBe('1');
    expect(claudeAccessModeEnv()).toBe('api');
    setClaudeAccessModeEnv('subscription');
    expect(process.env.PIKILOOM_CLAUDE_PRINT).toBe('0');
    expect(claudeAccessModeEnv()).toBe('subscription');
  });
});
