import type { UniversalSnapshot } from '../protocol/index.js';

// Context replay for a SEED-mode fork — the fallback for drivers without native fork
// (capabilities.fork unset) or forks whose cut point could not be pinned to a native
// anchor. The branch starts a FRESH native session whose first prompt is prefixed with
// the copied transcript, role-tagged and tail-truncated. Native-mode forks never see
// this: their context comes from the agent's own store via resume+fork.

const FORK_SEED_BUDGET_CHARS = 60_000;

export function buildForkSeed(turns: UniversalSnapshot[], budget = FORK_SEED_BUDGET_CHARS): string | null {
  const messages: string[] = [];
  for (const t of turns) {
    const prompt = (t.prompt || '').trim();
    const text = (t.text || '').trim();
    if (prompt) messages.push(`User: ${prompt}`);
    if (text) messages.push(`Assistant: ${text}`);
  }
  if (!messages.length) return null;
  // Tail-truncate whole messages into the budget — the most recent context matters most.
  const kept: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = messages[i].length + 1;
    if (used + cost > budget && kept.length) break;
    kept.unshift(messages[i]);
    used += cost;
  }
  return [
    `<fork-context turns=${turns.length}>`,
    '[This conversation was forked from an earlier session; the transcript so far follows. Continue from this context — do not re-answer it. The next user message follows the closing tag.]',
    ...kept,
    '</fork-context>',
  ].join('\n');
}
