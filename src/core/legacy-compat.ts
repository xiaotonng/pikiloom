import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_DIR_NAME,
  LEGACY_STATE_DIR_NAMES,
  ENV_PREFIX,
  LEGACY_ENV_PREFIXES,
} from './constants.js';

export function hydrateLegacyEnv(): void {
  for (const legacy of LEGACY_ENV_PREFIXES) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (!key.startsWith(legacy)) continue;
      const mapped = ENV_PREFIX + key.slice(legacy.length);
      if (process.env[mapped] === undefined) process.env[mapped] = value;
    }
  }
}

export function migrateLegacyStateDir(): void {
  try {
    const home = os.homedir();
    const next = path.join(home, STATE_DIR_NAME);
    if (fs.existsSync(next)) return;
    for (const legacy of LEGACY_STATE_DIR_NAMES) {
      const prev = path.join(home, legacy);
      if (!fs.existsSync(prev)) continue;
      try {
        fs.renameSync(prev, next);
      } catch {
        fs.cpSync(prev, next, { recursive: true });
      }
      return;
    }
  } catch {
  }
}
