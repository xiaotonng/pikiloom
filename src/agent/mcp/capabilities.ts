// Session tool capabilities: each co-locates a session MCP tool group (defined under
// ./tools/) with the prompt fragment that teaches the agent to use it. This is the local,
// decoupled analog of a @pikiloom/kernel Plugin (a capability = its tools + its usage
// prompt, as one unit). pikiloom composes its own system prompt app-side and feeds the
// kernel a finished string, so this module intentionally does NOT import the kernel — that
// is what keeps pikiloom fully decoupled from the kernel's Hub/plugin runtime.

export interface SessionPromptContext {
  agent: string;
  onInteraction: boolean;   // whether the im_ask_user / HITL path is wired for this turn
}

export interface SessionToolCapability {
  id: string;
  tools: string[];          // the session MCP tool names this capability owns (live in ./tools/)
  promptFragment(ctx: SessionPromptContext): string | null;
}

const ARTIFACT_RETURN = [
  '[Artifact Return]',
  'To hand a file to the user — a screenshot, report, archive, generated asset, anything they asked you to "send" — call the `im_send_file` tool with the file path and a short caption. It is delivered through whatever terminal the user is on (an IM chat or the web dashboard) and stays retrievable even when they are connected remotely. Do NOT just print a local filesystem path: a remote user cannot open paths on this machine.',
].join('\n');

const ASK_USER = [
  '[Asking the user]',
  'The built-in `AskUserQuestion` tool is disabled here and will fail. If you would otherwise call it, call `mcp__pikiloom__im_ask_user` instead — same intent (a question plus optional choices), it blocks until the user replies via the IM/dashboard channel. Default behaviour is unchanged: infer obvious decisions yourself and only ask when you genuinely cannot proceed.',
].join('\n');

export const SESSION_TOOL_CAPABILITIES: SessionToolCapability[] = [
  {
    id: 'artifact-delivery',
    tools: ['im_send_file', 'im_list_files'],
    promptFragment: () => ARTIFACT_RETURN,
  },
  {
    id: 'ask-user',
    tools: ['im_ask_user'],
    // Only when the HITL path is wired and the agent is claude (codex/gemini handle asks natively).
    promptFragment: ({ agent, onInteraction }) => (onInteraction && agent === 'claude') ? ASK_USER : null,
  },
];

// Compose the session tool prompt = each capability's applicable fragment, in registration
// order, joined by a blank line. Byte-identical to the prior inline assembly in bot.ts.
export function composeSessionToolPrompt(ctx: SessionPromptContext): string {
  const parts: string[] = [];
  for (const cap of SESSION_TOOL_CAPABILITIES) {
    const fragment = cap.promptFragment(ctx);
    const trimmed = String(fragment || '').trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join('\n\n');
}
