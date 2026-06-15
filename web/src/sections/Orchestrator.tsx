import type { ComponentType } from 'react';
import {
  LuLayoutDashboard,
  LuMessagesSquare,
  LuTerminal,
  LuFolderOpen,
  LuFile,
  LuChrome,
  LuMonitor,
  LuServer,
  LuBoxes,
} from 'react-icons/lu';
import { LogoLoop } from '@/components/LogoLoop';
import Orb from '@/components/Orb';
import InView from '@/components/InView';
import SafeWebGL from '@/components/SafeWebGL';
import { agentLogos, modelLogos, toolLogos } from '@/logos';

const PAGE_BG = '#05060a';

type Node = { icon: ComponentType<{ className?: string }>; label: string };

const ENTRY: Node[] = [
  { icon: LuLayoutDashboard, label: 'Web Dashboard' },
  { icon: LuMessagesSquare, label: 'Chat Apps · IM' },
  { icon: LuTerminal, label: 'API / CLI' },
];

const ACTIONS: Node[] = [
  { icon: LuFolderOpen, label: 'Workspace' },
  { icon: LuFile, label: 'Files' },
  { icon: LuChrome, label: 'Browser' },
  { icon: LuMonitor, label: 'Desktop' },
  { icon: LuServer, label: 'MCP Tools' },
];

const PIPELINE = ['Entry Points', 'Bot Runtime', 'Agent Driver', 'Model Routing', 'MCP Bridge', 'Workspace Actions'];

function NodeCard({ icon: Icon, label }: Node) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 backdrop-blur transition hover:border-white/25 hover:bg-white/[0.06]">
      <Icon className="h-4 w-4 shrink-0 text-neutral-300" />
      <span className="whitespace-nowrap text-sm text-neutral-200">{label}</span>
    </div>
  );
}

function Connector({ flow }: { flow: string }) {
  return (
    <div className="hidden w-12 flex-col justify-center gap-7 lg:flex xl:w-20">
      {[0, 1, 2].map((i) => (
        <div key={i} className="relative h-px w-full bg-white/10">
          <div
            className="piki-flow absolute inset-0"
            style={{ ['--flow' as string]: flow, animationDelay: `${i * 0.5}s` }}
          />
        </div>
      ))}
    </div>
  );
}

function Core() {
  return (
    <div className="relative grid shrink-0 place-items-center py-6">
      {/* interactive 3D orb halo (mounts only while in view) */}
      <InView className="absolute h-72 w-72" keepMounted={false} fallback={<div className="h-full w-full" />}>
        <SafeWebGL>
          <Orb hue={150} hoverIntensity={0.45} rotateOnHover />
        </SafeWebGL>
      </InView>
      {/* soft pulse behind the card */}
      <div
        className="piki-core-pulse pointer-events-none absolute h-44 w-44 rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgb(var(--brand-glow) / .4), transparent 70%)' }}
      />
      <div className="relative z-10 w-48 rounded-2xl border border-white/15 bg-[#0a0c14]/85 p-5 text-center shadow-2xl backdrop-blur">
        <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-400 text-white shadow-lg">
          <LuBoxes className="h-5 w-5" />
        </div>
        <div className="text-sm font-semibold text-white">Orchestration Core</div>
        <div className="mt-0.5 text-[11px] text-neutral-500">routing · memory · lifecycle</div>
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          {['Routing', 'Memory', 'Observability', 'Intelligence'].map((t) => (
            <span key={t} className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-1 text-[10px] text-neutral-300">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Band({ label, color, logos, direction }: { label: string; color: string; logos: typeof agentLogos; direction: 'left' | 'right' }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="flex w-40 shrink-0 items-center gap-2">
        <span className="h-3 w-3 rounded-sm" style={{ background: color }} />
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</span>
      </div>
      <div className="min-w-0 flex-1">
        <LogoLoop
          logos={logos}
          speed={32}
          direction={direction}
          logoHeight={28}
          gap={22}
          pauseOnHover
          scaleOnHover
          fadeOut
          fadeOutColor={PAGE_BG}
          ariaLabel={label}
        />
      </div>
    </div>
  );
}

export default function Orchestrator() {
  return (
    <section id="orchestrator" className="relative mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">The orchestrator is the product</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Any terminal. Any agent. Any model. Any tool.
        </h2>
        <p className="mt-4 text-neutral-400">
          One open orchestration core sits in the middle — owning routing, memory, observability, and the bot
          lifecycle. Everything around it just plugs in.
        </p>
      </div>

      {/* Live diagram: entry points → core → workspace actions */}
      <div className="mt-16 flex flex-col items-stretch justify-center gap-6 lg:flex-row lg:items-center lg:gap-0">
        <div className="flex flex-row flex-wrap justify-center gap-3 lg:w-52 lg:flex-col">
          <span className="w-full text-center text-[11px] uppercase tracking-widest text-neutral-600 lg:text-left">Entry points</span>
          {ENTRY.map((n) => (
            <NodeCard key={n.label} {...n} />
          ))}
        </div>

        <Connector flow="#7cff67" />
        <Core />
        <Connector flow="#38bdf8" />

        <div className="flex flex-row flex-wrap justify-center gap-3 lg:w-52 lg:flex-col">
          <span className="w-full text-center text-[11px] uppercase tracking-widest text-neutral-600 lg:text-left">Workspace actions</span>
          {ACTIONS.map((n) => (
            <NodeCard key={n.label} {...n} />
          ))}
        </div>
      </div>

      {/* The pluggable layers, as live marquees */}
      <div className="mt-16 flex flex-col gap-5 rounded-2xl border border-white/10 bg-white/[0.015] p-6">
        <Band label="Pluggable agents" color="#a78bfa" logos={agentLogos} direction="left" />
        <Band label="Model routing" color="#38bdf8" logos={modelLogos} direction="right" />
        <Band label="Tool mesh" color="#7cff67" logos={toolLogos} direction="left" />
      </div>

      {/* The request pipeline */}
      <div className="mt-10 hidden flex-wrap items-center justify-center gap-2 md:flex">
        {PIPELINE.map((step, i) => (
          <div key={step} className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-300">{step}</span>
            {i < PIPELINE.length - 1 && <span className="text-neutral-600">→</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
