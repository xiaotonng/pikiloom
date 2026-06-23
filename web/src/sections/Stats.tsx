import { useEffect, useState } from 'react';
import CountUp from '@/components/CountUp';
import { LINKS } from '@/site';

const PACKAGES = ['pikiloom', 'pikiclaw'] as const;
const FALLBACK_DOWNLOADS = 8386;

function StatValue({ value, suffix }: { value: number | null; suffix?: string }) {
  if (value === null) {
    return <span className="inline-block h-9 w-20 animate-pulse rounded bg-white/10 align-middle" />;
  }
  return (
    <span className="tabular-nums">
      <CountUp key={value} to={value} duration={1.6} separator="," className="tabular-nums" />
      {suffix}
    </span>
  );
}

export default function Stats() {
  const [downloads, setDownloads] = useState<number | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    Promise.all(
      PACKAGES.map((pkg) =>
        fetch(`https://api.npmjs.org/downloads/point/last-month/${pkg}`, { signal: ac.signal })
          .then((r) => r.json())
          .then((d) => (typeof d?.downloads === 'number' ? d.downloads : 0))
          .catch(() => 0),
      ),
    )
      .then((counts) => {
        const total = counts.reduce((sum, n) => sum + n, 0);
        setDownloads(total > 0 ? total : FALLBACK_DOWNLOADS);
      })
      .catch(() => setDownloads(FALLBACK_DOWNLOADS))
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, []);

  const items = [
    { label: 'npm installs / month', node: <StatValue value={downloads} />, href: LINKS.npm },
    {
      label: 'MCP servers, one-click',
      node: (
        <span className="tabular-nums">
          <CountUp key="mcp" to={20} duration={1.5} className="tabular-nums" />+
        </span>
      ),
      href: undefined,
    },
    { label: 'Native IM channels', node: <CountUp key="ch" to={7} duration={1.4} className="tabular-nums" />, href: undefined },
    { label: 'Built-in agent drivers', node: <CountUp key="ag" to={4} duration={1.4} className="tabular-nums" />, href: undefined },
  ];

  return (
    <section className="relative z-10 mx-auto -mt-6 max-w-5xl px-6">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/5 lg:grid-cols-4">
        {items.map((it) => {
          const inner = (
            <div className="flex h-full flex-col items-center justify-center gap-1 bg-[#08090f] px-4 py-7 text-center transition group-hover:bg-[#0b0d14]">
              <div className="text-3xl font-semibold text-white sm:text-4xl">{it.node}</div>
              <div className="text-xs uppercase tracking-wide text-neutral-500">{it.label}</div>
            </div>
          );
          return it.href ? (
            <a key={it.label} href={it.href} target="_blank" rel="noreferrer" className="group">
              {inner}
            </a>
          ) : (
            <div key={it.label} className="group">
              {inner}
            </div>
          );
        })}
      </div>
    </section>
  );
}
