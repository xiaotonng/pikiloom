/**
 * NPM helper for agent package management.
 */

import type { Agent } from './index.js';

const AGENT_PACKAGES: Record<Agent, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
};

/** Known Homebrew cask tokens for agents that publish brew casks. */
const AGENT_BREW_CASKS: Partial<Record<Agent, string>> = {
  claude: 'claude-code',
  codex: 'codex',
};

const AGENT_LABELS: Record<Agent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

/**
 * How an agent's CLI is installed.
 *
 * - `npm`   — published as a global npm package; pikiloom can install/upgrade it
 *             unattended via `npm install -g`. This is what the dashboard's
 *             one-click Install button and the auto-updater drive.
 * - `manual` — distributed by its own installer (e.g. Hermes is a Python tool
 *             installed via a `curl … | bash` script and self-updates with
 *             `hermes update`). pikiloom can NOT auto-install these; it surfaces
 *             the copyable command + docs link so the user runs it themselves.
 */
export type AgentInstallMethod = 'npm' | 'manual';

export interface AgentInstallSpec {
  method: AgentInstallMethod;
  /** Copyable shell one-liner that installs the agent's CLI. */
  command: string;
  /** Where to read full install instructions (shown alongside `command`). */
  docsUrl?: string;
  /** Short reason shown to the user for why pikiloom can't auto-install it. */
  note?: string;
}

const NPM_INSTALL_SPECS: Record<Agent, AgentInstallSpec> = Object.fromEntries(
  Object.entries(AGENT_PACKAGES).map(([agent, pkg]) => [
    agent,
    { method: 'npm' as const, command: `npm install -g ${pkg}` },
  ]),
) as Record<Agent, AgentInstallSpec>;

/**
 * Per-agent install descriptors. npm agents are derived from AGENT_PACKAGES so
 * the two never drift; non-npm agents (Hermes) are declared explicitly.
 *
 * Note: Hermes is intentionally absent from AGENT_PACKAGES — it is not on npm,
 * and the auto-updater keys off `getAgentPackage` to (correctly) skip it, since
 * Hermes self-updates via `hermes update`. The manual spec lives here only so
 * the dashboard can guide a first-time install.
 */
const AGENT_INSTALLS: Record<string, AgentInstallSpec> = {
  ...NPM_INSTALL_SPECS,
  hermes: {
    method: 'manual',
    command: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash',
    docsUrl: 'https://github.com/NousResearch/hermes-agent#quick-install',
    note: 'Hermes is a Python agent with its own installer — pikiloom can\'t install it via npm. Run this command, then refresh.',
  },
};

export function getAgentPackage(agent: string): string | null {
  return AGENT_PACKAGES[agent as Agent] || null;
}

export function getAgentBrewCask(agent: string): string | null {
  return AGENT_BREW_CASKS[agent as Agent] || null;
}

export function getAgentLabel(agent: string): string {
  return AGENT_LABELS[agent as Agent] || agent;
}

/** Structured install descriptor, or null for an unknown agent id. */
export function getAgentInstall(agent: string): AgentInstallSpec | null {
  return AGENT_INSTALLS[agent] || null;
}

export function getAgentInstallCommand(agent: string): string | null {
  return getAgentInstall(agent)?.command ?? null;
}
