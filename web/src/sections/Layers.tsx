import SpotlightCard from '@/components/SpotlightCard';
import { LAYERS } from '@/site';

export default function Layers() {
  return (
    <section id="layers" className="relative mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">The orchestrator is the product</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Four layers. Everything else plugs in.
        </h2>
        <p className="mt-4 text-neutral-400">
          A single orchestration core owns routing, memory, observability, and the bot lifecycle —
          so any terminal can talk to any agent, on any model, through any tool.
        </p>
      </div>

      <div className="mt-14 grid gap-5 sm:grid-cols-2">
        {LAYERS.map((layer) => (
          <SpotlightCard
            key={layer.name}
            spotlightColor={layer.spotlight}
            className="!bg-white/[0.02] !border-white/10"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="font-mono text-xs text-neutral-500">{layer.index}</span>
                <h3 className="mt-1 text-xl font-semibold text-white">{layer.name}</h3>
                <p className="text-sm text-neutral-400">{layer.tagline}</p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-neutral-300">{layer.blurb}</p>
            <ul className="mt-5 space-y-1.5">
              {layer.bullets.map((b) => (
                <li key={b} className="flex items-center gap-2 text-sm text-neutral-400">
                  <span className="h-1 w-1 rounded-full bg-neutral-600" />
                  {b}
                </li>
              ))}
            </ul>
          </SpotlightCard>
        ))}
      </div>
    </section>
  );
}
