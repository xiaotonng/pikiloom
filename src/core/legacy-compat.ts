/**
 * One-time backward-compat shims for the project rename.
 *
 * The orchestrator shipped as `pikiclaw`, briefly as `pikiloop`, and is now
 * `pikiloom`. Both run once at process startup — BEFORE any config is read or
 * any lock / PID file is taken — so installs created under either old name keep
 * their settings, credentials, managed browser profile and skills with zero
 * user action.
 *
 * Remove this file (and the LEGACY_* constants) a couple of releases after the
 * rename has propagated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_DIR_NAME,
  LEGACY_STATE_DIR_NAMES,
  ENV_PREFIX,
  LEGACY_ENV_PREFIXES,
} from './constants.js';

/**
 * Mirror every legacy-prefixed env var (`PIKILOOP_*`, `PIKICLAW_*`) onto the
 * matching `PIKILOOM_*` name when the new name is unset. Covers user-set vars
 * (shell profiles, docker-compose, systemd units) AND internal ones a still-old
 * parent process may have set across an upgrade boundary. Legacy prefixes are
 * applied newest-first, so the most recent name wins when both are present.
 */
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

/**
 * Migrate the first existing legacy state dir (`~/.pikiloop`, then
 * `~/.pikiclaw`) → `~/.pikiloom`, exactly once.
 *
 * No-op when the new dir already exists (migrated or fresh install) or no legacy
 * dir is present (brand-new user). A same-volume rename is atomic; on a
 * cross-device failure we fall back to a recursive copy and deliberately leave
 * the old dir in place so a partial/failed copy can never lose user data.
 */
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
        // Cross-device or in-use: copy and keep the original as a safety net.
        fs.cpSync(prev, next, { recursive: true });
      }
      return; // migrated from the newest available legacy dir
    }
  } catch {
    // Best-effort only — never block startup on migration.
  }
}
