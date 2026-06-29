import { describe, it, expect } from 'vitest';
import { composeSessionToolPrompt, SESSION_TOOL_CAPABILITIES } from '../src/agent/mcp/capabilities.js';

// The exact strings that previously lived inline in bot.ts (buildMcpDeliveryPrompt /
// buildClaudeAskUserPrompt). This test pins the composed output byte-for-byte so the
// co-location refactor can't silently drift the system prompt delivered to agents.
const ARTIFACT_RETURN =
  '[Artifact Return]\n' +
  'To hand a file to the user — a screenshot, report, archive, generated asset, anything they asked you to "send" — call the `im_send_file` tool with the file path and a short caption. It is delivered through whatever terminal the user is on (an IM chat or the web dashboard) and stays retrievable even when they are connected remotely. Do NOT just print a local filesystem path: a remote user cannot open paths on this machine.';
const ASK_USER =
  '[Asking the user]\n' +
  'The built-in `AskUserQuestion` tool is disabled here and will fail. If you would otherwise call it, call `mcp__pikiloom__im_ask_user` instead — same intent (a question plus optional choices), it blocks until the user replies via the IM/dashboard channel. Default behaviour is unchanged: infer obvious decisions yourself and only ask when you genuinely cannot proceed.';

describe('session tool capabilities (co-located tool + prompt)', () => {
  it('claude + HITL wired → artifact-delivery then ask-user (byte-identical to the old inline assembly)', () => {
    expect(composeSessionToolPrompt({ agent: 'claude', onInteraction: true }))
      .toBe(`${ARTIFACT_RETURN}\n\n${ASK_USER}`);
  });

  it('claude without HITL → artifact-delivery only', () => {
    expect(composeSessionToolPrompt({ agent: 'claude', onInteraction: false })).toBe(ARTIFACT_RETURN);
  });

  it('non-claude agents never get the claude-only ask-user block', () => {
    expect(composeSessionToolPrompt({ agent: 'codex', onInteraction: true })).toBe(ARTIFACT_RETURN);
    expect(composeSessionToolPrompt({ agent: 'gemini', onInteraction: true })).toBe(ARTIFACT_RETURN);
  });

  it('each capability declares the session MCP tools it owns', () => {
    const owned = SESSION_TOOL_CAPABILITIES.flatMap((c) => c.tools);
    expect(owned).toEqual(expect.arrayContaining(['im_send_file', 'im_list_files', 'im_ask_user']));
  });
});
