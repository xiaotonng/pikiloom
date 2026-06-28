# @pikiloom/kernel

Turn heterogeneous coding agents (**Claude Code · Codex · Gemini · ACP/Hermes**) into one
**uniform, accumulating session snapshot + a small set of control verbs**, exposed over
**pluggable surfaces** (IM, Web, tunnel, raw terminal). Environmental concerns (storage,
credentials, tools, prompts) are **injected ports** with working defaults.

This is the reusable core that [pikiloom](https://github.com/xiaotonng/pikiloom) itself is
built on. Drop it into any project and stand up a "pikiloom-like" backend in a few lines —
**you never parse a CLI's output or learn each agent's wire format**; you read one
`UniversalSnapshot` and call `prompt / stop / steer / interact`.

```bash
npm i @pikiloom/kernel
```

- Runtime dep: `ws`. Optional: `node-pty` (only for raw-TUI passthrough). Node ≥ 20, ESM-only.
- TypeScript types ship in the package (`dist/**/*.d.ts`). For an LLM-oriented summary, see [`llms.txt`](./llms.txt).

---

## Mental model

```
上层 (you write):   IM bindings · Web UI · Plugins         ── implement Surface / Plugin
                          ▲ createLoom({ surfaces, plugins, ...ports })
@pikiloom/kernel:   contracts/  Driver · Surface · LoomIO · Ports
  (one import,      runtime/    SessionRunner · Hub (multi-session) · snapshot accumulation · control verbs
   modular inside)  drivers/    Claude / Codex / Gemini / Hermes / Echo  ← the agent axis (下层)
                    surfaces/   WebSurface (ws host) · CliSurface
                    protocol/   UniversalSnapshot + diff  ← the wire vocabulary
                    ports/      SessionStore · ModelResolver · ToolProvider · ... (+ defaults)
                          ▲ spawns the external `claude` / `codex` / `gemini` CLIs (unchanged)
下层 (unchanged):   the agent binaries, native protocols
```

**IM and Web are not two systems** — both are just `Surface`s over the same `LoomIO`.

### Two rails, same driver registry

| Rail | Driver method | Output | Use for |
|------|---------------|--------|---------|
| **Structured** | `driver.run(input, ctx)` | streamed `UniversalSnapshot` (text, reasoning, tool activity, plan, usage) | IM, Web dashboards, any UI that renders structured turns |
| **Raw PTY** | `driver.tui(input)` | a real full-screen interactive process passed through a PTY | a local terminal app (`pikiloom code`-style); needs `node-pty` |

---

## Quick start

### 1. One turn through one agent — `runTurn` (the bridge primitive)

The smallest unit. No persistence, no multi-session — just run a turn and get a streamed
snapshot + final result. This is exactly what an existing app maps onto its own UI.

```ts
import { runTurn, ClaudeDriver } from '@pikiloom/kernel';

const { result, snapshot } = await runTurn(
  new ClaudeDriver(),
  { prompt: 'Summarize package.json in one line', workdir: process.cwd(), effort: 'high' },
  {
    onSnapshot: (s) => {
      // fires on every event — render live:
      //   s.text       accumulated assistant output
      //   s.reasoning  accumulated thinking (when the model/auth exposes it)
      //   s.activity   human-readable execution trail ("Read foo.ts", "Run shell: npm test")
      //   s.toolCalls  structured tool calls [{ name, summary, status }]
      //   s.plan, s.usage, s.artifacts, s.interactions
      process.stdout.write(`\r${s.activity?.split('\n').at(-1) ?? ''}`);
    },
    onSteer: (steer) => { /* call steer('extra prompt') mid-turn */ },
    signal: undefined,  // pass an AbortSignal to stop the turn
  },
);
console.log(result.ok, result.text, result.sessionId);
```

### 2. A full multi-session backend — `createLoom`

Adds persistence, a session hub, per-session queueing, discovery, and surfaces. Every port
has a default, so this runs with zero wiring.

```ts
import { createLoom, ClaudeDriver, CodexDriver, WebSurface } from '@pikiloom/kernel';

const loom = createLoom({
  drivers: [new ClaudeDriver(), new CodexDriver()],   // 下层 (unchanged binaries)
  surfaces: [new WebSurface({ port: 8787 })],         // 上层 (Web/tunnel; add your IM Surface here)
  defaultAgent: 'claude',
  // optional ports — override any one to swap storage / credentials / tools / prompts:
  // sessionStore, modelResolver, toolProvider, systemPromptBuilder, catalog, interactionHandler
});
await loom.start();

// Drive it from anywhere via loom.io (LoomIO):
const { sessionKey, taskId } = await loom.io.prompt({ prompt: 'hello', agent: 'claude' });
const unsub = loom.io.subscribe((key, snapshot, patch, seq) => { /* render */ });
loom.io.steer(taskId, 'actually, do X instead');
loom.io.stop(sessionKey);
```

To add an **IM channel**, implement `Surface.start(io)`: route inbound messages to
`io.prompt(...)` and render `io.subscribe(...)` snapshots back out. Nothing else changes.

### 3. Raw TUI passthrough — `runTui` / `openTui`

```ts
const loom = createLoom({ drivers: [new ClaudeDriver()], defaultAgent: 'claude' });
await loom.runTui({ agent: 'claude', workdir: process.cwd() }); // you're now in the real Claude TUI
```

`runTui` does full stdin/stdout raw passthrough on the current terminal. `openTui` returns a
`PtyBridge` (`onData` / `write` / `resize` / `onExit`) so you can drive or tee it yourself.
Requires the optional `node-pty` dependency (`ptyAvailable()` reports availability).

---

## The data you read: `UniversalSnapshot`

One driver-agnostic shape for every agent. A surface renders *this* and never touches a
CLI's native format. It **accumulates** across a turn (text/reasoning append; structured
fields replace).

