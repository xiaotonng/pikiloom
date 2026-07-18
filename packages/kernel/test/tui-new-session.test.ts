import { describe, it, expect } from 'vitest';
import { ClaudeDriver, CodexDriver } from '../src/drivers/index.js';

// The `newSessionId` TuiInput field powers "terminal-first new session": the host mints a
// native id up front, so it can bind a pane to `agent:<id>` BEFORE the CLI runs. Claude can
// pin a fresh id with `--session-id`; Codex cannot, so it always launches fresh and the host
// discovers the created id post-hoc. These pins lock that arg construction.
describe('driver.tui() newSessionId (terminal-first new session)', () => {
  it('claude: newSessionId → --session-id (fresh pin), no --resume', () => {
    const { args } = new ClaudeDriver('claude').tui({ workdir: '/w', newSessionId: 'u-123' });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('u-123');
    expect(args).not.toContain('--resume');
  });

  it('claude: sessionId → --resume (existing session)', () => {
    const { args } = new ClaudeDriver('claude').tui({ workdir: '/w', sessionId: 's-9' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('s-9');
    expect(args).not.toContain('--session-id');
  });

  it('claude: fresh pin wins over resume when both are set', () => {
    const { args } = new ClaudeDriver('claude').tui({ workdir: '/w', newSessionId: 'fresh', sessionId: 'old' });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('fresh');
    expect(args).not.toContain('--resume');
  });

  it('codex: ignores newSessionId (always fresh — no pin flag)', () => {
    const { args } = new CodexDriver('codex').tui({ workdir: '/w', newSessionId: 'u-123' });
    expect(args).not.toContain('--session-id');
    expect(args.join(' ')).not.toContain('u-123');
  });
});
