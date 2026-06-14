import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveClaudeAccessMode,
  claudeAccessModeEnv,
  setClaudeAccessModeEnv,
  DEFAULT_CLAUDE_ACCESS_MODE,
} from '../src/core/config/runtime-config.js';

// resolveClaudeAccessMode is the single source of truth for whether a Claude
// turn spawns the interactive TUI (subscription quota) or `claude -p` (Agent
// SDK credit pool). Precedence: persisted config field → env default → built-in
// default. The env half must stay compatible with isClaudePrintModeForced() in
// the claude driver, which it mirrors.
describe('resolveClaudeAccessMode', () => {
  const ENV_KEYS = ['PIKICLAW_CLAUDE_PRINT', 'PIKICLAW_CLAUDE_TUI'] as const;
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

  it('defaults to subscription with no config and no env', () => {
    expect(resolveClaudeAccessMode({})).toBe('subscription');
    expect(DEFAULT_CLAUDE_ACCESS_MODE).toBe('subscription');
  });

  it('honours the persisted config field over everything', () => {
    expect(resolveClaudeAccessMode({ claudeAccessMode: 'api' })).toBe('api');
    expect(resolveClaudeAccessMode({ claudeAccessMode: 'subscription' })).toBe('subscription');
    process.env.PIKICLAW_CLAUDE_PRINT = '1';
    expect(resolveClaudeAccessMode({ claudeAccessMode: 'subscription' })).toBe('subscription');
  });

  it('falls back to env when config is unset', () => {
    process.env.PIKICLAW_CLAUDE_PRINT = '1';
    expect(resolveClaudeAccessMode({})).toBe('api');
    delete process.env.PIKICLAW_CLAUDE_PRINT;
    process.env.PIKICLAW_CLAUDE_TUI = '0'; // legacy "TUI off" ⇒ print/api
    expect(resolveClaudeAccessMode({})).toBe('api');
  });

  it('PIKICLAW_CLAUDE_PRINT takes precedence over a stale legacy TUI var', () => {
    process.env.PIKICLAW_CLAUDE_PRINT = '0';
    process.env.PIKICLAW_CLAUDE_TUI = '0';
    expect(claudeAccessModeEnv()).toBe('subscription');
    expect(resolveClaudeAccessMode({})).toBe('subscription');
  });

  it('ignores an invalid config value and falls through to the default', () => {
    expect(resolveClaudeAccessMode({ claudeAccessMode: 'bogus' as never })).toBe('subscription');
  });

  it('setClaudeAccessModeEnv round-trips through the env reader', () => {
    setClaudeAccessModeEnv('api');
    expect(process.env.PIKICLAW_CLAUDE_PRINT).toBe('1');
    expect(claudeAccessModeEnv()).toBe('api');
    setClaudeAccessModeEnv('subscription');
    expect(process.env.PIKICLAW_CLAUDE_PRINT).toBe('0');
    expect(claudeAccessModeEnv()).toBe('subscription');
  });
});
