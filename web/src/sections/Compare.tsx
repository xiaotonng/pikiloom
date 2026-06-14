const COLS = ['pikiloop', 'IDE assistants', 'Cloud agents', 'Single-agent IM bots'];

const ROWS: { feature: string; cells: [string, string, string, string] }[] = [
  { feature: 'Terminal access', cells: ['7 IM channels + Web + extensible', 'Locked inside the IDE', 'Confined to a web app', 'One specific IM app'] },
  { feature: 'Execution environment', cells: ['Your local machine', 'Your local machine', "Vendor's remote sandbox", 'Usually vendor servers'] },
  { feature: 'Agent flexibility', cells: ['Claude · Codex · Gemini · Hermes (ACP)', 'Locked in', 'Single', 'Single'] },
  { feature: 'Model freedom', cells: ['Frontier · domestic · local · any proxy', 'Platform-controlled', 'Vendor-controlled', 'Single, hardcoded'] },
  { feature: 'Concurrency', cells: ['N agents × N windows × N workspaces', 'One agent per IDE window', 'Strictly sequential', 'Single thread'] },
  { feature: 'Files & tools access', cells: ['Your entire local disk, MCPs, CLIs', 'Local project files', 'Heavily sandboxed', 'None / very limited'] },
  { feature: 'Add a new terminal', cells: ['Drop in a Channel class', 'Impossible', 'Impossible', 'Requires a hard fork'] },
  { feature: 'Add a new agent', cells: ['Implement an AgentDriver', 'Impossible', 'Impossible', 'Requires a hard fork'] },
  { feature: 'Self-bootstrapping', cells: ['Yes — built using itself', 'No', 'No', 'No'] },
];

export default function Compare() {
  return (
    <section id="compare" className="relative mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">How is this different?</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          You never leave your environment. You keep the brain.
        </h2>
      </div>

      <div className="mt-12 overflow-x-auto">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-[#05060a] p-3 text-left font-medium text-neutral-500" />
              {COLS.map((c, i) => (
                <th
                  key={c}
                  className={
                    i === 0
                      ? 'rounded-t-xl border-x border-t border-emerald-400/30 bg-emerald-400/[0.06] p-3 text-left font-semibold text-white'
                      : 'p-3 text-left font-medium text-neutral-400'
                  }
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row, r) => (
              <tr key={row.feature}>
                <td className="sticky left-0 z-10 whitespace-nowrap border-t border-white/5 bg-[#05060a] py-3 pr-4 font-medium text-neutral-300">
                  {row.feature}
                </td>
                {row.cells.map((cell, i) => {
                  const isPiki = i === 0;
                  const isLast = r === ROWS.length - 1;
                  return (
                    <td
                      key={i}
                      className={
                        isPiki
                          ? `border-x border-emerald-400/30 bg-emerald-400/[0.06] p-3 align-top text-neutral-100 ${isLast ? 'rounded-b-xl border-b' : ''}`
                          : 'border-t border-white/5 p-3 align-top text-neutral-500'
                      }
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
