import { LINKS } from '@/site';
import wordmark from '@/assets/logo-wordmark.png';

export default function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="#top" aria-label="pikiloom" className="flex items-center">
          <img src={wordmark} alt="pikiloom" className="h-7 w-auto" />
        </a>
        <nav className="flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2 py-1 text-sm backdrop-blur">
          <a href="#orchestrator" className="hidden rounded-full px-3 py-1.5 text-neutral-300 transition hover:bg-white/5 hover:text-white sm:block">
            Architecture
          </a>
          <a href="#in-action" className="hidden rounded-full px-3 py-1.5 text-neutral-300 transition hover:bg-white/5 hover:text-white sm:block">
            Demos
          </a>
          <a href="#compare" className="hidden rounded-full px-3 py-1.5 text-neutral-300 transition hover:bg-white/5 hover:text-white sm:block">
            Compare
          </a>
          <a
            href={LINKS.github}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-white px-3.5 py-1.5 font-medium text-black transition hover:bg-neutral-200"
          >
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
