# Architecture

`pikiclaw` is a layered, open Agent orchestrator. Four conceptual layers — terminals, agents, models, tools — sit on top of cross-cutting infrastructure. This document covers the design principles and extension recipes; the full source tree is in [CLAUDE.md](CLAUDE.md).

## Layered Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  cli/            CLI entry point, terminal setup            │
│  dashboard/      Web server, API routes, runtime singleton  │
├─────────────────────────────────────────────────────────────┤
│  channels/       Per-IM transport + bot orchestration       │
├─────────────────────────────────────────────────────────────┤
│  bot/            Shared bot runtime, commands, streaming    │
├─────────────────────────────────────────────────────────────┤
│  agent/          Agent drivers, sessions, MCP tools, CLI    │
├─────────────────────────────────────────────────────────────┤
│  catalog/        Data-only extension manifests              │
│  core/           Constants, logging, config, utilities      │
└─────────────────────────────────────────────────────────────┘
```

Imports flow strictly downward. `core/` and `catalog/` import from nothing inside `src/`. No layer imports from a layer above it. This keeps the lower layers testable in isolation and prevents circular dependencies.

## Current Capabilities

- **Channels:** Telegram, Feishu, WeChat, Slack, Discord, DingTalk, WeCom
- **Agent drivers:** Claude Code (`claude`, `claude-tui`), Codex, Gemini, Hermes (via ACP)
- **Project skills:** `.pikiclaw/skills/*/SKILL.md` plus legacy `.claude/commands/*.md` compatibility
- **Session-scoped MCP tools:** `im_list_files`, `im_send_file`, `im_ask_user`
- **Browser automation:** managed Chromium via `@playwright/mcp`, supervised by `browser-supervisor.ts`
- **macOS desktop automation:** built-in Peekaboo MCP — Accessibility API + ScreenCaptureKit
- **Dashboard:** Hono server + React SPA at `http://localhost:3939`

## Main Message Flow

```text
Incoming IM message
  → channels/*/channel.ts normalizes text / files / context
  → channels/*/bot.ts resolves command vs free text
  → bot/orchestration.ts handleIncomingMessage()
  → placeholder message created
  → channels/telegram/live-preview.ts (channel-agnostic) updates the placeholder while streaming
  → bot/bot.ts runStream() prepares agent options + MCP bridge
  → agent/stream.ts dispatches to AgentDriver via agent/driver.ts registry
  → if Codex requests user input, or im_ask_user is invoked, bot/human-loop.ts renders the prompt in-channel
  → final reply rendered via channels/*/render.ts
  → artifacts / im_send_file callbacks delivered back to IM
```

## Core Design Principles

### 1. Shared logic first, channel rendering second

Business logic lives in shared `bot/` modules:

- `bot.ts` owns runtime state
- `commands.ts` returns structured command data
- `command-ui.ts` builds shared selection UIs
- `orchestration.ts` owns the message pipeline

Channels differ only in transport, rendering format, callback payloads, and capability flags.

### 2. Agent support is registry-based

`agent/driver.ts` exposes the `AgentDriver` interface (`doStream` / `getSessions` / `getSessionTail` / `listModels` / `getUsage` / `shutdown`). `agent/index.ts` imports drivers for side effects; higher layers talk only to the registry.

### 3. Session workspaces are first-class

Each conversation runs against a pikiclaw-managed session workspace used for staged attachments, session metadata, project skill discovery, and MCP tool visibility. This is why file return, skills, and per-session tools behave consistently across agents.

### 4. MCP is injected per stream

1. `agent/stream.ts` starts `agent/mcp/bridge.ts`
2. The bridge launches a localhost callback server
3. `agent/mcp/extensions.ts` merges global + workspace MCP config (resolving disabled flags and OAuth bearer headers)
4. The agent CLI launches `agent/mcp/session-server.ts`
5. MCP tools call back into the parent process and stream artifacts to the IM chat in real time

### 5. Human-in-the-loop is a first-class flow

`bot/human-loop.ts` is a single state machine handling both Codex's structured `user-input` requests and the `im_ask_user` MCP tool. It renders an IM card or dashboard prompt, waits for the answer, and resumes the same task.

### 6. Catalog data is plain manifests

`catalog/*.ts` files are arrays of TypeScript objects consumed by the dashboard and registries. Adding a recommended server, CLI, or skill is a one-file PR.

### 7. Managed browser is a process singleton

`browser-supervisor.ts` owns the managed Chrome profile across all streams. Streams `ensure()` it (singleflight-ed); `invalidate()` is called only on confirmed failure.

### 8. Dashboard is config + runtime surface

The dashboard is not just a setup page — it is the main local control plane for channel validation, agent detection, model discovery, session browsing, workdir switching, extension management, and macOS permission checks. All persistent config lives in `~/.pikiclaw/setting.json`.

## MCP Tool Surface

Registered by `agent/mcp/session-server.ts`:

- `im_list_files`
- `im_send_file`
- `im_ask_user`

Built-in MCP servers togglable from the Extensions tab:

- **`pikiclaw-browser`** — `@playwright/mcp` against a pikiclaw-managed persistent Chrome profile. Toggled by `browserEnabled`.
- **`peekaboo`** — Peekaboo MCP for native macOS GUI automation. Toggled by `peekabooEnabled`; macOS only; requires Screen Recording + Accessibility permissions.

## Extension Recipes

### Adding a new agent

1. Create `src/agent/drivers/xxx.ts` implementing `AgentDriver`
2. Import it from `src/agent/index.ts` (side-effect import triggers registration)
3. Add model / extra-args config handling in `core/config/runtime-config.ts` if needed
4. If the agent ships an external CLI, add an entry to `catalog/cli-tools.ts` and any auth flow under `agent/cli/`
5. Add unit tests, and live E2E coverage where possible

You usually do not need to touch `channels/*/bot.ts`, `bot/commands.ts`, or `bot/command-ui.ts` — those consume the driver registry generically.

### Adding a new IM channel

1. Implement `channels/xxx/channel.ts` extending `Channel`
2. Implement `channels/xxx/render.ts` for platform-specific rendering
3. Implement `channels/xxx/bot.ts` for command routing and streaming lifecycle
4. Register it from `cli/main.ts`
5. Extend `core/config/validation.ts` and `cli/setup-wizard.ts` if the channel has its own credentials

See [INTEGRATION.md](INTEGRATION.md) for the full channel guide.

### Adding a new MCP tool

1. Create or extend a module in `src/agent/mcp/tools/`
2. Export `tools` definitions and a `handle()` implementation
3. Register the module in `agent/mcp/session-server.ts`
4. Keep tool results text-based and JSON-serializable
5. For tools with IM side effects, use the callback URL path exposed by the bridge

### Adding a recommended MCP server / CLI / skill

1. Append a new entry to the appropriate `catalog/*.ts` file
2. For MCP servers needing OAuth, declare an `auth` spec — `agent/mcp/oauth.ts` handles the flow
3. For CLIs needing browser-based auth, declare an `auth` spec — `agent/cli/auth.ts` drives the session
4. No other code changes are required — the dashboard picks it up from the catalog

## Related Docs

- [README.md](README.md)
- [CLAUDE.md](CLAUDE.md) — project structure tree, key concepts, quick reference
- [INTEGRATION.md](INTEGRATION.md) — channel integration guide
- [TESTING.md](TESTING.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
