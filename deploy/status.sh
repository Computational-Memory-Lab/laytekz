#!/usr/bin/env bash
# Is Laytekz healthy? Processes, listeners, health endpoints, disk, backups.
#   ./status.sh            full report (from your workstation or on the server)
#   ./status.sh --brief    processes and health only
# Exit status 0 when the app, the compiler and the public URL are all healthy.
set -uo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"
remote_or_local "$@"

BRIEF=0; [[ "${1:-}" == --brief ]] && BRIEF=1
ok=0
check() {  # label url
  local code; code=$(http_status "$2" 10)
  if [[ "$code" == 200 ]]; then printf '  %-28s OK (200)\n' "$1"; else printf '  %-28s FAILED (%s)\n' "$1" "$code"; ok=1; fi
}

echo "== processes (PM2)"
pm2 status --no-color 2>/dev/null | grep -E '│ (id|[0-9]+) ' | sed 's/^/  /' || echo "  PM2 is not running"
for n in galley-app galley-compiler galley-tunnel; do
  pm2_online "$n" || { echo "  $n is NOT online"; ok=1; }
done

echo "== health"
check "app   127.0.0.1:$GALLEY_APP_PORT" "http://127.0.0.1:$GALLEY_APP_PORT/api/health"
check "compiler 127.0.0.1:$GALLEY_COMPILER_PORT" "http://127.0.0.1:$GALLEY_COMPILER_PORT/health"
check "public $GALLEY_PUBLIC_URL" "$GALLEY_PUBLIC_URL/api/health"
[[ $BRIEF == 1 ]] && exit $ok

echo "== listeners (must be 127.0.0.1 only)"
ss -tlnpH 2>/dev/null | awk -v a=":$GALLEY_APP_PORT\$" -v c=":$GALLEY_COMPILER_PORT\$" '$4 ~ a || $4 ~ c {print "  " $4 "  " $6}'
if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq "^(0\.0\.0\.0|\*|\[::\]):($GALLEY_APP_PORT|$GALLEY_COMPILER_PORT)$"; then
  echo "  FAILED: a Laytekz port listens on all interfaces"; ok=1
fi
# Only GET /health is open; a typeset request without COMPILER_TOKEN gets 401.
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$GALLEY_COMPILER_PORT/compile" 2>/dev/null || true)
case "$code" in
  401) echo "  compiler API without COMPILER_TOKEN: refused (401)" ;;
  *) echo "  WARNING: the compiler API answers $code to a request without COMPILER_TOKEN (expected 401; run ./setup.sh --restart)"; ok=1 ;;
esac

echo "== code"
echo "  live slot: $(active_slot) (based on Aldine $(code_version)), deployed $(stat -c %y "$(readlink -f "$GALLEY_CODE")/apps/server/dist/index.js" | cut -d. -f1)"
echo "  source tarball: $(served_source)"
compiler_health=$(curl -s -m 5 "http://127.0.0.1:$GALLEY_COMPILER_PORT/health" || true)
echo "  compiler: ${compiler_health:-unreachable}"

echo "== disk"
du -sh "$GALLEY_ROOT/data" "$GALLEY_ROOT/meta" "$GALLEY_ROOT/cache" "$GALLEY_BACKUP_DIR" 2>/dev/null | sed 's/^/  /'
df -h "$GALLEY_ROOT" | tail -n 1 | awk '{print "  filesystem: " $4 " free of " $2 " (" $5 " used)"}'
echo "  projects: $(find "$GALLEY_ROOT/data/projects" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"

echo "== backups"
last=$(ls -1t "$GALLEY_BACKUP_DIR"/galley-*.tar.gz 2>/dev/null | head -n 1)
if [[ -n "$last" ]]; then
  age_h=$(( ($(date +%s) - $(stat -c %Y "$last")) / 3600 ))
  echo "  latest: $(basename "$last") ($(du -h "$last" | cut -f1), ${age_h} h old), $(ls -1 "$GALLEY_BACKUP_DIR"/galley-*.tar.gz | wc -l) kept"
  (( age_h > 36 )) && { echo "  WARNING: the latest backup is over 36 hours old"; ok=1; }
else
  echo "  none yet"; ok=1
fi

echo "== crontab"
crontab -l 2>/dev/null | sed -n '/^# >>> galley/,/^# <<< galley/p' | sed 's/^/  /'
exit $ok
