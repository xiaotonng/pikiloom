# @pikiloom/kernel

Heterogeneous coding agents (Claude / Codex / Gemini / ACP) → an **interaction-friendly,
accumulating session snapshot + control handle**, exposed over **pluggable surfaces**
(IM, Web, tunnel). Environmental concerns are **injected ports** with working defaults.

This is the reusable core **pikiloom itself is meant to be built on**. Drop it into any
project and stand up a "pikiloom-like" backend in a few lines.

## The model (one package, three rings)

```
上层 (you write):   IM bindings · Web UI/skin · Plugins        ── implement Surface / Plugin
                          ▲ createLoom({ surfaces, plugins, ...ports })
@pikiloom/kernel:   terminal/  Surface contract + LoomIO + built-in WebSurface
  (one import,      runtime/   SessionRunner · Hub (multi-session) · snapshot accumulation · control verbs
   internally       agent/     driver registry + Claude/Echo drivers + spawn/parse       ← Driver
   modular)         protocol/  UniversalSnapshot + diff (the wire vocabulary)            ← Channel
                    ports/     SessionStore · ModelResolver · ToolProvider · ... (+ defaults)
                          ▲ spawns external CLIs (unchanged)
下层 (unchanged):   the `claude` / `codex` / … binaries, native protocols
```

**IM and Web are not two systems** — they are both just `Surface`s over the same `LoomIO`.

## Quickstart

```ts
import { createLoom, ClaudeDriver, WebSurface } from '@pikiloom/kernel';

const loom = createLoom({
  drivers: [new ClaudeDriver()],            // 下层 (unchanged)
  surfaces: [new WebSurface({ port: 8787 })], // 上层 (IM / Web / tunnel)
});
await loom.start();
```

Add an IM terminal by implementing `Surface.start(io)`: route inbound messages to
`io.prompt(...)` and render `io.subscribe(...)` snapshots back. Everything else (storage,
credentials, tools, prompts) has a default and is overridable via ports.

### TUI passthrough (`pikiloom code` → Claude/Codex TUI)

Two orthogonal driver outputs off the same registry: `run()` yields a structured
`UniversalSnapshot` (Web/IM); `tui()` yields a raw, full-screen interactive process that
the kernel spawns in a **PTY** and passes through transparently (with optional tee/mirror).

```ts
import { createLoom, ClaudeDriver, CodexDriver } from '@pikiloom/kernel';
const loom = createLoom({ drivers: [new ClaudeDriver(), new CodexDriver()], defaultAgent: 'claude' });
await loom.runTui({ agent: 'claude', workdir: process.cwd() }); // you're now in the real Claude TUI, launched by the kernel
```

`runTui` does full stdin/stdout raw passthrough on the current terminal; `openTui` returns
a `PtyBridge` (`onData`/`write`/`resize`/`onExit`) so you can drive or tee it yourself.
Requires the optional `node-pty` dependency.

## Contracts

| Seam | Interface | Direction |
|------|-----------|-----------|
| Agent (下层) | `AgentDriver.run(input, ctx)` → emits `DriverEvent`s | down, bundled (+ `registerDriver` escape hatch) |
| Surface (上层) | `Surface.start(io: LoomIO)` | up, app-provided (WebSurface built-in) |
| Session API | `LoomIO` = prompt/stop/steer/interact + subscribe/getSnapshot/listSessions | the meeting point |
| Plugin | `Plugin.tools()` / `decorateSnapshot()` | up, app-provided |
| Ports | `SessionStore` · `ModelResolver` · `ToolProvider` · `SystemPromptBuilder` · `InteractionHandler` | side, defaults included |

Wire shape: `UniversalSnapshot` (phase/text/reasoning/plan/toolCalls/usage/interactions/artifacts)
+ delta `diffSnapshot`/`applySnapshotPatch` (prefix-append text, `undefined→null` field-clears
that survive JSON).

## What's included

- Drivers: `EchoDriver` (hermetic), `ClaudeDriver` (real `claude` CLI, stream-json + TUI), `CodexDriver` (app-server JSON-RPC + TUI), `GeminiDriver` (stream-json), `HermesDriver` (ACP).
- Terminals: `WebSurface` (ws host speaking the wire protocol — any pikichannel client connects), `CliSurface`.
- TUI: `PtyBridge` + `attachTui` + `Loom.runTui/openTui` (raw PTY passthrough with tee).
- Ports: `FsSessionStore`, `NullModelResolver`, `NoopToolProvider`, `PassthroughSystemPromptBuilder`, `AutoCancelInteractionHandler`.

## Publishing / CI

`npm publish ./packages/kernel --access public` (scoped-public). Each pikiloom release bumps
+ builds the kernel (`scripts/release.sh`) and the Release workflow publishes it alongside
pikiloom — needs the `@pikiloom` npm scope to exist and `NPM_TOKEN` to have publish access.

> Known rough edge: node-pty's prebuilt `spawn-helper` can lose its executable bit on some
> npm installs (`posix_spawnp failed`). Fix: `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.

## Verification

```bash
npm run typecheck                 # tsc, clean
npm test                          # hermetic: snapshot diff, full lifecycle (stop/steer/interact), web ws flow
KERNEL_E2E_REAL=1 npm test        # also drives the real `claude` CLI end-to-end
node examples/smoke.mjs           # smoke against the compiled dist
```

Status: contracts + runtime + Echo/Claude drivers + Web terminal + default ports are
implemented and **E2E-verified** (hermetic + real-claude + compiled-artifact). The kernel
lives beside `src/` and does **not** touch the existing pikiloom app.

## Roadmap (gated cutover)

1. Port the remaining drivers (Codex/Gemini/Hermes-ACP) behind the same `AgentDriver` contract.
2. Promote pikiloom's concrete IM channels to reference `Surface` adapters (`@pikiloom/kernel/surfaces/*`).
3. Add the full pikichannel transport (WebRTC + rendezvous + TURN + `/api` tunnel) as a `WebSurface` option.
4. Re-point the pikiloom app's `main.ts` at `createLoom({...})`; keep multi-session queue / promotion / goal
   auto-continuation in the app (not the kernel). Switch over only after parity is proven on DEV.
