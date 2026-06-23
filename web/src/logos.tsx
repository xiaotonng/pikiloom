import type { ComponentType, ReactNode } from 'react';
import {
  Claude,
  ClaudeCode,
  OpenAI,
  Gemini,
  GeminiCLI,
  DeepSeek,
  Doubao,
  XiaomiMiMo,
  Minimax,
  Qwen,
  Moonshot,
  Ollama,
  OpenRouter,
} from '@lobehub/icons';
import { SiTelegram, SiWechat, SiSlack, SiDiscord } from 'react-icons/si';
import {
  LuBoxes,
  LuPlug,
  LuSparkles,
  LuServer,
  LuTerminal,
  LuSearch,
  LuChrome,
  LuMonitor,
  LuFolder,
  LuSend,
} from 'react-icons/lu';
import type { LogoItem } from '@/components/LogoLoop';

const SZ = 18;

type ColoredIcon = ComponentType<{ size?: number; className?: string }>;
function brand(Icon: unknown, size = SZ): ReactNode {
  const I = Icon as ColoredIcon & { Color?: ColoredIcon; Mono?: ColoredIcon };
  const Comp = I.Color ?? I.Mono ?? I;
  return <Comp size={size} />;
}

function DingTalkGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M6.802 2.02a1 1 0 0 1 .849.22l9.751 8.359a2 2 0 0 1 .235 2.799l-1.06 1.272l.87.436a1 1 0 0 1 .134 1.708l-7 5a1 1 0 0 1-1.539-1.101l1.21-4.034c-2.363-.9-3.747-3.055-4.233-5.483A1 1 0 0 1 7.01 10c-.474-.703-.86-1.42-1.134-2.149c-.649-1.73-.658-3.523.23-5.298a1 1 0 0 1 .696-.533" />
    </svg>
  );
}
function WeComGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="m17.326 8.158l-.003-.007a6.6 6.6 0 0 0-1.178-1.674c-1.266-1.307-3.067-2.19-5.102-2.417a9.3 9.3 0 0 0-2.124 0h-.001c-2.061.228-3.882 1.107-5.14 2.405a6.7 6.7 0 0 0-1.194 1.682A5.7 5.7 0 0 0 2 10.657c0 1.106.332 2.218.988 3.201l.006.01c.391.594 1.092 1.39 1.637 1.83l.983.793l-.208.875l.527-.267l.708-.358l.761.225c.467.137.955.227 1.517.29h.005q.515.06 1.026.059c.355 0 .724-.02 1.095-.06a9 9 0 0 0 1.346-.258c.095.7.43 1.337.932 1.81c-.658.208-1.352.358-2.061.436c-.442.048-.883.072-1.312.072q-.627 0-1.253-.072a10.7 10.7 0 0 1-1.861-.36l-2.84 1.438s-.29.131-.44.131c-.418 0-.702-.285-.702-.704c0-.252.067-.598.128-.84l.394-1.653c-.728-.586-1.563-1.544-2.052-2.287A7.76 7.76 0 0 1 0 10.658a7.7 7.7 0 0 1 .787-3.39a8.7 8.7 0 0 1 1.551-2.19c1.61-1.665 3.878-2.73 6.359-3.006a11.3 11.3 0 0 1 2.565 0c2.47.275 4.712 1.353 6.323 3.017a8.6 8.6 0 0 1 1.539 2.192c.466.945.769 1.937.769 2.978a3.06 3.06 0 0 0-2-.005c-.001-.644-.189-1.329-.564-2.09zm4.125 6.977l-.024-.024l-.024-.018l-.024-.018l-.096-.095a4.24 4.24 0 0 1-1.169-2.192q0-.038-.006-.075l-.006-.056l-.035-.144a1.3 1.3 0 0 0-.358-.61a1.386 1.386 0 0 0-1.957 0a1.4 1.4 0 0 0 0 1.963c.191.191.418.311.668.371c.024.012.06.012.084.012q.019 0 .041.006q.023.005.042.006a4.24 4.24 0 0 1 2.231 1.186c.048.048.096.095.131.143a.323.323 0 0 0 .466 0a.35.35 0 0 0 .036-.455m-1.05 4.37l-.025.025c-.119.096-.31.096-.453-.036a.326.326 0 0 1 0-.467c.047-.036.094-.083.141-.13l.002-.002a4.27 4.27 0 0 0 1.187-2.28q.005-.024.006-.043c0-.024 0-.06.012-.084a1.386 1.386 0 0 1 2.326-.67a1.4 1.4 0 0 1 0 1.964c-.167.18-.382.299-.608.359l-.143.036l-.057.005q-.035.006-.075.007a4.2 4.2 0 0 0-2.183 1.173l-.095.096q-.009.01-.018.024t-.018.024m-4.392-1.053l.024.024l.024.018q.015.009.024.018l.096.096a4.25 4.25 0 0 1 1.169 2.19q0 .04.006.076q.005.03.006.057l.035.143c.06.228.18.443.358.611c.537.539 1.42.539 1.957 0a1.4 1.4 0 0 0 0-1.964a1.4 1.4 0 0 0-.668-.371c-.024-.012-.06-.012-.084-.012q-.018 0-.041-.006l-.042-.006a4.25 4.25 0 0 1-2.231-1.185a1.4 1.4 0 0 1-.131-.144a.323.323 0 0 0-.466 0a.325.325 0 0 0-.036.455m1.039-4.358l.024-.024a.32.32 0 0 1 .453.035a.326.326 0 0 1 0 .467c-.047.036-.094.083-.141.13l-.002.002a4.27 4.27 0 0 0-1.187 2.281l-.006.042c0 .024 0 .06-.012.084a1.386 1.386 0 0 1-2.326.67a1.4 1.4 0 0 1 0-1.963c.166-.18.381-.3.608-.36l.143-.035q.026 0 .056-.006q.037-.005.075-.006a4.2 4.2 0 0 0 2.183-1.174l.096-.095l.018-.025z" />
    </svg>
  );
}

