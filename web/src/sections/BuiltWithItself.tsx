const DAY = [
  { pane: 'Pane 1 · Claude Code', text: 'implements a new dashboard route' },
  { pane: 'Pane 2 · Codex', text: 'writes the matching unit tests on the same workspace' },
  { pane: 'Pane 3 · Gemini', text: 'reviews the diffs and drafts the changelog' },
  { pane: 'Pane 4 · background skill', text: 'sweeps GitHub for issues and drafts replies' },
];

export default function BuiltWithItself() {
  return (
    <section id="built" className="relative scroll-mt-24 border-y border-white/5 bg-white/[0.015]">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">Built with itself</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              The truest test of an orchestrator: can it build itself?
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-neutral-300">
              pikiloom can. We use pikiloom to develop, test, release, and operate pikiloom —
              driving every commit and every release.
            </p>
            <p className="mt-4 leading-relaxed text-neutral-400">
              All streams run entirely in parallel. A single human steers them all — from a phone, in a coffee shop.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0a0c12] p-2 shadow-2xl">
            <div className="flex items-center gap-1.5 px-3 py-2">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 font-mono text-xs text-neutral-500">a typical day inside pikiloom</span>
            </div>
            <div className="grid gap-px overflow-hidden rounded-xl bg-white/5 sm:grid-cols-2">
              {DAY.map((d) => (
                <div key={d.pane} className="bg-[#0a0c12] p-4">
                  <p className="font-mono text-[11px] text-emerald-400/80">{d.pane}</p>
                  <p className="mt-1.5 text-sm text-neutral-300">{d.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
