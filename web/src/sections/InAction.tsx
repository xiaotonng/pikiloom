import { asset } from '@/lib/asset';
import BrowserFrame from '@/components/BrowserFrame';

export default function InAction() {
  return (
    <section id="in-action" className="relative mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">See it in action</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Drive a swarm in parallel.
        </h2>
        <p className="mt-4 text-neutral-400">
          Every pane is an independent agent stream on its own session. Dispatch a task to each and watch them all
          work at once — fan out from 1 to 6 panes as you scale.
        </p>
      </div>

      <div className="mt-14">
        <BrowserFrame
          video={asset('media/promo-parallel.mp4')}
          alt="Multiple agents working in parallel across panes"
          ratioW={1280}
          ratioH={800}
          badge="N agents · N panes"
        />
        <p className="mt-3 text-center text-sm text-neutral-400">
          Three agents on three tasks at once, then a six-pane grid — each pane keeps its own agent, model, and history.
        </p>
      </div>

      <div className="mt-10">
        <BrowserFrame
          video={asset('media/promo-switch.mp4')}
          alt="Switch agent mid-session — Claude builds, Gemini reviews, Hermes recaps, all in one session"
          ratioW={1280}
          ratioH={800}
          badge="Switch the brain · same session"
        />
        <p className="mt-3 text-center text-sm text-neutral-400">
          One Claude session: switch to Gemini, then Hermes — the conversation history follows. Claude builds a hook,
          Gemini reviews <em>the previous agent's</em> code, Hermes recaps the whole thread.
        </p>
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <figure className="overflow-hidden rounded-2xl border border-white/10 bg-[#0a0c12] shadow-2xl">
          <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.02] px-4 py-2.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-[11px] font-medium text-neutral-300">Telegram</span>
            <span className="ml-auto text-[11px] text-neutral-500">live, from your phone</span>
          </div>
          <img src={asset('media/promo-demo.gif')} alt="Telegram demo: ask, the agent works locally, result returns" loading="lazy" decoding="async" className="block w-full" />
        </figure>
        <BrowserFrame src={asset('media/promo-dashboard-six.png')} alt="Six independent agent streams in a six-pane grid" ratioW={1600} ratioH={1000} badge="Six in parallel" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <BrowserFrame src={asset('media/promo-dashboard-agent-mode.png')} alt="Standard / Extra access mode" ratioW={1440} ratioH={900} badge="Standard / Extra" />
        <BrowserFrame src={asset('media/promo-dashboard-im.png')} alt="Seven native IM channels" ratioW={1440} ratioH={900} badge="IM Access" />
        <BrowserFrame src={asset('media/promo-dashboard-agents.png')} alt="Agents and Models" ratioW={1440} ratioH={900} badge="Agents &amp; Models" />
      </div>
      <p className="mt-4 text-center text-sm text-neutral-500">
        Toggle Claude Standard / Extra billing · connect 7 IM channels · a Providers + Profiles vault with local models (Ollama · mlx-lm).
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <BrowserFrame src={asset('media/promo-dashboard-extensions.png')} alt="Extensions — MCP servers and skills" ratioW={1440} ratioH={900} badge="Extensions" />
        <BrowserFrame src={asset('media/promo-dashboard-system.png')} alt="System and permissions" ratioW={1440} ratioH={900} badge="System" />
      </div>
      <p className="mt-4 text-center text-sm text-neutral-500">
        MCP servers and skills · live CPU / memory / disk &amp; macOS permissions.
      </p>
    </section>
  );
}
