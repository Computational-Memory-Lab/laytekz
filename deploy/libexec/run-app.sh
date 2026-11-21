#!/bin/bash
# PM2 entry point for galley-app. Loads app.env, the Google credentials and
# the optional app.local.env, then replaces itself with the Node server (so
# PM2's stop signal reaches Node, which flushes open documents and commits).
# Secrets are loaded here, after PM2 started this script, so they never sit
# in PM2's process list or its saved dump.
#   GALLEY_APP_ENV  another env file (the smoke-test instance uses this)
set -euo pipefail
umask 077
# shellcheck source=../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

ENV_FILE=${GALLEY_APP_ENV:-$GALLEY_CONFIG/app.env}
[[ -r "$ENV_FILE" ]] || { echo "run-app: $ENV_FILE missing; run setup.sh" >&2; exit 78; }
CODE_REAL=$(readlink -f "$GALLEY_CODE")

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
if [[ -n "${GALLEY_GOOGLE_ENV:-}" ]]; then
  [[ -r "$GALLEY_GOOGLE_ENV" ]] || { echo "run-app: $GALLEY_GOOGLE_ENV missing" >&2; exit 78; }
  # shellcheck disable=SC1090
  . "$GALLEY_GOOGLE_ENV"
fi
local_env="$(dirname "$ENV_FILE")/app.local.env"
# shellcheck disable=SC1090
[[ -z "${GALLEY_APP_ENV:-}" && -r "$local_env" ]] && . "$local_env"
set +a

# The code slot this process runs from (resolved once, so a deploy that flips
# the symlink never mixes two trees inside one running process).
export WEB_DIST="$CODE_REAL/apps/web/dist"
export TEMPLATES_DIR="$CODE_REAL/templates"
export PLUGINS_DIR="$CODE_REAL/plugins"
export PATH="$GALLEY_NODE_BIN:/usr/bin:/bin"

cd "$CODE_REAL/apps/server"
exec "$GALLEY_NODE_BIN/node" dist/index.js
