#!/usr/bin/env bash
# Restore a Laytekz backup made by backup-now.sh.
#
#   ./restore.sh latest --into DIR [--boot]
#       Unpack into DIR (any empty or new directory) and check it: database
#       integrity, row counts, git fsck of every project repository. --boot
#       also starts the built app on 127.0.0.1:3060 (accounts off, no
#       compiler) against the unpacked copy and lists its projects through
#       the API, then stops it. Never touches the live instance.
#
#   ./restore.sh galley-20261120-033000.tar.gz --replace-live-data
#       REPLACE the live projects, database and metadata with the backup.
#       Refuses without that exact flag. Steps: check the backup in a staging
#       copy first; stop galley-app and galley-compiler (the app flushes and
#       commits on the way down); move the current data/ and meta/ aside to
#       ~/galley-server/pre-restore-<time>/ (kept, delete them yourself once
#       happy); move the restored ones into place at the same absolute paths;
#       repair git worktree links; start both; wait for health. The current
#       config/ (env files, signing secret) is kept unless --with-config.
#
# BACKUP is "latest", a file name in ~/galley-backups, or a path.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"
remote_or_local "$@"

usage() { sed -n '2,22p' "$0"; exit "${1:-0}"; }
BACKUP="" INTO="" BOOT=0 LIVE=0 WITH_CONFIG=0
while (( $# )); do
  case "$1" in
    --into) INTO=${2:?--into needs a directory}; shift ;;
    --boot) BOOT=1 ;;
    --replace-live-data) LIVE=1 ;;
    --with-config) WITH_CONFIG=1 ;;
    -h|--help) usage 0 ;;
    -*) fail "unknown option $1" ;;
    *) BACKUP=$1 ;;
  esac
  shift
done
[[ -n "$BACKUP" ]] || usage 2
if [[ -z "$INTO" && $LIVE == 0 ]]; then
  say "Refusing: say --into DIR to unpack and check a copy, or --replace-live-data to replace the live instance."
  exit 2
fi
[[ -n "$INTO" && $LIVE == 1 ]] && fail "choose --into or --replace-live-data, not both"

case "$BACKUP" in
  latest) BACKUP=$(ls -1t "$GALLEY_BACKUP_DIR"/galley-*.tar.gz 2>/dev/null | head -n 1); [[ -n "$BACKUP" ]] || fail "no backups in $GALLEY_BACKUP_DIR" ;;
  */*) ;;
  *) BACKUP="$GALLEY_BACKUP_DIR/$BACKUP" ;;
esac
[[ -f "$BACKUP" ]] || fail "no such backup: $BACKUP"
gzip -t "$BACKUP" || fail "$BACKUP is damaged (gzip -t)"

# Unpack into $1 and put the database where the app expects it.
unpack() {
  local dir=$1
  mkdir -p "$dir"; chmod 700 "$dir"
  tar -C "$dir" -xzf "$BACKUP"
  if [[ -f "$dir/db/aldine.db" ]]; then
    rm -f "$dir/meta/aldine.db-wal" "$dir/meta/aldine.db-shm"
    mv "$dir/db/aldine.db" "$dir/meta/aldine.db"; chmod 600 "$dir/meta/aldine.db"
    rmdir "$dir/db"
  fi
}

# Check an unpacked tree; prints a summary, fails on damage.
check_tree() {
  local dir=$1 bad=0
  [[ -f "$dir/MANIFEST.txt" ]] && sed 's/^/  | /' "$dir/MANIFEST.txt"
  if [[ -f "$dir/meta/aldine.db" ]]; then
    local r
    r=$(python3 -I - "$dir/meta/aldine.db" <<'PY'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
r = c.execute("PRAGMA integrity_check").fetchone()[0]
v = c.execute("PRAGMA user_version").fetchone()[0]
n = {t: c.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in ("users", "sessions", "project_meta", "comments")}
print(r, f"schema={v}", " ".join(f"{k}={x}" for k, x in n.items()))
PY
)
    if [[ "$r" == ok* ]]; then say "  database: $r"; else say "  database: DAMAGED ($r)"; bad=1; fi
  else
    say "  database: none in this backup"
  fi
  local n=0 repo
  for repo in "$dir"/data/projects/*/; do
    [[ -d "$repo/.git" ]] || continue
    n=$((n + 1))
    if ! git -C "$repo" fsck --no-progress --no-dangling >/dev/null 2>&1; then
      say "  git fsck FAILED: ${repo#"$dir"/}"; bad=1
    fi
  done
  say "  repositories: $n checked with git fsck$( ((bad)) || echo ', all clean')"
  return $bad
}

