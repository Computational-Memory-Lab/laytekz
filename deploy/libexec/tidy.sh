#!/bin/bash
# Hourly crontab entry: housekeeping that never touches user data.
#   - per-run temp dirs of TeX runs (galley-sandbox makes one per run; no run
#     outlives COMPILE_TIMEOUT_MS, 85 s, so anything over 30 minutes is dead)
#   - backup staging left behind by an interrupted backup, and the private
#     directory of a verify-compiler.sh run that was killed
#   - rotation of the two cron logs (PM2's own logs rotate via pm2-logrotate)
set -uo pipefail
# shellcheck source=../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

find "$GALLEY_ROOT/compiler-home/tmp" -mindepth 1 -maxdepth 1 \( -name 'run-*' -o -name 'aldine-format-*' -o -name 'warm-*' \) \
  -mmin +30 -exec rm -rf {} + 2>/dev/null
find "$GALLEY_ROOT/backups-staging" -mindepth 1 -maxdepth 1 -mmin +360 -exec rm -rf {} + 2>/dev/null
# verify-compiler.sh's private header files, left by a run that was killed
find "$GALLEY_ROOT" -mindepth 1 -maxdepth 1 -name '.verify-*' -mmin +60 -exec rm -rf {} + 2>/dev/null
for f in "$GALLEY_LOGS/cron.log" "$GALLEY_LOGS/backup.log"; do
  if [[ -f "$f" ]] && (( $(stat -c %s "$f") > 5 * 1024 * 1024 )); then
    mv -f "$f" "$f.1"; : > "$f"
  fi
done
exit 0
