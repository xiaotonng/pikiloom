import { useState } from 'react';
import Particles from '@/components/Particles';
import SafeWebGL from '@/components/SafeWebGL';
import InView from '@/components/InView';
import BlurText from '@/components/BlurText';
import ShinyText from '@/components/ShinyText';
import { AGENTS, HEADLINE, INSTALL_CMD, LINKS, SUBHEAD, TAGLINE } from '@/site';

function CopyCommand() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <button
      onClick={copy}
      className="group flex items-center gap-3 rounded-xl border border-white/12 bg-white/[0.04] px-5 py-3 font-mono text-sm text-neutral-200 backdrop-blur transition hover:border-white/25 hover:bg-white/[0.07]"
      aria-label="Copy install command"
    >
      <span className="text-neutral-500 select-none">$</span>
      <span>{INSTALL_CMD}</span>
      <span className="ml-1 text-xs text-neutral-400 transition group-hover:text-neutral-200">
        {copied ? 'copied ✓' : 'copy'}
      </span>
    </button>
  );
}

export default function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* 3D particle field — the agent swarm, reactive to the cursor */}
      <div className="absolute inset-0 -z-10">
        <SafeWebGL
          fallback={
            <div
              className="h-full w-full"
              style={{ background: 'radial-gradient(60% 60% at 50% 25%, rgba(82,39,255,.18), transparent 70%)' }}
            />
          }
        >
          <InView className="h-full w-full" keepMounted={false} fallback={<div className="h-full w-full" />}>
            <Particles
              particleColors={['#7cff67', '#38bdf8', '#a78bfa', '#ffffff']}
              particleCount={900}
              particleSpread={12}
              speed={0.16}
              particleBaseSize={150}
              sizeRandomness={1.3}
              moveParticlesOnHover
              particleHoverFactor={3}
              alphaParticles
              cameraDistance={18}
              className="h-full w-full"
            />
          </InView>
        </SafeWebGL>
      </div>
      {/* color wash + fade into the page background */}
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: 'radial-gradient(60% 50% at 50% 0%, rgba(82,39,255,.28), transparent 70%)' }}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-48 bg-gradient-to-b from-transparent to-[#05060a]" />

      <div className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-28 pb-24 text-center sm:pt-36">
        <a
          href={LINKS.github}
          target="_blank"
          rel="noreferrer"
          className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.03] px-4 py-1.5 text-xs text-neutral-300 backdrop-blur transition hover:border-white/25"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Open-source Agent orchestrator · MIT · built with itself
        </a>

        <BlurText
          text={HEADLINE}
          animateBy="words"
          delay={120}
          className="justify-center text-center text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-6xl md:text-7xl"
        />

        <div className="mt-6 max-w-2xl">
          <ShinyText
            text={TAGLINE}
            speed={4}
            className="text-base sm:text-lg"
            color="#9aa3b2"
            shineColor="#ffffff"
          />
        </div>

        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-neutral-400 sm:text-base">
          {SUBHEAD}
        </p>

        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
          <CopyCommand />
          <div className="flex gap-3">
            <a
              href={LINKS.github}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl bg-white px-5 py-3 text-sm font-medium text-black transition hover:bg-neutral-200"
            >
              Star on GitHub
            </a>
            <a
              href={LINKS.npm}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-white/15 px-5 py-3 text-sm font-medium text-neutral-200 transition hover:border-white/30 hover:bg-white/5"
            >
              View on npm
            </a>
          </div>
        </div>

        {/* trust strip — agents only; the full model/tool lineup rides the
            logo marquees just below, so listing models here is redundant. */}
        <div className="mt-16 w-full max-w-2xl">
          <p className="mb-4 text-xs uppercase tracking-[0.2em] text-neutral-500">
            Any agent · any model · any tool
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-neutral-400">
            {AGENTS.map((a) => (
              <span key={a} className="rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1">
                {a}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
