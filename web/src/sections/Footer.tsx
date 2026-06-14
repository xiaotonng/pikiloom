import { INSTALL_CMD, LINKS } from '@/site';

export default function Footer() {
  return (
    <footer className="relative">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent p-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Start orchestrating in one command.
          </h2>
          <div className="mx-auto mt-6 inline-flex items-center gap-3 rounded-xl border border-white/12 bg-black/40 px-5 py-3 font-mono text-sm text-neutral-200">
            <span className="text-neutral-500">$</span>
            {INSTALL_CMD}
          </div>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <a href={LINKS.github} target="_blank" rel="noreferrer" className="rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-black transition hover:bg-neutral-200">
              GitHub
            </a>
            <a href={LINKS.npm} target="_blank" rel="noreferrer" className="rounded-xl border border-white/15 px-5 py-2.5 text-sm font-medium text-neutral-200 transition hover:border-white/30 hover:bg-white/5">
              npm
            </a>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-center justify-between gap-4 text-sm text-neutral-500 sm:flex-row">
          <span>© {new Date().getFullYear()} pikiloom · MIT License</span>
          <span>
            Landing page crafted with{' '}
            <a href={LINKS.reactBits} target="_blank" rel="noreferrer" className="text-neutral-400 underline-offset-4 hover:text-white hover:underline">
              React Bits
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
