// Global vitest setup — runs once per worker before any test file is imported.
//
// Defends against tests accidentally writing to the developer's real
// ~/.pikiloom/setting.json. Several Bot APIs (switchWorkdir, setUserWorkdir,
// saveUserConfig, …) resolve their target path from PIKILOOM_CONFIG and fall
// back to ~/.pikiloom/setting.json when it is unset. If a test forgets to
// isolate this variable, every run leaks junk into the user's production
// config and breaks the locally-running pikiloom daemon.
//
// Tests that need their own clean config can still override PIKILOOM_CONFIG
// inside beforeEach — this only sets a per-worker default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-test-config-'));
process.env.PIKILOOM_CONFIG = path.join(tmpRoot, 'setting.json');
