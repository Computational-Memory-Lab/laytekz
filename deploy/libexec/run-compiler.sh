#!/bin/bash
# PM2 entry point for galley-compiler. Starts apps/compiler/server.js with
# ONLY the variables in compiler.env (nothing inherited from PM2 or a login
# shell), inside galley-sandbox's layer-1 Landlock sandbox.
#   GALLEY_COMPILER_ENV  another env file (the smoke-test instance uses this)
#
# The environment is built with bash builtins (unset, export) rather than
# `env -i NAME=value ...`: a command line is readable by every account on the
# machine, and COMPILER_TOKEN must not appear on one, not even for the moment
# before env replaces itself.
set -euo pipefail
umask 077
# shellcheck source=../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

ENV_FILE=${GALLEY_COMPILER_ENV:-$GALLEY_CONFIG/compiler.env}
[[ -r "$ENV_FILE" ]] || { echo "run-compiler: $ENV_FILE missing; run setup.sh" >&2; exit 78; }
CODE_REAL=$(readlink -f "$GALLEY_CODE")
NODE_REAL=$(readlink -f "$GALLEY_NODE_BIN/node")
SANDBOX="$GALLEY_BIN/libexec/galley-sandbox.py"

vars=()
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in ''|'#'*) continue ;; esac
  [[ "$line" == *=* ]] || continue
  name=${line%%=*}
  # The compiler runs untrusted LaTeX: refuse anything that looks like a
  # secret. COMPILER_TOKEN is the one exception: the compiler checks it on
  # every request and removes it from its environment before starting any
  # tool, and galley-sandbox drops it again for every TeX run.
  if [[ "$name" != COMPILER_TOKEN && "$name" =~ (SECRET|TOKEN|PASSW|PRIVATE|CREDENTIAL|API_KEY|CLIENT_ID|GOOGLE|SMTP|DATABASE_URL|REDIS_URL|SIGNING) ]]; then
    echo "run-compiler: refusing to start, $ENV_FILE defines $name (no secrets in the compiler's environment)" >&2
    exit 78
  fi
  vars+=("$line")
done < "$ENV_FILE"
vars+=("GALLEY_SANDBOX_RO_RUNTIME=$CODE_REAL/apps/compiler:$(dirname "$(dirname "$NODE_REAL")")")

home=$(sed -n 's/^HOME=//p' "$ENV_FILE" | tail -n 1)
mkdir -p "$home/tmp" "$home/texmf" "$home/texmf-var" "$home/texmf-config" "$home/.cache" "$home/.config" "$home/par"

cd "$CODE_REAL/apps/compiler"
# Empty the environment, then export exactly the file's variables.
while IFS= read -r name; do unset -v "$name" 2>/dev/null || true; done < <(compgen -e)
for line in "${vars[@]}"; do export "${line?}"; done
unset vars line
exec /usr/bin/python3 -I "$SANDBOX" service -- "$NODE_REAL" server.js