if [[ -n "$INTO" ]]; then
  [[ -e "$INTO" && -n "$(ls -A "$INTO" 2>/dev/null)" ]] && fail "$INTO is not empty"
  say "== unpacking $(basename "$BACKUP") into $INTO"
  unpack "$INTO"
  check_tree "$INTO" || fail "the backup has damage (see above)"
  if (( BOOT )); then
    say "== booting the app against the copy (127.0.0.1:3060, accounts off)"
    code="$(readlink -f "$GALLEY_CODE")"
    mkdir -p "$INTO/cache"
    (cd "$code/apps/server" && exec env -i PATH="$GALLEY_NODE_BIN:/usr/bin:/bin" HOME="$HOME" \
        HOST=127.0.0.1 PORT=3060 DATA_DIR="$INTO/data" META_DIR="$INTO/meta" CACHE_DIR="$INTO/cache" \
        COMPILER_URL=http://127.0.0.1:9 WEB_DIST="$code/apps/web/dist" TEMPLATES_DIR="$code/templates" PLUGINS_DIR="$code/plugins" \
        "$GALLEY_NODE_BIN/node" dist/index.js) > "$INTO/boot.log" 2>&1 &
    pid=$!
    if wait_http_200 http://127.0.0.1:3060/api/health 60; then
      projects=$(curl -s -m 10 http://127.0.0.1:3060/api/projects | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const l=Array.isArray(j)?j:(j.projects||[]);console.log(l.length+" project(s): "+l.map(p=>p.name).join(", "))})')
      say "  app booted on the restored copy; /api/health 200; /api/projects lists $projects"
      kill "$pid"; wait "$pid" 2>/dev/null || true
    else
      kill "$pid" 2>/dev/null || true
      tail -n 20 "$INTO/boot.log"; fail "the app did not start on the restored copy"
    fi
  fi
  say "restore check OK: $INTO (delete it when done: rm -rf $INTO)"
  exit 0
fi

# ---- --replace-live-data
stamp=$(date +%Y%m%d-%H%M%S)
stage="$GALLEY_ROOT/backups-staging/restore-$stamp"
say "== 1. unpack and check $(basename "$BACKUP") in $stage"
unpack "$stage"
check_tree "$stage" || fail "the backup has damage; the live instance was not touched"

say "== 2. stop galley-app and galley-compiler"
pm2 stop galley-app galley-compiler >/dev/null
aside="$GALLEY_ROOT/pre-restore-$stamp"
mkdir -p "$aside"; chmod 700 "$aside"

say "== 3. swap data/ and meta/ (current ones kept in $aside)"
mv "$GALLEY_ROOT/data" "$aside/data"
mv "$GALLEY_ROOT/meta" "$aside/meta"
mv "$stage/data" "$GALLEY_ROOT/data"
mv "$stage/meta" "$GALLEY_ROOT/meta"
if (( WITH_CONFIG )) && [[ -d "$stage/config" ]]; then
  cp -a "$GALLEY_CONFIG" "$aside/config"
  cp -a "$stage/config/." "$GALLEY_CONFIG/"
  say "   config/ restored from the backup (previous one in $aside/config)"
fi
chmod 700 "$GALLEY_ROOT/data" "$GALLEY_ROOT/meta"
rm -rf "$stage"
for repo in "$GALLEY_ROOT"/data/projects/*/; do
  id=$(basename "$repo")
  wts=("$GALLEY_ROOT/data/worktrees/$id"/*)
  [[ -e "${wts[0]}" ]] && git -C "$repo" worktree repair "${wts[@]}" >/dev/null 2>&1 || true
done

say "== 4. start and check"
pm2 start galley-compiler galley-app >/dev/null
if wait_http_200 "http://127.0.0.1:$GALLEY_APP_PORT/api/health" 90 && wait_http_200 "$GALLEY_PUBLIC_URL/api/health" 60; then
  pm2 save >/dev/null
  say "restore OK: live data replaced from $(basename "$BACKUP"); previous data in $aside"
else
  say "FAILED: the app is not healthy after the restore. The previous data is in $aside;"
  say "to go back: pm2 stop galley-app galley-compiler; mv data meta somewhere; mv $aside/data $aside/meta $GALLEY_ROOT/; pm2 start galley-compiler galley-app"
  exit 1
fi
