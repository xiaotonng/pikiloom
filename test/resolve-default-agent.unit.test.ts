import { describe, expect, it } from 'vitest';

import { resolveDefaultAgent } from '../src/agent/index.ts';
import type { AgentInfo } from '../src/agent/index.ts';

function info(agent: AgentInfo['agent'], installed: boolean): AgentInfo {
  return { agent, installed, path: installed ? `/usr/bin/${agent}` : null, version: null };
}

const ALL_INSTALLED: AgentInfo[] = [
  info('claude', true), info('codex', true), info('gemini', true), info('hermes', true),
];
const ONLY_CLAUDE: AgentInfo[] = [
  info('claude', true), info('codex', false), info('gemini', false), info('hermes', false),
];
const NONE_INSTALLED: AgentInfo[] = [
  info('claude', false), info('codex', false), info('gemini', false), info('hermes', false),
];

describe('resolveDefaultAgent', () => {
  it('keeps the preference when its CLI is installed (codex default unaffected)', () => {
    expect(resolveDefaultAgent('codex', ALL_INSTALLED)).toBe('codex');
    expect(resolveDefaultAgent('claude', ALL_INSTALLED)).toBe('claude');
  });

  it('clamps to the first installed agent when the preference is not installed', () => {
    // The reported bug: machine without codex must not default to codex.
    expect(resolveDefaultAgent('codex', ONLY_CLAUDE)).toBe('claude');
  });

  it('picks the first installed agent (registration order) when no preference is given', () => {
    expect(resolveDefaultAgent('', ONLY_CLAUDE)).toBe('claude');
    expect(resolveDefaultAgent(undefined, ALL_INSTALLED)).toBe('claude');
  });

  it('falls back to a valid preference when nothing is installed', () => {
    expect(resolveDefaultAgent('codex', NONE_INSTALLED)).toBe('codex');
    expect(resolveDefaultAgent('gemini', NONE_INSTALLED)).toBe('gemini');
  });

  it('defaults to codex when neither preference nor installs resolve', () => {
    expect(resolveDefaultAgent('', NONE_INSTALLED)).toBe('codex');
    expect(resolveDefaultAgent('not-an-agent', NONE_INSTALLED)).toBe('codex');
  });

  it('ignores an invalid preference and clamps to an installed agent', () => {
    expect(resolveDefaultAgent('not-an-agent', ONLY_CLAUDE)).toBe('claude');
  });
});
