// Multi-account capability (token form): switch between several local subscription accounts
// of a coding-agent CLI by injecting a long-lived auth token at spawn time. The CLI keeps
// using its normal single config home (~/.claude etc.) — only the *identity* changes.
//
//   claude / claude-tui -> CLAUDE_CODE_OAUTH_TOKEN=<token from `claude setup-token`>
//
// This replaces the earlier per-account config-directory approach: on macOS claude stores
// its credential in one shared OS-keychain item (not per CLAUDE_CONFIG_DIR), so the token is
// what actually isolates an account. codex has no equivalent token, so it is not supported
// here yet (single account only).
//
// Dependency-free (no imports) so any @pikiloom/kernel consumer inherits account switching.

const ACCOUNT_TOKEN_ENV: Record<string, string> = {
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  'claude-tui': 'CLAUDE_CODE_OAUTH_TOKEN',
};

/** Whether this agent's local accounts are switched by injecting a token. */
export function accountTokenSupported(agent: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_TOKEN_ENV, agent);
}

/** The env-var name that overrides this agent's subscription identity, or null. */
export function accountTokenEnvVar(agent: string): string | null {
  return ACCOUNT_TOKEN_ENV[agent] ?? null;
}

/** Env to merge at spawn so the agent runs under the given account token. */
export function accountTokenEnv(agent: string, token: string): Record<string, string> {
  const key = accountTokenEnvVar(agent);
  return key && token ? { [key]: token } : {};
}
