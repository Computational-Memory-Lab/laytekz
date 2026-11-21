#!/usr/bin/env bash
# Read Laytekz's logs (all in ~/galley-server/logs on the server).
#
#   ./logs.sh                  last 40 lines of the app, compiler and tunnel logs
#   ./logs.sh app              one log: app | compiler | tunnel | backup | cron | deploy
#   ./logs.sh app -n 300       more lines
#   ./logs.sh app -f           follow it live (Ctrl-C to stop)
#   ./logs.sh errors           error and warning lines from the last 2000 lines of each
#
# PM2 writes app.log, compiler.log and tunnel.log (rotated by pm2-logrotate at
# 10 MB, 14 kept, gzipped: app__2026-11-20_03-00-00.log.gz and so on);
# cron writes backup.log and cron.log; every deploy writes deploy-<time>.log.
set -euo pipefail
for a in "$@"; do [[ "$a" == -f ]] && export GALLEY_SSH_TTY=1; done
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"
remote_or_local "$@"

WHAT=${1:-all}; [[ $# -gt 0 ]] && shift
N=40 FOLLOW=0
while (( $# )); do
  case "$1" in
    -n) N=$2; shift ;;
    -f) FOLLOW=1 ;;
    *) fail "unknown option $1" ;;
  esac
  shift
done

file_for() {
  case "$1" in
    app|compiler|tunnel|backup|cron) echo "$GALLEY_LOGS/$1.log" ;;
    deploy) ls -1t "$GALLEY_LOGS"/deploy-*.log 2>/dev/null | head -n 1 ;;
    *) fail "unknown log '$1' (app, compiler, tunnel, backup, cron, deploy, errors, all)" ;;
  esac
}

case "$WHAT" in
  all)
    for w in app compiler tunnel; do
      echo "===== $w ($(file_for $w))"; tail -n "$N" "$(file_for $w)" 2>/dev/null || echo "(empty)"
    done ;;
  errors)
    for w in app compiler tunnel backup cron; do
      f=$(file_for $w); [[ -f "$f" ]] || continue
      hits=$(tail -n 2000 "$f" | grep -Ei 'error|fail|warn|fatal|refus|denied|"level":(40|50|60)' | tail -n "$N" || true)
      [[ -n "$hits" ]] && { echo "===== $w"; echo "$hits"; }
    done; true ;;
  *)
    f=$(file_for "$WHAT"); [[ -n "$f" && -f "$f" ]] || fail "no $WHAT log yet"
    if (( FOLLOW )); then exec tail -n "$N" -F "$f"; else tail -n "$N" "$f"; fi ;;
esac
