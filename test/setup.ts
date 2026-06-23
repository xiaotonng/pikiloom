import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-test-config-'));
process.env.PIKILOOM_CONFIG = path.join(tmpRoot, 'setting.json');
