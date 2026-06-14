#!/usr/bin/env bash

set -euo pipefail

DEV_DIR="${HOME}/.pikiloop/dev"
LOG_FILE="${DEV_DIR}/dev.log"

# Dev mode must stay on the local source tree.
# Do not hop into the production/self-bootstrap `npx pikiloop@latest` chain.
mkdir -p "${DEV_DIR}"

# Decide whether to detach early.
#
# Why this happens FIRST, before any kill / build:
# dev.sh restarts the running pikiloop runtime, and when invoked from inside an
# agent session (Codex app-server, Claude `-p`, …) that runtime IS the host
# process for the agent. If we kill the runtime while still living in the
# agent's bash subtree, the agent's stdio breaks mid-script: Codex cancels the
# current turn and tears down the bash subprocess, killing dev.sh before it can
# hand off to nohup, so the new dev never starts. Detaching first severs us
# from that subtree so the subsequent kill is safe.
#
# Priority:
#   already detached (PIKILOOP_DEV_DETACHED=1)   -> no, we ARE the worker
#   PIKILOOP_DEV_BACKGROUND=1                    -> yes
#   PIKILOOP_DEV_FOREGROUND=1                    -> no
#   no controlling TTY (agent Bash tool, piped)  -> yes
#   otherwise                                    -> no (interactive terminal)
_should_detach=0
if [[ "${PIKILOOP_DEV_DETACHED:-0}" == "1" ]]; then
  _should_detach=0
elif [[ "${PIKILOOP_DEV_BACKGROUND:-0}" == "1" ]]; then
  _should_detach=1
elif [[ "${PIKILOOP_DEV_FOREGROUND:-0}" == "1" ]]; then
  _should_detach=0
elif [[ ! -t 1 ]]; then
  _should_detach=1
fi

if (( _should_detach )); then
  : > "${LOG_FILE}"
  # nohup ignores SIGHUP so the worker outlives this shell; disown removes it
  # from the job table so the calling agent's bash doesn't track it.
  # setsid isn't portable to macOS, but nohup + redirect + disown is enough
  # because the worker is reparented to init once we exit immediately below.
  nohup env PIKILOOP_DEV_DETACHED=1 bash "$0" "$@" </dev/null >>"${LOG_FILE}" 2>&1 &
  _bg_pid=$!
  disown "$_bg_pid" 2>/dev/null || true
  cat <<EOF
[dev.sh] detached worker spawned (pid=${_bg_pid}); restart proceeds outside caller's process tree
[dev.sh]   log:  ${LOG_FILE}     (tail -f to follow)
[dev.sh]   stop: pkill -f 'tsx src/cli/main.ts --no-daemon'
[dev.sh]   force foreground next time: PIKILOOP_DEV_FOREGROUND=1 npm run dev
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# Below runs either as the TTY foreground process, or as the detached worker.
# Both are now safe to kill the running pikiloop runtime — neither shares a
# stdio/process-group dependency with the agent that invoked us.
# ---------------------------------------------------------------------------

# Kill any previous dev processes (npm -> bash -> tsx -> node tree)
_killed=0
# 1) Kill by "tsx src/cli.ts --no-daemon" pattern (the actual node worker)
if pkill -f 'tsx src/cli/main.ts --no-daemon' 2>/dev/null; then
  _killed=1
fi
# 2) Kill whatever is listening on the dev dashboard port
_port_pid=$(lsof -ti tcp:3940 2>/dev/null || true)
if [[ -n "$_port_pid" ]]; then
  echo "$_port_pid" | xargs kill 2>/dev/null || true
  _killed=1
fi
if (( _killed )); then
  echo "[dev.sh] killed previous dev process(es), waiting for cleanup..."
  sleep 0.5
fi
rm -f "${DEV_DIR}/dev.pid"

# Remember whether this invocation is the detached worker, BEFORE the env
# scrub below wipes PIKILOOP_DEV_DETACHED along with the rest of PIKILOOP_*.
# The flag controls whether we truncate the log (the worker must not — its
# parent already did, and the worker's own stdout/stderr is being appended
# to that file).
_is_detached_worker=0
[[ "${PIKILOOP_DEV_DETACHED:-0}" == "1" ]] && _is_detached_worker=1

# Dev isolates setting.json only. The managed browser profile intentionally
# stays at ~/.pikiloop/browser/chrome-profile so dev and the main runtime reuse
# the same browser login state.
#
# Clean inherited env vars that leak when launched from inside a running pikiloop
# or Claude Code session. Without this, the dev process inherits agent permissions,
# channel credentials, daemon flags, workdir overrides, etc. from the parent.
# Use pattern-based unset to catch everything rather than maintaining an explicit list.
#
# Whitelist: user-set runtime switches for the Claude driver must survive the
# scrub so the child runtime can see them. `PIKILOOP_CLAUDE_PRINT=1` forces
# print mode (the new opt-out, since TUI is the default), `PIKILOOP_CLAUDE_TUI*`
# covers the legacy on/off plus the `_DEBUG` / `_KEEP_API_KEY` sub-flags.
while IFS= read -r _var; do
  unset "$_var"
done < <(env | grep -oE '^(PIKILOOP_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_MODEL|CLAUDE_PERMISSION_|CODEX_|GEMINI_|DEFAULT_AGENT|FEISHU_|TELEGRAM_|WEIXIN_)[^=]*' \
  | grep -vE '^PIKILOOP_CLAUDE_(TUI|PRINT)' || true)

# Set dev-specific env AFTER the cleanup so they are not wiped.
export PIKILOOP_CONFIG="${DEV_DIR}/setting.json"
export PIKILOOP_LOG_LEVEL="${PIKILOOP_LOG_LEVEL:-debug}"

echo $$ > "${DEV_DIR}/dev.pid"
trap 'rm -f "${DEV_DIR}/dev.pid"' EXIT

# TTY mode truncates here. The detached worker inherits an already-truncated
# log from its parent (see early-detach branch above) AND has been writing its
# own stdout/stderr to that file since spawn, so re-truncating would wipe its
# own startup chatter.
if (( ! _is_detached_worker )); then
  : > "${LOG_FILE}"
fi

{
  npm run build:dashboard
  npx tsx src/cli/main.ts --no-daemon "$@"
} 2>&1 | node scripts/retained-tee.mjs "${LOG_FILE}"