function Chip({ node, label }: { node: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-neutral-200">
      <span className="grid h-[18px] w-[18px] place-items-center">{node}</span>
      {label}
    </span>
  );
}

export const agentLogos: LogoItem[] = [
  { node: <Chip node={brand(ClaudeCode)} label="Claude Code" />, title: 'Claude Code' },
  { node: <Chip node={brand(OpenAI)} label="Codex" />, title: 'Codex' },
  { node: <Chip node={brand(GeminiCLI)} label="Gemini CLI" />, title: 'Gemini CLI' },
  { node: <Chip node={<LuBoxes size={SZ} className="text-violet-300" />} label="Hermes · ACP" />, title: 'Hermes' },
  { node: <Chip node={<LuPlug size={SZ} className="text-neutral-400" />} label="Any CLI / ACP agent" />, title: 'Pluggable' },
];

export const modelLogos: LogoItem[] = [
  { node: <Chip node={brand(Claude)} label="Claude" />, title: 'Claude' },
  { node: <Chip node={brand(OpenAI)} label="GPT · Codex" />, title: 'GPT' },
  { node: <Chip node={brand(Gemini)} label="Gemini" />, title: 'Gemini' },
  { node: <Chip node={brand(DeepSeek)} label="DeepSeek" />, title: 'DeepSeek' },
  { node: <Chip node={brand(Doubao)} label="Doubao" />, title: 'Doubao' },
  { node: <Chip node={brand(XiaomiMiMo)} label="MiMo" />, title: 'MiMo' },
  { node: <Chip node={brand(Minimax)} label="MiniMax" />, title: 'MiniMax' },
  { node: <Chip node={brand(Qwen)} label="Qwen" />, title: 'Qwen' },
  { node: <Chip node={brand(Moonshot)} label="Moonshot · Kimi" />, title: 'Moonshot' },
  { node: <Chip node={brand(OpenRouter)} label="OpenRouter" />, title: 'OpenRouter' },
  { node: <Chip node={brand(Ollama)} label="Ollama · local" />, title: 'Ollama' },
];

export const toolLogos: LogoItem[] = [
  { node: <Chip node={<LuSparkles size={SZ} className="text-emerald-300" />} label="Skills" />, title: 'Skills' },
  { node: <Chip node={<LuServer size={SZ} className="text-sky-300" />} label="MCP Servers" />, title: 'MCP Servers' },
  { node: <Chip node={<LuTerminal size={SZ} className="text-lime-300" />} label="CLI Tools" />, title: 'CLI Tools' },
  { node: <Chip node={<LuSearch size={SZ} className="text-amber-300" />} label="Web Search" />, title: 'Web Search' },
  { node: <Chip node={<LuChrome size={SZ} className="text-emerald-300" />} label="Managed Browser" />, title: 'Managed Browser' },
  { node: <Chip node={<LuMonitor size={SZ} className="text-fuchsia-300" />} label="macOS Desktop" />, title: 'macOS Desktop' },
  { node: <Chip node={<LuFolder size={SZ} className="text-blue-300" />} label="Filesystem" />, title: 'Filesystem' },
];

export interface ImChannel {
  name: string;
  node: ReactNode;
  color: string;
  approximate?: boolean;
}

export const IM_CHANNELS: ImChannel[] = [
  { name: 'Telegram', color: '#26A5E4', node: <SiTelegram className="h-full w-full" /> },
  { name: 'Feishu / Lark', color: '#00D6B9', node: <LuSend className="h-full w-full" />, approximate: true },
  { name: 'WeChat', color: '#07C160', node: <SiWechat className="h-full w-full" /> },
  { name: 'Slack', color: '#E01E5A', node: <SiSlack className="h-full w-full" /> },
  { name: 'Discord', color: '#5865F2', node: <SiDiscord className="h-full w-full" /> },
  { name: 'DingTalk', color: '#3296FA', node: <DingTalkGlyph className="h-full w-full" /> },
  { name: 'WeCom', color: '#2F7CF6', node: <WeComGlyph className="h-full w-full" /> },
];