```ts
interface UniversalSnapshot {
  phase: 'idle' | 'queued' | 'streaming' | 'done';
  taskId?: string | null;
  sessionId?: string | null;
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
  prompt?: string | null;

  text?: string;        // accumulated assistant output
  reasoning?: string;   // accumulated thinking (only when the model/auth streams it; see note)
  activity?: string;    // human-readable execution trail, one line per tool/subagent (kernel-derived)
  plan?: UniversalPlan | null;                 // { explanation, steps:[{ text, status }] }
  toolCalls?: UniversalToolCall[];             // structured: { id, name, summary, input?, result?, status }
  subAgents?: UniversalSubAgent[];             // spawned sub-agents and their tools
  usage?: UniversalUsage | null;               // { inputTokens, outputTokens, cachedInputTokens, contextPercent, ... }
  artifacts?: UniversalArtifact[];             // generated files/images { url|path, fileName, mime, kind }
  interactions?: UniversalInteraction[];       // pending human-in-the-loop questions (answer via interact())
  queued?: UniversalQueuedTask[];              // prompts waiting behind the running turn

  error?: string | null;
  incomplete?: boolean; // true if the turn was interrupted / errored
  startedAt?: number;
  updatedAt: number;
}
```

Sub-shapes:

```ts
interface UniversalToolCall { id: string; name: string; summary: string; input?: string | null; result?: string | null; status: 'running' | 'done' | 'failed'; }
interface UniversalPlan { explanation: string | null; steps: { text: string; status: 'pending' | 'inProgress' | 'completed' }[]; }
interface UniversalUsage { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; contextUsedTokens?: number | null; contextPercent: number | null; providerName?: string | null; }
interface UniversalArtifact { url?: string; path?: string; fileName: string; mime?: string; kind: 'photo' | 'document'; caption?: string; }
interface UniversalInteraction { promptId: string; kind: 'user-input' | 'permission' | 'confirmation'; title: string; questions: { id: string; text: string; type?: 'text' | 'select'; choices?: { label: string; value?: string }[] }[]; }
```

**Activity projection (kernel-owned).** Every driver emits *structured* tool calls; the
kernel's `SessionRunner` derives `snapshot.activity` from `toolCalls` + `subAgents` centrally
(`projectActivity`): one line per call with a status suffix — `summary` while running,
`summary done` / `summary -> detail` on success, `summary failed: detail` on error. So every
surface gets a readable execution trail for free, and rich UIs can still use `toolCalls`
directly. You implement this **nowhere** — it's a property of the snapshot.

**Reasoning note.** Plaintext thinking only appears when the agent actually streams it
(e.g. BYOK Anthropic API keys, Codex `item/reasoning`). Subscription/OAuth Claude withholds
plaintext extended-thinking (streams only an encrypted signature), so `reasoning` is empty
there — a platform behavior, not a kernel limitation. The Claude driver also captures
reasoning delivered as a complete block, not only as streamed deltas.

### Streaming on the wire — `diffSnapshot` / `applySnapshotPatch`

`diffSnapshot(prev, next)` produces a compact `SnapshotPatch` (prefix-append for `text` /
`reasoning`; field replacement otherwise, with `undefined → null` so field-clears survive
`JSON.stringify`). `applySnapshotPatch(prev, patch)` reassembles it on the client. `WebSurface`
uses these; reuse them for your own transport.

---

## Control verbs (`LoomIO`)

```ts
io.prompt({ prompt, agent?, sessionKey?, workdir?, model?, effort?, attachments? })  // → { sessionKey, taskId }
io.stop(sessionKey)                         // interrupt the running turn (queued tasks stay & promote)
io.steer(taskId, prompt, attachments?)      // inject a message mid-turn (drivers with capabilities.steer)
io.interact(promptId, action, value?)       // answer a pending interaction: 'select' | 'text' | 'skip' | 'cancel'
io.subscribe((sessionKey, snapshot, patch, seq) => …)   // live snapshots
io.getSnapshot(sessionKey) · io.getHistory(sessionKey) · io.listSessions()
io.listAgentInfo() · io.listModels(agent) · io.listEffort(agent, model?) · io.listTools(agent, workdir?) · io.listSkills(agent, workdir?)
```

