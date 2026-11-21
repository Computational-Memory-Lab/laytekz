#!/bin/bash
# @reboot crontab entry: bring the PM2 processes back after a reboot.
# Cron runs this with a bare environment (PATH=/usr/bin:/bin, no login
# shell), so the paths are set here. Does nothing when Laytekz is already up.
#   resurrect.sh --dry-run   say what it would do, change nothing
set -uo pipefail
# shellcheck source=../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

DRY=0; [[ "${1:-}" == --dry-run ]] && DRY=1
ts() { date '+%F %T'; }
echo "$(ts) resurrect: PATH=$PATH node=$(command -v node || echo MISSING) pm2=$(command -v pm2 || echo MISSING)"
command -v pm2 >/dev/null || { echo "$(ts) resurrect: pm2 not found"; exit 1; }
dump="${PM2_HOME:-$HOME/.pm2}/dump.pm2"
[[ -s "$dump" ]] && echo "$(ts) resurrect: saved process list $dump ($(grep -o '"name": *"galley-[a-z]*"' "$dump" | sed 's/.*: *//' | tr -d '"' | tr '\n' ' '))" \
  || echo "$(ts) resurrect: no saved process list; would start the ecosystem file"

if pgrep -u "$(id -u)" -f 'PM2 v[0-9.]*: God Daemon' >/dev/null && pm2_online galley-app; then
  echo "$(ts) resurrect: PM2 is already running Laytekz; nothing to do"
  exit 0
fi
if (( DRY )); then
  echo "$(ts) resurrect: DRY RUN, would run: $( [[ -s "$dump" ]] && echo "pm2 resurrect" || echo "pm2 start $GALLEY_BIN/config/ecosystem.config.cjs")"
  exit 0
fi
sleep "${GALLEY_BOOT_DELAY:-15}"   # let the network come up before the tunnel dials out
if [[ -s "$dump" ]]; then pm2 resurrect; else pm2 start "$GALLEY_BIN/config/ecosystem.config.cjs"; fi
echo "$(ts) resurrect: done"
pm2 status --no-color 2>/dev/null | grep -E 'galley|pm2-logrotate' || true
