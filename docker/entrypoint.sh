#!/usr/bin/env bash
#
# pikiclaw-entrypoint — container init for the pikiclaw image.
#
# Responsibilities (kept tiny on purpose):
#   1. Ensure the per-user state dirs exist with the right ownership when the
#      image is launched with `--user 0:0` or when a bind-mounted host dir came
#      in owned by a foreign uid.
#   2. Echo a small banner so the user can see config status at a glance.
#   3. exec the compiled pikiclaw CLI with the user-supplied args.
#
# We deliberately do NOT:
#   - Auto-write setting.json: the dashboard does that, and overwriting blindly
#     would clobber any mounted volume.
#   - Re-install agent CLIs: the image bakes them. Users who want a different
#     version should rebuild with --build-arg or `docker exec` to `npm i -g`.
#
# Signal handling is provided by tini in the Dockerfile ENTRYPOINT, not here.

set -euo pipefail

HOME_DIR="${HOME:-/home/piki}"
PIKICLAW_DIR="${HOME_DIR}/.pikiclaw"
WORKDIR_DEFAULT="${PIKICLAW_WORKDIR:-/workspace}"

# Ensure the expected dirs exist. Mounted volumes start as empty dirs owned by
# root on first creation; mkdir -p is a no-op when they already exist.
mkdir -p "${PIKICLAW_DIR}" "${WORKDIR_DEFAULT}" \
         "${HOME_DIR}/.claude" "${HOME_DIR}/.codex" "${HOME_DIR}/.gemini" 2>/dev/null || true

# Banner — short enough not to spam, useful for `docker logs` triage.
echo "──────────────────────────────────────────────────────────────"
echo " pikiclaw container starting"
echo "   HOME      : ${HOME_DIR}"
echo "   config    : ${PIKICLAW_DIR}"
echo "   workdir   : ${WORKDIR_DEFAULT}"
echo "   dashboard : http://0.0.0.0:3939   (publish with -p 3939:3939)"
echo "──────────────────────────────────────────────────────────────"

# If the user did not pass any args, fall back to the same default the image
# CMD declares. Keeps `docker run pikiclaw bash` ergonomic without losing the
# "just run the bot" default for `docker run pikiclaw`.
if [[ $# -eq 0 ]]; then
  set -- --no-daemon --workdir "${WORKDIR_DEFAULT}"
fi

# Honor `bash`, `sh`, or any explicit binary the user passes (the official
# Node images use the same pattern).
case "${1:-}" in
  bash|sh|node|npm|npx|claude|codex|gemini|pikiclaw)
    exec "$@"
    ;;
esac

exec node /app/dist/cli/main.js "$@"
