#!/usr/bin/env bash
# Update TeX Live (user space, ~/texlive/tl) with tlmgr, then make the
# compiler pick it up safely.
#
#   ./update-tex.sh --check    list what would be updated, change nothing
#   ./update-tex.sh            update tlmgr itself and every package, then:
#                              rebuild the compiler's caches (biber, luaotfload,
#                              fontconfig), restart galley-compiler and run
#                              verify-compiler.sh (sandbox and real documents)
#   ./update-tex.sh --install PKG...   add packages (scheme-full has them all;
#                              useful only if the scheme ever shrinks)
#
# Compiles keep working during the update but may fail while packages are
# half-replaced; the compiler restarts once at the end. A copy of each
# replaced package goes to ~/galley-server/tlmgr-backups (90 days):
#   tlmgr restore --backupdir ~/galley-server/tlmgr-backups <package>
# A new yearly TeX Live release (2027 in spring) cannot be reached with tlmgr
# update: install it beside this one, see README.md, "TeX Live".
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"
remote_or_local "$@"

MODE=update; PKGS=()
case "${1:-}" in
  --check) MODE=check ;;
  --install) MODE=install; shift; PKGS=("$@"); (( ${#PKGS[@]} )) || fail "--install needs package names" ;;
  "") ;;
  -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
  *) fail "unknown option $1" ;;
esac
TLMGR="$GALLEY_TEXBIN/tlmgr"
log="$GALLEY_LOGS/update-tex-$(date +%Y%m%d-%H%M%S).log"

say "== TeX Live $(grep -o '20[0-9][0-9]' "$GALLEY_TEXLIVE/release-texlive.txt" 2>/dev/null | head -n 1 || echo '?') at $GALLEY_TEXLIVE, repository: $("$TLMGR" option repository 2>/dev/null | sed 's/.*: //')"
if [[ $MODE == check ]]; then
  "$TLMGR" update --self --all --list 2>&1 | tee "$log" | grep -E '^(update|auto-install|remove|tlmgr:|Total)|^ *[a-z0-9-]+ *\[' | head -n 80 || true
  say "(full list in $log)"
  exit 0
fi

if [[ $MODE == install ]]; then
  "$TLMGR" install "${PKGS[@]}" 2>&1 | tee "$log" | tail -n 5
else
  say "== tlmgr update --self --all (log: $log)"
  "$TLMGR" update --self 2>&1 | tee "$log" | tail -n 3
  # A copy of every package it replaces, so `tlmgr restore` can undo one
  # (TeX Live's own autobackup is 0 on this installation).
  mkdir -p "$GALLEY_ROOT/tlmgr-backups"
  "$TLMGR" update --all --backup --backupdir "$GALLEY_ROOT/tlmgr-backups" 2>&1 | tee -a "$log" | grep -E 'tlmgr: package|running|updated|Total' | tail -n 20 || true
  find "$GALLEY_ROOT/tlmgr-backups" -type f -mtime +90 -delete 2>/dev/null || true
fi
chmod -R go-rwx "$GALLEY_TEXLIVE/texmf-var" 2>/dev/null || true

say "== compiler caches"
"$GALLEY_BIN/libexec/warm-caches.sh" --force
say "== restart galley-compiler"
pm2 restart galley-compiler >/dev/null
wait_http_200 "http://127.0.0.1:$GALLEY_COMPILER_PORT/health" 60 || fail "the compiler did not come back; see ./logs.sh compiler"
say "   $(curl -s -m 5 "http://127.0.0.1:$GALLEY_COMPILER_PORT/health")"
say "== verify"
if "$GALLEY_BIN/libexec/verify-compiler.sh"; then
  say "OK: TeX Live updated and verified"
else
  say "FAILED: verification failed after the update (log: $log). 'tlmgr restore' can undo a package; see README.md."
  exit 1
fi
