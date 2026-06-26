import type { Agent } from '../../agent/index.js';
import { normalizeClaudeModelId } from '../../agent/index.js';
import type { UserConfig } from './user-config.js';

export const DEFAULT_AGENT_MODELS: Record<Agent, string> = {
  claude: 'claude-opus-4-8',
  codex: 'gpt-5.5',
  gemini: 'gemini-3.1-pro-preview',
  hermes: 'anthropic/claude-sonnet-4',
};

export const DEFAULT_AGENT_EFFORTS: Partial<Record<Agent, string>> = {
  claude: 'high',
  codex: 'xhigh',
  gemini: 'high',
  hermes: 'medium',
};

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoolish(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'enabled') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === 'disabled') return false;
  return null;
}

export function agentModelEnv(agent: Agent, env: Record<string, string | undefined> = process.env): string {
  switch (agent) {
    case 'claude': return trimmed(env.CLAUDE_MODEL);
    case 'codex': return trimmed(env.CODEX_MODEL);
    case 'gemini': return trimmed(env.GEMINI_MODEL);
    case 'hermes': return trimmed(env.HERMES_MODEL);
  }
  return '';
}

export function agentEffortEnv(agent: Agent, env: Record<string, string | undefined> = process.env): string {
  switch (agent) {
    case 'claude': return trimmed(env.CLAUDE_REASONING_EFFORT).toLowerCase();
    case 'codex': return trimmed(env.CODEX_REASONING_EFFORT).toLowerCase();
    case 'gemini': return trimmed(env.GEMINI_REASONING_EFFORT).toLowerCase();
    case 'hermes': return trimmed(env.HERMES_REASONING_EFFORT).toLowerCase();
  }
  return '';
}

export function resolveAgentModel(config: Partial<UserConfig> | Record<string, any>, agent: Agent): string {
  let value = '';
  switch (agent) {
    case 'claude':
      value = trimmed((config as Partial<UserConfig>).claudeModel || agentModelEnv('claude') || DEFAULT_AGENT_MODELS.claude);
      return normalizeClaudeModelId(value);
    case 'codex':
      value = trimmed((config as Partial<UserConfig>).codexModel || agentModelEnv('codex') || DEFAULT_AGENT_MODELS.codex);
      return value || DEFAULT_AGENT_MODELS.codex;
    case 'gemini':
      value = trimmed((config as Partial<UserConfig>).geminiModel || agentModelEnv('gemini') || DEFAULT_AGENT_MODELS.gemini);
      return value || DEFAULT_AGENT_MODELS.gemini;
    case 'hermes':
      value = trimmed((config as Partial<UserConfig>).hermesModel || agentModelEnv('hermes') || DEFAULT_AGENT_MODELS.hermes);
      return value || DEFAULT_AGENT_MODELS.hermes;
  }
  return '';
}

export function resolveAgentEffort(config: Partial<UserConfig> | Record<string, any>, agent: Agent): string | null {
  switch (agent) {
    case 'claude': {
      const value = trimmed((config as Partial<UserConfig>).claudeReasoningEffort || agentEffortEnv('claude') || DEFAULT_AGENT_EFFORTS.claude).toLowerCase();
      return value || DEFAULT_AGENT_EFFORTS.claude || null;
    }
    case 'codex': {
      const value = trimmed((config as Partial<UserConfig>).codexReasoningEffort || agentEffortEnv('codex') || DEFAULT_AGENT_EFFORTS.codex).toLowerCase();
      return value || DEFAULT_AGENT_EFFORTS.codex || null;
    }
    case 'gemini': {
      const value = trimmed((config as Partial<UserConfig>).geminiReasoningEffort || agentEffortEnv('gemini') || DEFAULT_AGENT_EFFORTS.gemini).toLowerCase();
      return value || DEFAULT_AGENT_EFFORTS.gemini || null;
    }
    case 'hermes': {
      const value = trimmed((config as Partial<UserConfig>).hermesReasoningEffort || agentEffortEnv('hermes') || DEFAULT_AGENT_EFFORTS.hermes).toLowerCase();
      return value || DEFAULT_AGENT_EFFORTS.hermes || null;
    }
  }
  return null;
}

export function agentWorkflowEnv(agent: Agent, env: Record<string, string | undefined> = process.env): string {
  switch (agent) {
    case 'claude': return trimmed(env.CLAUDE_WORKFLOW);
  }
  return '';
}

