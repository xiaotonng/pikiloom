import { describe, expect, it } from 'vitest';

import { getAgentInstall, getAgentInstallCommand, getAgentPackage } from '../src/agent/npm.ts';

const NPM_AGENTS: ReadonlyArray<readonly [string, string]> = [
  ['claude', '@anthropic-ai/claude-code'],
  ['codex', '@openai/codex'],
  ['gemini', '@google/gemini-cli'],
];

describe('agent install specs', () => {
  it('npm agents resolve to an npm spec derived from their package (no drift)', () => {
    for (const [agent, pkg] of NPM_AGENTS) {
      const spec = getAgentInstall(agent);
      expect(spec, agent).not.toBeNull();
      expect(spec!.method).toBe('npm');
      expect(spec!.command).toBe(`npm install -g ${pkg}`);
      expect(getAgentInstallCommand(agent)).toBe(`npm install -g ${pkg}`);
    }
  });

  it('hermes is a manual install, never npm (regression: "Unsupported agent: hermes")', () => {
    expect(getAgentPackage('hermes')).toBeNull();

    const spec = getAgentInstall('hermes');
    expect(spec).not.toBeNull();
    expect(spec!.method).toBe('manual');
    expect(spec!.command).toMatch(/install\.sh/);
    expect(spec!.docsUrl).toBeTruthy();
    expect(spec!.note).toBeTruthy();
    expect(getAgentInstallCommand('hermes')).toBe(spec!.command);
  });

  it('unknown agents have no install spec', () => {
    expect(getAgentInstall('bogus')).toBeNull();
    expect(getAgentInstallCommand('bogus')).toBeNull();
  });
});
