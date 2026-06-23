#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const PACKAGES = ['pikiloom', 'pikiclaw'];
const OUT = new URL('../docs/downloads.json', import.meta.url);

async function monthlyInstalls(pkg) {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${pkg}`);
    const data = await res.json();
    return typeof data?.downloads === 'number' ? data.downloads : 0;
  } catch (err) {
    console.warn(`warn: ${pkg}: ${err.message}`);
    return 0;
  }
}

const counts = await Promise.all(PACKAGES.map(monthlyInstalls));
const total = counts.reduce((sum, n) => sum + n, 0);
const message = total >= 1000 ? `${(total / 1000).toFixed(1)}k / month` : `${total} / month`;

const badge = { schemaVersion: 1, label: 'installs', message, color: 'brightgreen' };
writeFileSync(OUT, `${JSON.stringify(badge, null, 2)}\n`);
console.log(`combined ${PACKAGES.join(' + ')} = ${total} → "${message}"`);