export function resolveAgentWorkflowEnabled(config: Partial<UserConfig> | Record<string, any>, agent: Agent): boolean {
  switch (agent) {
    case 'claude': {
      const raw = (config as Partial<UserConfig>).claudeWorkflowEnabled;
      if (typeof raw === 'boolean') return raw;
      const fromEnv = parseBoolish(agentWorkflowEnv('claude'));
      return fromEnv ?? false;
    }
  }
  return false;
}

export function setAgentWorkflowEnv(agent: Agent, value: boolean, env: NodeJS.ProcessEnv = process.env): void {
  switch (agent) {
    case 'claude': env.CLAUDE_WORKFLOW = value ? '1' : '0'; break;
  }
}

export type ClaudeAccessMode = 'subscription' | 'api';

export const DEFAULT_CLAUDE_ACCESS_MODE: ClaudeAccessMode = 'api';

export function claudeAccessModeEnv(env: Record<string, string | undefined> = process.env): ClaudeAccessMode | null {
  const print = parseBoolish(trimmed(env.PIKILOOM_CLAUDE_PRINT));
  if (print != null) return print ? 'api' : 'subscription';
  const tui = parseBoolish(trimmed(env.PIKILOOM_CLAUDE_TUI));
  if (tui != null) return tui ? 'subscription' : 'api';
  return null;
}

export function resolveClaudeAccessMode(config: Partial<UserConfig> | Record<string, any>): ClaudeAccessMode {
  const raw = (config as Partial<UserConfig>).claudeAccessMode;
  if (raw === 'subscription' || raw === 'api') return raw;
  return claudeAccessModeEnv() ?? DEFAULT_CLAUDE_ACCESS_MODE;
}

export function setClaudeAccessModeEnv(value: ClaudeAccessMode, env: NodeJS.ProcessEnv = process.env): void {
  env.PIKILOOM_CLAUDE_PRINT = value === 'api' ? '1' : '0';
}

export function setAgentModelEnv(agent: Agent, value: string, env: NodeJS.ProcessEnv = process.env): void {
  switch (agent) {
    case 'claude': env.CLAUDE_MODEL = value; break;
    case 'codex': env.CODEX_MODEL = value; break;
    case 'gemini': env.GEMINI_MODEL = value; break;
    case 'hermes': env.HERMES_MODEL = value; break;
  }
}

export function setAgentEffortEnv(agent: Agent, value: string, env: NodeJS.ProcessEnv = process.env): void {
  switch (agent) {
    case 'claude': env.CLAUDE_REASONING_EFFORT = value; break;
    case 'codex': env.CODEX_REASONING_EFFORT = value; break;
    case 'gemini': env.GEMINI_REASONING_EFFORT = value; break;
    case 'hermes': env.HERMES_REASONING_EFFORT = value; break;
  }
}

export const ULTRA_EFFORT = 'ultra';

export function decomposeEffortSelection(raw: string | null | undefined): { effort: string; workflow: boolean } {
  const value = trimmed(raw).toLowerCase();
  if (value === ULTRA_EFFORT) return { effort: 'max', workflow: true };
  return { effort: value, workflow: false };
}

export interface EffortLevel { id: string; label: string }

// Single source of truth for reasoning-effort levels, ordered low→high. BOTH the dashboard
// (which receives them via the agent/model API payload) and the IM bot consume this — do not
// reintroduce a second copy. Resolve options through effortOptionsFor(), never index directly,
// so per-model/provider rules stay in one place.
const AGENT_EFFORT_LEVELS: Partial<Record<Agent, EffortLevel[]>> = {
  claude: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Very High' },
    { id: 'max', label: 'Max' },
    { id: ULTRA_EFFORT, label: 'Ultra' },
  ],
  codex: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Very High' },
  ],
  // gemini intentionally has no UI-exposed effort levels: pikiloom sends it no reasoning-effort
  // (see the gemini→null guards in InputComposer). Add a gemini entry here to surface low/high.
  hermes: [
    { id: 'minimal', label: 'Minimal' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Very High' },
  ],
};

// Valid effort levels for a given (agent, model, providerKind). Returns [] when reasoning
// effort does not apply (the UI then hides the selector entirely). model/providerKind are the
// seam for per-model rules — add them here and nowhere else.
export function effortOptionsFor(
  agent: Agent,
  _model?: string | null,
  _providerKind?: string | null,
): EffortLevel[] {
  return AGENT_EFFORT_LEVELS[agent] ?? [];
}
