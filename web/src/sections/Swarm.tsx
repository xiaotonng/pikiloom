import { lazy, Suspense } from 'react';
import { LuLayoutGrid, LuShuffle, LuWrench, LuNavigation, LuUsers } from 'react-icons/lu';
import InView from '@/components/InView';
import SafeWebGL from '@/components/SafeWebGL';
import { useIsDesktop } from '@/lib/use-device';

// three.js is heavy — load the ball pit's chunk only when this section nears view.
const Ballpit = lazy(() => import('@/components/Ballpit'));

const POINTS = [
  { icon: LuLayoutGrid, title: 'N parallel sessions', desc: 'Every dashboard pane (or IM thread) is an independent agent stream on its own session workspace.' },
  { icon: LuShuffle, title: 'Mix-and-match agents', desc: 'Claude Code in pane 1, Codex in pane 2, Gemini in pane 3 — different repos, all at once.' },
  { icon: LuWrench, title: 'One unified toolkit', desc: 'Global skills + MCP servers with per-workspace overrides. Configure once; every session inherits it.' },
  { icon: LuNavigation, title: 'Steer from anywhere', desc: 'Interrupt any stream, queue a follow-up, or hand control to the next agent in line — seamlessly.' },
  { icon: LuUsers, title: 'Group collaboration', desc: 'Drop it into a Feishu / Slack / Discord / WeCom group and let the whole team steer one swarm.' },
];

function SwarmStage() {
  const isDesktop = useIsDesktop();
  const caption = (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-5">
      <span className="rounded-full bg-black/45 px-3.5 py-1.5 text-xs text-neutral-200 backdrop-blur">
        Every sphere is an agent — sweep your cursor through the swarm
      </span>
    </div>
  );
  const placeholder = (
    <div
      className="h-full w-full"
      style={{ background: 'radial-gradient(120% 120% at 50% 0%, rgba(82,39,255,.25), transparent 60%), radial-gradient(100% 100% at 50% 100%, rgba(56,189,248,.18), transparent 60%)' }}
    />
  );

  return (
    <div className="relative h-72 overflow-hidden rounded-3xl border border-white/10 bg-[#070810] sm:h-80">
      {isDesktop ? (
        <InView className="absolute inset-0" keepMounted={false} fallback={placeholder}>
          <SafeWebGL fallback={placeholder}>
            <Suspense fallback={placeholder}>
              <Ballpit
                count={140}
                gravity={0.4}
                friction={0.9975}
                wallBounce={0.95}
                followCursor
                colors={[0x7cff67, 0x38bdf8, 0xa78bfa]}
                className="absolute inset-0"
              />
            </Suspense>
          </SafeWebGL>
        </InView>
      ) : (
        placeholder
      )}
      {caption}
    </div>
  );
}

export default function Swarm() {
  return (
    <section className="relative border-y border-white/5 bg-white/[0.015]">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">A swarm by default</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            N agents × N windows × one operator.
          </h2>
          <p className="mt-4 text-neutral-400">
            Most "AI dev tools" assume one user, one agent, one task. pikiclaw assumes the opposite — a swarm of
            agents at one creator's fingertips, sharing a single unified toolkit.
          </p>
        </div>

        <div className="mt-12">
          <SwarmStage />
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 transition hover:border-white/20 hover:bg-white/[0.04]">
              <div className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-emerald-300">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-semibold text-white">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{desc}</p>
            </div>
          ))}
          <div className="grid place-items-center rounded-2xl border border-dashed border-white/10 bg-white/[0.01] p-6 text-center">
            <div>
              <div className="font-mono text-sm text-neutral-400">1 · 2 · 3 · 6 panes</div>
              <p className="mt-1 text-xs text-neutral-500">light / dark · EN / 中文</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