Concurrent prompts to one session **queue** by default (`serialPerSession`, no clobber); `stop`
interrupts only the current turn and the next queued task promotes.

---

## Drivers (the agent axis)

| Driver | id | transport | steer | interact | resume | tui |
|--------|----|-----------|:-----:|:--------:|:------:|:---:|
| `ClaudeDriver` | `claude` | `claude` CLI, stream-json (+ `--effort`, partial messages) | ✓ | — | ✓ | ✓ |
| `CodexDriver` | `codex` | `codex app-server` JSON-RPC (HITL via `requestUserInput`) | ✓ | via askUser | ✓ | ✓ |
| `GeminiDriver` | `gemini` | `gemini --output-format stream-json` | — | — | ✓ | ✓ |
| `HermesDriver` | `hermes` | ACP `session/update` | — | — | ✓ | — |
| `EchoDriver` | `echo` | none (hermetic, in-process) | ✓ | ✓ | ✓ | ✓ |

Write your own by implementing `AgentDriver` and passing it to `createLoom({ drivers })` (or
`loom.registerDriver(...)`). A driver normalizes its agent into `DriverEvent`s:

```ts
type DriverEvent =
  | { type: 'session';  sessionId: string }
  | { type: 'text';     delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool';     call: UniversalToolCall }   // emit on tool start AND completion (status update)
  | { type: 'plan';     plan: UniversalPlan }
  | { type: 'subagent'; subagent: UniversalSubAgent }
  | { type: 'usage';    usage: Partial<UniversalUsage> }
  | { type: 'artifact'; artifact: UniversalArtifact }
  | { type: 'activity'; line: string };             // explicit activity line (drivers that don't emit tool events)

interface AgentDriver {
  readonly id: string;
  readonly capabilities?: { steer?: boolean; interact?: boolean; resume?: boolean; tui?: boolean };
  run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult>; // ctx: { signal, emit, askUser, registerSteer }
  tui?(input: TuiInput): TuiSpec;
}
```

---

## Surfaces & Ports

**Surfaces** (上层) bind to `LoomIO`. Built in: `WebSurface` (a WebSocket host speaking the
wire protocol — any pikichannel-style client connects), `CliSurface`. Implement `Surface` to
add an IM channel or your own UI.

**Ports** (side) — all optional, each with a default, so `createLoom()` runs with zero config:

| Port | Default | Swap to… |
|------|---------|----------|
| `SessionStore` | `FsSessionStore` (`~/.<ns>/sessions`) | your DB / transcript store |
| `ModelResolver` | `NullModelResolver` (native login) | BYOK credential/provider injection |
| `ToolProvider` | `NoopToolProvider` | per-session MCP servers |
| `SystemPromptBuilder` | `PassthroughSystemPromptBuilder` | your system/developer prompt |
| `Catalog` | `NoopCatalog` | model/effort/tool/skill discovery for composers |
| `InteractionHandler` | `DeferToTerminalInteractionHandler` | programmatic HITL answers (`AutoCancelInteractionHandler` for one-shots) |

**Plugins** contribute per-session tools (`tools()`) and/or augment snapshots (`decorateSnapshot()`).

---

## Exports

Main entry `@pikiloom/kernel` re-exports everything. Subpaths: `@pikiloom/kernel/drivers`,
`@pikiloom/kernel/surfaces`, `@pikiloom/kernel/protocol`.

- Runtime: `createLoom`, `Loom`, `Hub`, `SessionRunner`, `runTurn`, `PtyBridge`, `ptyAvailable`, `attachTui`
- Drivers: `EchoDriver`, `ClaudeDriver`, `CodexDriver`, `GeminiDriver`, `HermesDriver`
- Surfaces: `WebSurface`, `CliSurface`
- Ports/defaults: `FsSessionStore`, `NullModelResolver`, `NoopToolProvider`, `PassthroughSystemPromptBuilder`, `AutoCancelInteractionHandler`, `DeferToTerminalInteractionHandler`, `NoopCatalog`, `defaultBaseDir`
- Protocol: `UniversalSnapshot`, `diffSnapshot`, `applySnapshotPatch`, `emptySnapshot`, `PROTOCOL_VERSION`, all wire/`Client*`/`Server*` message types
- Types: `AgentDriver`, `AgentTurnInput`, `DriverContext`, `DriverEvent`, `DriverResult`, `LoomIO`, `PromptInput`, `Surface`, `Plugin`, `SessionStore`, `ModelResolver`, `ToolProvider`, `SystemPromptBuilder`, `InteractionHandler`, `Catalog`, …

---

## Verify

```bash
npm run typecheck                 # tsc, clean
npm test                          # hermetic: snapshot diff, full lifecycle (stop/steer/interact), web ws flow, driver parsers
KERNEL_E2E_REAL=1 npm test        # also drives the real `claude` CLI end-to-end
node examples/smoke.mjs           # smoke against the compiled dist
```

See `examples/` for a runnable web console, a Feishu/Lark terminal, and a Node smoke test.

## License

MIT
