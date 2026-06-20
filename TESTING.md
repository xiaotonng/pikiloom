# Testing Guide

`pikiloom` uses Vitest for all automated tests. Live runtime validation goes through `npm run dev`.

## Test Commands

```sh
# Run all unit tests
npm test

# Watch mode
npm run test:watch

# Single file
npx vitest run test/code-agent.unit.test.ts

# Manual runtime / startup validation (preferred for anything that launches pikiloom)
npm run dev

# Manual end-to-end interaction verification (real dashboard + bot + human loop)
npx tsx test/verify-interaction-e2e.ts
```

There is a single Vitest configuration (`vitest.config.ts`); every `test/*.unit.test.ts` file is picked up automatically.

## Startup Rule

If a test or validation step needs to launch `pikiloom` itself, use `npm run dev`.

- `npm run dev` is the local-only startup path
- It runs with `--no-daemon`, so it stays on the checked-out source tree
- It rewrites `~/.pikiloom/dev/dev.log` on each launch
- Do not kill or reuse the long-lived production/self-bootstrap `npx pikiloom@latest` process on this machine as part of dev testing

## Environment Setup

For tests that hit live IM transports or live agent CLIs, load `.env` first:

```sh
set -a && source .env && set +a
```

Useful environment variables:

| Variable | Used by |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram channel and bot tests |
| `TELEGRAM_TEST_CHAT_ID` | Telegram live test target chat |
| `TELEGRAM_INTERACTIVE` | Interactive Telegram bot scenarios |
| `FEISHU_APP_ID` | Feishu runtime when testing locally |
| `FEISHU_APP_SECRET` | Feishu runtime when testing locally |

Agent live tests also require the corresponding CLI to be installed and authenticated.

## Current Test Files

The suite currently has **49** unit test files under `test/*.unit.test.ts`. Vitest picks them up automatically via `vitest.config.ts`.

| Area | Files |
|---|---|
| Bot / commands | `bot.unit.test.ts`, `bot-telegram.unit.test.ts`, `command-ui.unit.test.ts`, `goal.unit.test.ts`, `await-resume.unit.test.ts`, `known-chats-allowlist.unit.test.ts` |
| Channels | `channel-dingtalk.unit.test.ts`, `channel-discord.unit.test.ts`, `channel-feishu.unit.test.ts`, `channel-slack.unit.test.ts`, `channel-telegram.unit.test.ts`, `channel-validation.unit.test.ts`, `channel-wecom.unit.test.ts`, `telegram-callback-registry.unit.test.ts` |
| Agent drivers | `driver-claude.unit.test.ts`, `driver-claude-tui.unit.test.ts`, `driver-codex.unit.test.ts`, `driver-gemini.unit.test.ts`, `driver-hermes.unit.test.ts`, `code-agent.unit.test.ts` |
| Sessions / git | `session-control.unit.test.ts`, `session-messages-window.unit.test.ts`, `sessions-list-projection.unit.test.ts`, `sessions-digest.unit.test.ts`, `delete-session.unit.test.ts`, `git-status.unit.test.ts`, `resolve-default-agent.unit.test.ts` |
| Dashboard | `dashboard-assistant-content.unit.test.ts`, `dashboard-browser-remote.unit.test.ts`, `dashboard-file-links.unit.test.ts`, `dashboard-live-session-state.unit.test.ts`, `dashboard-session-failure.unit.test.ts`, `dashboard-terminal.unit.test.ts`, `live-preview.unit.test.ts` |
| MCP / extensions | `mcp-bridge.unit.test.ts`, `mcp-extensions-http.unit.test.ts`, `agent-install-spec.unit.test.ts`, `agent-images.unit.test.ts`, `agent-artifacts.unit.test.ts` |
| Skills / browser / process | `project-skills.unit.test.ts`, `claude-goal-bridge.unit.test.ts`, `browser-supervisor.unit.test.ts`, `stream-browser-failure.unit.test.ts`, `process-control.unit.test.ts`, `agent-update-gate.unit.test.ts`, `peekaboo-warm.unit.test.ts` |
| Runtime / config | `interaction.unit.test.ts`, `model-injector.unit.test.ts`, `runtime-config-access-mode.unit.test.ts` |

## Manual Verification Scripts

| File | Scope |
|---|---|
| `test/verify-interaction-e2e.ts` | Spins up a real dashboard + bot, submits a task that triggers human-in-the-loop, and answers via REST — mirrors the dashboard frontend flow. Run with `npx tsx test/verify-interaction-e2e.ts`. |

For any IM-driven manual end-to-end validation, start the local runtime with `npm run dev` and inspect `~/.pikiloom/dev/dev.log`.

## Common Runs

```sh
# Local startup validation with fresh dev log
npm run dev

# One unit file
npx vitest run test/mcp-bridge.unit.test.ts

# One Telegram unit file
npx vitest run test/bot-telegram.unit.test.ts

# Manual interaction verification (full real path)
npx tsx test/verify-interaction-e2e.ts
```

## Testing Rules

### Unit tests

- Mocks are allowed and encouraged for transport / external-CLI boundaries
- Prefer focused coverage around one module or behavior
- Good fit for parsers, renderers, config logic, transport branching, state machines

### Live / interaction verification

- Do not mock the system being verified
- Use real CLIs, real transports, and real files where applicable
- Skip cleanly when the required runtime is unavailable
- Keep these as scripts (`test/verify-*.ts`) or run them through `npm run dev`, not in the default `vitest run` path — they consume tokens and send real messages

## Suggested Workflow

1. Run `npm test`
2. Run the specific unit file for the area you changed
3. If your change touches channels, drivers, the dashboard, or process control, run the relevant interaction verification with real credentials when possible
4. If your change affects docs only, a build or test run is optional but still useful for quick sanity

## Notes

- `test/support/` contains shared helpers (Telegram harness, stream assertions, env, e2e helpers)
- Some interaction-style tests are now consolidated as unit tests with mocked transports — for example `test/interaction.unit.test.ts` covers the human-in-the-loop flow that previously lived in a separate live-bot E2E
- For full real-environment validation, prefer `npm run dev` plus the manual verification scripts under `test/verify-*.ts`
