#!/usr/bin/env bash
# Back up Laytekz now: one tarball in ~/galley-backups, newest 14 kept.
#
#   ./backup-now.sh            from your workstation or on the server (the crontab runs it nightly)
#   ./backup-now.sh --quiet    only errors and the final line (for cron)
#   ./backup-now.sh --keep N   keep N backups instead of 14
#
# Contents of galley-YYYYmmdd-HHMMSS.tar.gz (mode 600):
#   db/aldine.db   consistent copy of the SQLite database, made by upstream's
#                  own tool (dist/db/snapshot.js, VACUUM INTO) while the app
#                  runs; never a cp/tar of the live file and its WAL
#   data/          every project repository and branch worktree (git), without
#                  the regenerable .aldine-out compile output
#   meta/          Yjs snapshots, undo images, avatars, instance settings
#                  (the live aldine.db* files are left out: db/ has the copy)
#   config/        app.env (holds ALDINE_SIGNING_SECRET), compiler.env
#   MANIFEST.txt   what, when, from which code, and the checks that passed
# The Google client secret and the tunnel credentials are NOT included (they
# are static files in ~/galley-server/secrets and ~/galley-server/cloudflared;
# keep your own copy of those). The database holds working session ids and
# tokens: treat every backup as a credential store.
#
# The repositories are copied while the app runs, as upstream's backup.sh
# does. A commit landing mid-copy can leave a repository a few seconds behind
# the database; restore.sh checks every repository with git fsck.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"
remote_or_local "$@"

QUIET=0 KEEP=14
while (( $# )); do
  case "$1" in
    --quiet) QUIET=1 ;;
    --keep) KEEP=$2; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
  shift
done
log() { (( QUIET )) || say "$@"; }
[[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -ge 1 ]] || fail "--keep needs a positive number"

APP_ENV="$GALLEY_CONFIG/app.env"
[[ -r "$APP_ENV" ]] || fail "$APP_ENV missing"
DATA_DIR=$(env_get "$APP_ENV" DATA_DIR); META_DIR=$(env_get "$APP_ENV" META_DIR); CACHE_DIR=$(env_get "$APP_ENV" CACHE_DIR)
mkdir -p "$GALLEY_BACKUP_DIR" "$GALLEY_ROOT/backups-staging"
chmod 700 "$GALLEY_BACKUP_DIR"

exec 9> "$GALLEY_ROOT/backups-staging/.lock"
flock -n 9 || fail "another backup is running"

stamp=$(date +%Y%m%d-%H%M%S)
work="$GALLEY_ROOT/backups-staging/$stamp"
mkdir -p "$work/db"
trap 'rm -rf "$work"' EXIT
out="$GALLEY_BACKUP_DIR/galley-$stamp.tar.gz"

log "== 1. database snapshot (dist/db/snapshot.js)"
code="$(readlink -f "$GALLEY_CODE")"
if [[ -f "$META_DIR/aldine.db" ]]; then
  # Only the three paths config.ts needs; no secret is passed to the process.
  (cd "$code/apps/server" && env -i PATH="$GALLEY_NODE_BIN:/usr/bin:/bin" HOME="$HOME" \
     DATA_DIR="$DATA_DIR" META_DIR="$META_DIR" CACHE_DIR="$CACHE_DIR" \
     "$GALLEY_NODE_BIN/node" dist/db/snapshot.js "$work/db/aldine.db") >/dev/null \
    || fail "snapshot.js could not copy the database"
  integrity=$(python3 -I - "$work/db/aldine.db" <<'PY'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
r = c.execute("PRAGMA integrity_check").fetchone()[0]
n = {t: c.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in ("users", "project_meta", "sessions")}
print(r, " ".join(f"{k}={v}" for k, v in n.items()))
PY
)
  [[ "$integrity" == ok* ]] || fail "integrity_check of the snapshot: $integrity"
  log "   ok: $integrity"
else
  integrity="no database yet (the app has never started)"
  log "   $integrity"
fi

log "== 2. manifest"
projects=$(find "$DATA_DIR/projects" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
{
  echo "Laytekz backup $stamp"
  echo "host: $(hostname)  created: $(date -Iseconds)"
  echo "code: slot $(basename "$code"), based on Aldine $(code_version "$code"), source $(served_source)"
  echo "database: $integrity"
  echo "project repositories: $projects"
  echo "restore: galley-server/bin/restore.sh <this file> --into DIR   (check)"
  echo "         galley-server/bin/restore.sh <this file> --replace-live-data   (replace the live instance)"
} > "$work/MANIFEST.txt"

log "== 3. archive"
set +e
tar -C "$GALLEY_ROOT" -czf "$out.partial" \
  --warning=no-file-changed --warning=no-file-removed \
  --anchored --exclude=meta/aldine.db --exclude=meta/aldine.db-wal --exclude=meta/aldine.db-shm --exclude='meta/*.tmp' \
  --no-anchored --exclude=.aldine-out \
  "$(basename "$DATA_DIR")" "$(basename "$META_DIR")" config \
  -C "$work" db MANIFEST.txt
rc=$?
set -e
# 1 = a file changed while it was read (the app was writing); 2+ = failure.
(( rc <= 1 )) || { rm -f "$out.partial"; fail "tar exited with $rc"; }
gzip -t "$out.partial" || { rm -f "$out.partial"; fail "the archive does not verify"; }
chmod 600 "$out.partial"
mv "$out.partial" "$out"

log "== 4. rotation (keep $KEEP)"
mapfile -t old < <(ls -1t "$GALLEY_BACKUP_DIR"/galley-*.tar.gz | tail -n +$((KEEP + 1)))
for f in "${old[@]}"; do rm -f -- "$f"; log "   removed $(basename "$f")"; done

say "$(date '+%F %T') backup OK: $out ($(du -h "$out" | cut -f1), $projects project(s), db: ${integrity%% *}), $(ls -1 "$GALLEY_BACKUP_DIR"/galley-*.tar.gz | wc -l) kept"
