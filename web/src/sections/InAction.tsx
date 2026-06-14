import { asset } from '@/lib/asset';
import BrowserFrame from '@/components/BrowserFrame';

export default function InAction() {
  return (
    <section id="in-action" className="relative mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">See it in action</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Ask from your phone. It runs on your machine.
        </h2>
        <p className="mt-4 text-neutral-400">
          Ask pikiloom to gather and summarize today's AI news — the agent reads, writes, and ships results back
          through Telegram, all steered from your phone.
        </p>
      </div>

      <div className="mt-14 grid items-start gap-6 lg:grid-cols-2">
        {/* Telegram demo — a chat recording, framed as a device, not a browser */}
        <figure className="overflow-hidden rounded-2xl border border-white/10 bg-[#0a0c12] shadow-2xl">
          <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.02] px-4 py-2.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-[11px] font-medium text-neutral-300">Telegram</span>
            <span className="ml-auto text-[11px] text-neutral-500">live, from your phone</span>
          </div>
          <img src={asset('media/promo-demo.gif')} alt="Telegram demo: ask, the agent works locally, result returns" loading="lazy" decoding="async" className="block w-full" />
        </figure>

        <div className="space-y-3">
          <BrowserFrame
            src={asset('media/promo-dashboard-workspace.png')}
            alt="pikiloom Web Dashboard multi-pane workspace"
            ratioW={1500}
            ratioH={773}
            cropTop={0.12}
            badge="Web Dashboard"
          />
          <p className="px-1 text-sm text-neutral-400">
            Multi-pane workspace: session list, live threads, tool-use traces, queued chips, one composer.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <BrowserFrame src={asset('media/promo-dashboard-agents.png')} alt="Agents settings" ratioW={1400} ratioH={787} cropTop={0.135} label="Agents" />
        <BrowserFrame src={asset('media/promo-dashboard-extensions.png')} alt="Extensions settings" ratioW={1400} ratioH={787} cropTop={0.135} label="Extensions" />
        <BrowserFrame src={asset('media/promo-dashboard-system.png')} alt="System info" ratioW={1400} ratioH={784} cropTop={0.135} label="System" />
      </div>
      <p className="mt-4 text-center text-sm text-neutral-500">
        Agents · Extensions · System — set the default agent &amp; per-agent models, manage MCP servers and skills, watch live CPU / memory / disk.
      </p>
    </section>
  );
}
