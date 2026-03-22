# ACP (Agent Client Protocol) Migration Plan

> Status: **Planning** · Created: 2026-03-22

pikiclaw currently spawns each agent CLI as a subprocess and parses its proprietary `stream-json` stdout. ACP is an open protocol (by Zed / Google / JetBrains) that standardizes editor↔agent communication over JSON-RPC, analogous to LSP. Adopting ACP gives pikiclaw a unified driver for any ACP-compatible agent and eliminates per-agent output parsing.

## Strategy

Incremental adoption — add a new `driver-acp.ts` alongside existing drivers. No changes to bot, channel, or dashboard layers. Legacy drivers remain as fallback.

```
Current:   IM → bot-handler → driver-{claude,codex,gemini}.ts → spawn CLI → parse stdout
With ACP:  IM → bot-handler → driver-acp.ts → ACP SDK → initialize → session/prompt → session/update
```

---

## Phase 1 — Proof of Concept

> Goal: validate the ACP path end-to-end with one agent.

- [ ] Install `@agentclientprotocol/sdk` (TypeScript)
- [ ] Create `src/driver-acp.ts` skeleton implementing `AgentDriver`
- [ ] Implement ACP subprocess lifecycle: `spawn → initialize → capability negotiation`
- [ ] Implement `session/new` (new session) and `session/prompt` (send user message)
- [ ] Map `session/update` notifications → existing `onText(text, thinking, activity, meta, plan)` callback
- [ ] Build `StreamResult` from ACP turn-end event (StopReason, token usage, session ID)
- [ ] Test with **Gemini CLI** (ACP reference implementation) — full round-trip: prompt in, streamed reply out, live preview working
- [ ] Add feature flag in `user-config.ts`: `acpEnabled: { claude: bool, gemini: bool, codex: bool }`

### Key decisions for Phase 1

| Item | Approach |
|---|---|
| Agent process lifecycle | Long-lived subprocess pool keyed by `(binary, workdir)`, with idle timeout and crash recovery |
| Client capabilities | Declare nothing except MCP transport support; agent falls back to its own file I/O |
| Permission requests | Auto-approve all `session/request_permission` (IM has no real-time confirmation UX) |
| MCP bridge | Keep existing HTTP callback bridge; pass `mcpConfigPath` via ACP session config |

---

## Phase 2 — Feature Parity

> Goal: ACP driver matches legacy drivers in functionality.

- [ ] Implement `session/load` for session resume (check agent `loadSession` capability; fallback to `session/new`)
- [ ] Add Claude Code as second ACP-supported agent
- [ ] Attachment support: convert file imports to ACP `ContentBlock` (image, resource) — respect agent's `promptContent` capability
- [ ] Map ACP `plan` updates to `StreamPreviewPlan` for live preview
- [ ] Map ACP `tool_call` updates to activity summary (same format as legacy drivers)
- [ ] Extract token usage from ACP metadata (`_meta` or turn-end stats)
- [ ] Implement `getSessions()` — merge ACP-managed sessions with pikiclaw-managed `index.json`
- [ ] Implement `getSessionTail()` — may require agent-specific logic or ACP session history replay
- [ ] Implement `listModels()` — delegate to `SessionConfigOption` if agent exposes model selection
- [ ] Add debounce to `onText` calls (ACP may stream at token granularity → IM API rate limits)
- [ ] Integration tests: stream, resume, cancel, timeout, crash recovery

---

## Phase 3 — MCP Simplification (conditional)

> Goal: replace HTTP callback bridge with MCP-over-ACP, if the spec has stabilized.

- [ ] Check MCP-over-ACP spec status (currently RFD — may not be stable yet)
- [ ] If stable: implement `src/mcp-over-acp.ts`
  - [ ] Handle `mcp/connect` from agent
  - [ ] Route `mcp/message` to existing tool handlers (`im_send_file`, `im_list_files`, `take_screenshot`)
  - [ ] Handle `mcp/disconnect` cleanup
- [ ] If not stable: keep existing `mcp-bridge.ts` + HTTP server, inject config via ACP session params
- [ ] Remove HTTP callback server, port allocation, config file generation/cleanup (when MCP-over-ACP is active)

---

## Phase 4 — Rollout & Cleanup

- [ ] Default ACP on for verified agents (Gemini, Claude)
- [ ] Evaluate Codex ACP support (may not be worth it — Codex already has its own app-server RPC)
- [ ] Deprecate `stream-json` parsing in legacy drivers (keep code, stop active development)
- [ ] New agent onboarding: ACP-only path (zero per-agent parsing code)
- [ ] Document ACP configuration in dashboard UI
- [ ] Update CLAUDE.md project structure

---

## Files to Create

| File | Purpose |
|---|---|
| `src/driver-acp.ts` | Generic ACP driver (~400-600 lines) |
| `src/acp-pool.ts` | Agent subprocess pool (spawn, reuse, crash recovery) |
| `src/mcp-over-acp.ts` | MCP tool injection via ACP channel (Phase 3) |

## Files to Modify

| File | Change |
|---|---|
| `src/agent-driver.ts` | `resolveDriver()` with ACP feature flag check |
| `src/code-agent.ts` | Skip HTTP MCP bridge when ACP path is active |
| `src/user-config.ts` | `acpEnabled` per-agent toggle |
| `package.json` | Add `@agentclientprotocol/sdk` dependency |

## Files Unchanged

bot-handler.ts, bot-telegram*.ts, bot-feishu*.ts, channel-*.ts, bot-streaming.ts, bot-command-ui.ts, dashboard*.ts, mcp-session-server.ts (until Phase 3)

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Agent ACP behavior differs from spec | Stream breaks or missing data | Phase 1 validates with reference impl (Gemini); test each agent individually |
| ACP protocol breaking changes | Driver needs rework | Pin SDK version; protocol uses single-integer versioning |
| MCP-over-ACP stays in RFD | Phase 3 blocked | Existing HTTP bridge remains fully functional |
| Agent ignores missing client capabilities | Unexpected `fs/read_text_file` calls | Return JSON-RPC "method not found"; agent should handle gracefully |
| SDK package size inflates `npx` startup | UX regression | Evaluate bundling / tree-shaking; SDK is TypeScript-native |
| Session ID format mismatch | Merge/display issues in session list | Normalize in `getSessions()`; prefix-based source detection |
| Token-level streaming floods IM API | Rate limit / throttle | Debounce `onText` with configurable interval |

---

## References

- [ACP Specification](https://agentclientprotocol.com/protocol/overview)
- [ACP TypeScript SDK](https://www.npmjs.com/package/@agentclientprotocol/sdk)
- [ACP GitHub](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP Agent Registry](https://agentclientprotocol.com/get-started/registry)
- [MCP-over-ACP RFD](https://agentclientprotocol.com/rfds/mcp-over-acp)
