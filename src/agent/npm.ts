import type { Agent } from './index.js';

const AGENT_PACKAGES: Record<Agent, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
};

const AGENT_BREW_CASKS: Partial<Record<Agent, string>> = {
  claude: 'claude-code',
  codex: 'codex',
};

const AGENT_LABELS: Record<Agent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

export type AgentInstallMethod = 'npm' | 'manual';

export interface AgentInstallSpec {
  method: AgentInstallMethod;
  command: string;
  docsUrl?: string;
  note?: string;
}

const NPM_INSTALL_SPECS: Record<Agent, AgentInstallSpec> = Object.fromEntries(
  Object.entries(AGENT_PACKAGES).map(([agent, pkg]) => [
    agent,
    { method: 'npm' as const, command: `npm install -g ${pkg}` },
  ]),
) as Record<Agent, AgentInstallSpec>;

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

export function getAgentInstall(agent: string): AgentInstallSpec | null {
  return AGENT_INSTALLS[agent] || null;
}

export function getAgentInstallCommand(agent: string): string | null {
  return getAgentInstall(agent)?.command ?? null;
}
