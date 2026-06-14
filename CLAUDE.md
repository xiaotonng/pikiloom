# Pikiloom

A layered, open Agent orchestrator. **Not** "an IM bridge for coding agents" — IM is one of several pluggable terminals.

**Four layers (top → bottom):**

1. **Terminal** — IM channels and the Web Dashboard are equal, pluggable entry points.
2. **Agent** — Wraps best-in-class agents (Claude Code, Codex, Gemini, Hermes) through a driver registry; ACP-compatible agents plug in via the same contract.
3. **Model** — Routes across frontier models (Claude, GPT/Codex, Gemini), domestic Chinese series (DeepSeek, 豆包, MiMo, MiniMax), OpenRouter, and any OpenAI-compatible proxy. Providers + Profiles vault injects credentials per agent at spawn time.
4. **Tool** — Skills, MCP servers, CLI tools, merged across global / workspace scopes.

The orchestrator is the product. Lead with the layered framing.

## Project Structure

```text
src/
  core/                        Zero-business-logic infrastructure
    constants.ts               Centralized timeouts, retries, numeric constants
    logging.ts                 Structured logging with scoped writers
    platform.ts                Cross-platform OS primitives (IS_WIN, path, which)
    process-control.ts         Restart coordination, watchdog, process tree kill
    utils.ts                   Pure utilities
    version.ts                 Package version
    config/
      user-config.ts           ~/.pikiloom/setting.json load/save/sync
      runtime-config.ts        Runtime agent / model / effort resolution
      validation.ts            Channel credential validation

  catalog/                     Data-only manifests for the Extensions page
    mcp-servers.ts             Recommended MCP servers
    cli-tools.ts               Recommended CLIs
    skill-repos.ts             Recommended skill repos

  agent/                       Agent abstraction layer
    driver.ts                  AgentDriver interface + pluggable registry
    drivers/{claude,claude-tui,codex,gemini,hermes}.ts
    session.ts                 Session workspace CRUD, classification
    stream.ts                  CLI spawn framework, stream orchestration
    skills.ts                  Project skill discovery (.pikiloom/skills)
    skill-installer.ts         Wrapper around `npx skills add`
    auto-update.ts             Background agent CLI version checking
    cli/                       External CLI tool detection + OAuth-web auth
    mcp/
      bridge.ts                Per-stream MCP bridge orchestration
      session-server.ts        Stdio MCP server for agent CLIs
      registry.ts              Recommended MCP server types
      extensions.ts            MCP extension CRUD + session merge
      oauth.ts                 MCP OAuth 2.1 + Dynamic Client Registration
      tools/{workspace,ask-user,types}.ts

  bot/                         Channel-agnostic bot runtime
    bot.ts                     Bot base class: chat state, runStream()
    commands.ts                Structured command data
    command-ui.ts              Selection UI models, action executor
    orchestration.ts           Message pipeline helpers
    human-loop.ts              Human-in-the-loop state machine (Codex + im_ask_user)
    streaming.ts / render-shared.ts / menu.ts / host.ts / session-hub.ts / session-status.ts

  channels/                    Physically isolated IM implementations
    base.ts                    Abstract Channel transport + capability flags
    telegram/  feishu/  weixin/  slack/  discord/  dingtalk/  wecom/

  dashboard/                   Hono HTTP server + React SPA
    server.ts / runtime.ts / platform.ts / session-control.ts
    routes/{config,agents,sessions,extensions,cli}.ts

  cli/                         CLI entry points
    main.ts                    --daemon / --no-daemon / --setup / MCP serve
    channels.ts / setup-wizard.ts / onboarding.ts / run.ts

  browser-profile.ts           Managed Chromium profile dir for Playwright
  browser-supervisor.ts        Process-singleton: probe / ensure / invalidate
```

## Layered Dependencies

Imports flow strictly downward — no layer imports from a layer above it:

```
cli/  →  dashboard/  →  channels/*  →  bot/  →  agent/  →  catalog/, core/
```

## Key Concepts

- `bot/bot.ts` owns shared runtime state and `runStream()`
- `agent/stream.ts` is the CLI spawn framework; `agent/driver.ts` keeps agents pluggable
- `agent/mcp/bridge.ts` injects session-scoped MCP tools per stream; `agent/mcp/extensions.ts` merges global + workspace MCP config and resolves OAuth bearers
- `bot/human-loop.ts` is the single state machine for both Codex user-input and the `im_ask_user` MCP tool
- `browser-supervisor.ts` is the process-level singleton for the managed Chrome — streams call `ensure()`, never relaunch directly
- Each channel in `channels/*/` is physically isolated — touching Telegram never requires touching Feishu code

## Quick Reference

| Task | Files to read |
|------|---------------|
| Add an agent driver | `agent/driver.ts`, any `agent/drivers/*.ts` as example |
| Add a recommended MCP / CLI / skill | `catalog/{mcp-servers,cli-tools,skill-repos}.ts` |
| Session management | `agent/session.ts`, `agent/types.ts` |
| Streaming behavior | `agent/stream.ts`, `bot/bot.ts` (`runStream`) |
| Add a Telegram command | `channels/telegram/bot.ts`, `bot/commands.ts` |
| Feishu rendering | `channels/feishu/render.ts`, `bot/render-shared.ts` |
| Dashboard API route | `dashboard/routes/*.ts`, `dashboard/runtime.ts` |
| MCP tool behavior | `agent/mcp/tools/*.ts`, `agent/mcp/bridge.ts` |
| MCP extension CRUD / OAuth | `agent/mcp/extensions.ts`, `agent/mcp/oauth.ts` |
| External CLI detection / auth | `agent/cli/detector.ts`, `agent/cli/auth.ts` |
| User config schema | `core/config/user-config.ts` |
| Cross-platform OS behavior | `core/platform.ts` |
| Managed browser lifecycle | `browser-supervisor.ts`, `browser-profile.ts` |

## Test Commands

```bash
npm run dev                            # local dev (--no-daemon, logs to ~/.pikiloom/dev/dev.log)
npm test                               # Vitest unit suite
npx vitest run test/<file>.unit.test.ts
```

## Notes

- Persistent config is `~/.pikiloom/setting.json`
- The Dashboard is part of the normal runtime, not just a setup helper
- This machine always has a production / self-bootstrap path via `npx pikiloom@latest`; do not kill, replace, or "clean up" that process when the task only concerns dev mode
- `npm run dev` rewrites `~/.pikiloom/dev/dev.log` on each launch. When invoked without a TTY (any tool-call / piped invocation) it auto-detaches into the background — no need for `run_in_background:true`. Force foreground with `PIKILOOM_DEV_FOREGROUND=1`, background with `PIKILOOM_DEV_BACKGROUND=1`.
- For full architecture / extension / testing guides, see `ARCHITECTURE.md`, `INTEGRATION.md`, `TESTING.md`.
