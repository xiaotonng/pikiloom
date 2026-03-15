---
name: dev
description: This skill should be used when the user asks to start, restart, keep alive, or inspect the local pikiclaw development service, including `npm run dev`, local debug bot startup, dashboard verification, and dev log checks.
version: 1.0.0
---

# Start Local Dev Service

## 1. Stay on the local source chain

Use the checked-out repo only. Do not switch to or modify the production/self-bootstrap `npx pikiclaw@latest` path.

## 2. Default foreground start

When the user wants the local dev service in a normal terminal session, run:

```bash
env -u FEISHU_ALLOWED_CHAT_IDS npm run dev
```

Use `env -u FEISHU_ALLOWED_CHAT_IDS` unless the user explicitly wants a restricted Feishu chat allowlist. A stale allowlist can block incoming messages in dev mode.

## 3. Detached start for persistent remote help

If Codex needs the dev service to survive across tool/session boundaries, spawn it as a detached background process instead of keeping it attached to the current PTY:

```bash
python3 - <<'PY'
import os, subprocess, pathlib
home = pathlib.Path.home()
workdir = pathlib.Path('/Users/xiaoxiao/Desktop/work/pikiclaw')
dev_dir = home / '.pikiclaw' / 'dev'
dev_dir.mkdir(parents=True, exist_ok=True)
log_path = dev_dir / 'detached.out'
pid_path = dev_dir / 'dev.pid'
env = os.environ.copy()
env.pop('FEISHU_ALLOWED_CHAT_IDS', None)
with open(log_path, 'wb') as log, open(os.devnull, 'rb') as devnull:
    p = subprocess.Popen(
        ['npm', 'run', 'dev'],
        cwd=str(workdir),
        env=env,
        stdin=devnull,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )
    pid_path.write_text(str(p.pid))
    print(p.pid)
PY
```

This keeps the dev chain alive after the current agent turn ends. The app still writes its main runtime log to `~/.pikiclaw/dev/dev.log`.

## 4. Verify startup

Check these after launch:

```bash
cat ~/.pikiclaw/dev/dev.pid
lsof -nP -iTCP:3940 -sTCP:LISTEN
tail -n 80 ~/.pikiclaw/dev/dev.log
```

Healthy startup usually shows:

- `dashboard: http://localhost:3940`
- `bot: 测试机器人`
- `✓ Feishu connected, WebSocket listening — ready to receive messages`

## 5. Restart the dev service

Stop only the local source-tree dev chain, then start it again with the detached method above:

```bash
if [ -f ~/.pikiclaw/dev/dev.pid ]; then
  pid=$(cat ~/.pikiclaw/dev/dev.pid)
  kill "$pid" || true
  pkill -P "$pid" || true
fi
pkill -f '/Users/xiaoxiao/Desktop/work/pikiclaw/node_modules/.bin/tsx src/cli.ts --no-daemon' || true
```

After stopping, verify `3940` is no longer listening before starting again.

## 6. Useful paths

- Dev config: `~/.pikiclaw/dev/setting.json`
- Dev app log: `~/.pikiclaw/dev/dev.log`
- Detached outer log: `~/.pikiclaw/dev/detached.out`
- Detached PID file: `~/.pikiclaw/dev/dev.pid`

## Notes

- `npm run dev` already rebuilds the dashboard and runs `tsx src/cli.ts --no-daemon`.
- If the user reports Feishu messages not arriving, check whether `FEISHU_ALLOWED_CHAT_IDS` is set in the launch environment before debugging anything else.
- For code changes that should affect the running dev bot, rebuild if needed and restart the detached dev process so the new code is active.
