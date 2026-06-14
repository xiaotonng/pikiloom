/**
 * One-time backward-compat shims for the pikiclaw → pikiloop rename.
 *
 * Both run once at process startup — BEFORE any config is read or any lock /
 * PID file is taken — so existing installs keep their settings, credentials,
 * managed browser profile and skills with zero user action.
 *
 * Remove this file (and the LEGACY_* constants) a couple of releases after the
 * rename has propagated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_DIR_NAME,
  LEGACY_STATE_DIR_NAME,
  ENV_PREFIX,
  LEGACY_ENV_PREFIX,
} from './constants.js';

/**
 * Mirror every `PIKICLAW_*` env var onto the matching `PIKILOOP_*` name when the
 * new name is unset. Covers user-set vars (shell profiles, docker-compose,
 * systemd units) AND internal ones a still-old parent process may have set
 * across an upgrade boundary (e.g. PIKICLAW_DAEMON_CHILD, PIKICLAW_FROM_LAUNCHD).
 */
export function hydrateLegacyEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!key.startsWith(LEGACY_ENV_PREFIX)) continue;
    const mapped = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (process.env[mapped] === undefined) process.env[mapped] = value;
  }
}

/**
 * Migrate `~/.pikiclaw` → `~/.pikiloop` exactly once.
 *
 * No-op when the new dir already exists (migrated or fresh install) or the old
 * one is absent (brand-new user). A same-volume rename is atomic; on a
 * cross-device failure we fall back to a recursive copy and deliberately leave
 * the old dir in place so a partial/failed copy can never lose user data.
 */
export function migrateLegacyStateDir(): void {
  try {
    const home = os.homedir();
    const next = path.join(home, STATE_DIR_NAME);
    const prev = path.join(home, LEGACY_STATE_DIR_NAME);
    if (fs.existsSync(next)) return;
    if (!fs.existsSync(prev)) return;
    try {
      fs.renameSync(prev, next);
    } catch {
      // Cross-device or in-use: copy and keep the original as a safety net.
      fs.cpSync(prev, next, { recursive: true });
    }
  } catch {
    // Best-effort only — never block startup on migration.
  }
}
