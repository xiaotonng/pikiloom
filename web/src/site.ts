// Single source of truth for landing-page copy + links.
// Copy is drawn from the project README / CLAUDE.md positioning.

export const LINKS = {
  github: 'https://github.com/xiaotonng/pikiloop',
  npm: 'https://www.npmjs.com/package/pikiloop',
  stars: 'https://github.com/xiaotonng/pikiloop/stargazers',
  reactBits: 'https://reactbits.dev/',
} as const;

export const INSTALL_CMD = 'npx pikiloop@latest';

export const HEADLINE = "Put the world's smartest AI agents in your pocket.";

export const TAGLINE =
  'The open Agent orchestrator for the era when creators no longer need to read code.';

export const SUBHEAD =
  'Plug in any agent, any model, and any tool — then drive a swarm of them in parallel from one console: an IM, the Web Dashboard, or the CLI. You might never open a code file again.';

// Logos/chips shown under the hero as a trust strip.
export const AGENTS = ['Claude Code', 'Codex', 'Gemini', 'Hermes'];
export const MODELS = [
  'Claude',
  'GPT',
  'Gemini',
  'DeepSeek',
  'Doubao',
  'MiMo',
  'MiniMax',
  'Qwen',
  'OpenRouter',
];

export interface Layer {
  index: string;
  name: string;
  tagline: string;
  blurb: string;
  bullets: string[];
  spotlight: `rgba(${number}, ${number}, ${number}, ${number})`;
}

export const LAYERS: Layer[] = [
  {
    index: '01',
    name: 'Terminal',
    tagline: 'Every entry point is first-class.',
    blurb:
      'IM channels and the Web Dashboard are equal, pluggable entry points. New terminals plug right in.',
    bullets: ['Telegram · Feishu · WeChat · Slack', 'Discord · DingTalk · WeCom', 'Web Dashboard · local CLI / API'],
    spotlight: 'rgba(82, 39, 255, 0.18)',
  },
  {
    index: '02',
    name: 'Agent',
    tagline: 'Best-in-class agents, pluggable.',
    blurb:
      'Wrap any agent through one AgentDriver contract. Built-in drivers ship today; ACP-compatible agents plug in via the same interface.',
    bullets: ['Claude Code · Codex · Gemini · Hermes', 'ACP (Agent Client Protocol) support', 'Pluggable driver registry'],
    spotlight: 'rgba(124, 255, 103, 0.16)',
  },
  {
    index: '03',
    name: 'Model',
    tagline: 'Route across every frontier.',
    blurb:
      'A Providers + Profiles vault injects credentials per agent at spawn time, routing across frontier, domestic, local, and any OpenAI-compatible proxy.',
    bullets: ['Claude · GPT · Gemini', 'DeepSeek · Doubao · MiMo · MiniMax · Qwen', 'Ollama · mlx-lm · OpenRouter · any proxy'],
    spotlight: 'rgba(255, 176, 59, 0.16)',
  },
  {
    index: '04',
    name: 'Tool',
    tagline: 'One mesh, silently injected.',
    blurb:
      'Skills, MCP servers, and CLI tools merged across global × workspace scopes and injected into every session automatically.',
    bullets: ['Skills · MCP servers · CLI tools', 'Web search · desktop automation', 'Global × workspace scope merge'],
    spotlight: 'rgba(56, 189, 248, 0.16)',
  },
];
