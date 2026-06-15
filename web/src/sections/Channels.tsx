import { IM_CHANNELS } from '@/logos';
import { asset } from '@/lib/asset';
import BrowserFrame from '@/components/BrowserFrame';

export default function Channels() {
  return (
    <section id="channels" className="relative border-y border-white/5 bg-white/[0.015]">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">Terminal layer</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Seven native IM channels. Plus the Web.
          </h2>
          <p className="mt-4 text-neutral-400">
            Run one, several, or all of them at once. Each channel is strictly isolated at the code level — adding a
            new terminal (WhatsApp, a mobile app, voice) touches none of the others.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {IM_CHANNELS.map(({ name, node, color }) => (
            <div
              key={name}
              className="group flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-6 transition hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.05]"
            >
              <span
                className="grid h-12 w-12 place-items-center rounded-xl transition group-hover:scale-110"
                style={{ background: `${color}1a`, color }}
              >
                <span className="flex h-6 w-6 items-center justify-center">{node}</span>
              </span>
              <span className="text-center text-sm text-neutral-300">{name}</span>
            </div>
          ))}
          <div className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-white/10 px-3 py-6 text-center">
            <span className="text-2xl text-neutral-500">+</span>
            <span className="text-xs text-neutral-500">Web Dashboard &amp; more</span>
          </div>
        </div>

        <div className="mx-auto mt-12 max-w-4xl">
          <BrowserFrame
            src={asset('media/promo-dashboard-im.png')}
            alt="IM Access dashboard — connection status for all channels"
            ratioW={1440}
            ratioH={900}
            badge="IM Access"
          />
          <p className="mt-3 text-center text-sm text-neutral-400">
            IM Access — check and configure connection status for every channel from the Dashboard.
          </p>
        </div>
      </div>
    </section>
  );
}
