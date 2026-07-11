#!/usr/bin/env node
// Renders docs/star-history.svg from the repo's stargazer timestamps, so the
// README's "Star History" chart is a self-hosted static SVG instead of the
// star-history.com hotlink (whose shared GitHub tokens are chronically
// rate-limited and 503 the image). Mirrors refresh-download-badge.mjs: commit
// only when the curve changes, refreshed weekly by star-history-badge.yml.
import { writeFileSync } from 'node:fs';

const REPO = 'xiaotonng/pikiloom';
const OUT = new URL('../docs/star-history.svg', import.meta.url);
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const W = 640;
const H = 320;
const M = { top: 24, right: 24, bottom: 40, left: 56 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const ACCENT = '#38bdf8';
const GRID = '#8b949e';

async function fetchStarredAt() {
  const headers = {
    Accept: 'application/vnd.github.star+json',
    'User-Agent': 'pikiloom-star-history',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const dates = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/stargazers?per_page=100&page=${page}`,
      { headers },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const s of batch) if (s?.starred_at) dates.push(new Date(s.starred_at).getTime());
    if (batch.length < 100) break;
  }
  return dates.sort((a, b) => a - b);
}

function niceCeil(n) {
  if (n <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const v = step * pow;
    if (v >= n) return v;
  }
  return 10 * pow;
}

function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function render(dates) {
  const now = Date.now();
  const t0 = dates.length ? dates[0] : now - 86400000;
  const t1 = Math.max(now, dates.length ? dates[dates.length - 1] : now);
  const span = Math.max(1, t1 - t0);
  const total = dates.length;
  const yMax = niceCeil(Math.max(5, total));

  const x = (ms) => M.left + ((ms - t0) / span) * PLOT_W;
  const y = (v) => M.top + PLOT_H - (v / yMax) * PLOT_H;

  // Cumulative step series: one point per star, plus a final point at "now".
  const pts = [[x(t0), y(0)]];
  dates.forEach((ms, i) => pts.push([x(ms), y(i + 1)]));
  pts.push([x(t1), y(total)]);
  const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${M.left.toFixed(1)},${y(0).toFixed(1)} ${line} ${x(t1).toFixed(1)},${y(0).toFixed(1)}`;

  const yTicks = 4;
  const yLines = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = Math.round((yMax / yTicks) * i);
    const py = y(v);
    yLines.push(
      `<line x1="${M.left}" y1="${py.toFixed(1)}" x2="${M.left + PLOT_W}" y2="${py.toFixed(1)}" stroke="${GRID}" stroke-opacity="0.18" stroke-width="1"/>` +
        `<text x="${M.left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${GRID}">${v}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" role="img" aria-label="Star history: ${total} stars">
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${yLines.join('\n  ')}
  <polygon points="${area}" fill="url(#fill)"/>
  <polyline points="${line}" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${x(t1).toFixed(1)}" cy="${y(total).toFixed(1)}" r="4" fill="${ACCENT}"/>
  <line x1="${M.left}" y1="${M.top + PLOT_H}" x2="${M.left + PLOT_W}" y2="${M.top + PLOT_H}" stroke="${GRID}" stroke-opacity="0.35" stroke-width="1"/>
  <text x="${M.left}" y="${H - 14}" text-anchor="start" font-size="11" fill="${GRID}">${fmtDate(t0)}</text>
  <text x="${M.left + PLOT_W}" y="${H - 14}" text-anchor="end" font-size="11" fill="${GRID}">${fmtDate(t1)}</text>
  <text x="${M.left + PLOT_W}" y="${M.top + 4}" text-anchor="end" font-size="13" font-weight="600" fill="${ACCENT}">${total} ★</text>
</svg>
`;
}

const dates = await fetchStarredAt();
const svg = render(dates);
writeFileSync(OUT, svg);
console.log(`${REPO}: ${dates.length} stars → docs/star-history.svg`);
