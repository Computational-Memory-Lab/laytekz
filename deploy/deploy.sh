#!/usr/bin/env bash
# Ship the local server tree to the server and switch Laytekz to it.
#
#   ./deploy.sh                 from your workstation: deploy ../server (this repo's fork)
#   ./deploy.sh --src DIR       deploy another local tree
#   ./deploy.sh --rollback      switch back to the previously deployed code (no build)
#
# Two code slots on the server, ~/galley-server/app-a and app-b; the symlink
# ~/galley-server/aldine names the live one. A deploy never touches the live
# slot while it builds:
#   1. rsync the tree into the OTHER slot (seeded from the live one the first
#      time), with the brief's excludes plus every .gitignore rule of the repo
#      (so .env, .secrets*, .data*, lifecycle-state.json, build output and
#      node_modules are never sent or published);
#   2. on the server: npm ci only when package-lock.json changed since that slot's
#      last install, then the production build (web bundle, server, PDF
#      viewer), then the AGPL source tarball for that slot;
#   3. take a backup (backup-now.sh), make sure config/app.env and
#      config/compiler.env carry the same COMPILER_TOKEN (generated on the
#      first deploy that finds none), flip the symlink, restart
#      galley-compiler and galley-app through PM2;
#   4. wait for health on 127.0.0.1 and through the public URL. If either
#      fails, the symlink and the tarball flip back and the old code restarts.
# Prints OK or FAILED and exits non-zero on failure. Never touches data/,
# meta/ or backups, and changes config/ only to add a missing COMPILER_TOKEN.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"

EXCLUDES=(--exclude=.git --exclude=node_modules --exclude=e2e/shots --exclude=/site --exclude=/brand
          --exclude='.data*' --exclude='.secrets*' --exclude=dist --exclude='/.galley-*' --exclude=.DS_Store
          --filter=':- .gitignore')

# ---------------------------------------------------------------- on your workstation
if ! on_server; then
  SRC="$GALLEY_TOOLS_DIR/../server"
  MODE=deploy
  while (( $# )); do
    case "$1" in
      --src) SRC=${2:?--src needs a directory}; shift ;;
      --rollback) MODE=rollback ;;
      -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
      *) fail "unknown option $1" ;;
    esac
    shift
  done
  sync_tooling
  if [[ $MODE == rollback ]]; then
    ssh "$GALLEY_SSH_HOST" "$(remote_env)galley-server/bin/deploy.sh --rollback" || { say "FAILED: rollback"; exit 1; }
    exit 0
  fi
  SRC="$(cd "$SRC" && pwd)"
  [[ -f "$SRC/package.json" && -f "$SRC/apps/server/package.json" && -f "$SRC/package-lock.json" ]] \
    || fail "$SRC does not look like the Laytekz server tree (the Aldine fork)"
  # rsync's .gitignore merge treats a leading "!" differently from git.
  if find "$SRC" -name .gitignore -not -path '*/node_modules/*' -exec grep -l '^!' {} + 2>/dev/null | grep -q .; then
    fail "a .gitignore in $SRC uses '!' negation, which rsync's filter reads differently; adjust EXCLUDES in deploy.sh first"
  fi
  t0=$SECONDS
  slot=$(ssh "$GALLEY_SSH_HOST" "$(remote_env)galley-server/bin/deploy.sh --prepare-slot") || fail "could not prepare a slot on $GALLEY_SSH_HOST"
  say "== 1/4 sync $SRC -> $GALLEY_SSH_HOST:~/galley-server/$slot"
  rsync -a --delete --chmod=go-rwx --stats "${EXCLUDES[@]}" "$SRC/" "$GALLEY_SSH_HOST:galley-server/$slot/" \
    | grep -E '^(Number of regular files transferred|Total transferred file size)' | sed 's/^/   /'
  if ! ssh "$GALLEY_SSH_HOST" "$(remote_env)galley-server/bin/deploy.sh --on-server $slot"; then
    say "FAILED: deploy did not complete (see above); the previous code is still live"
    exit 1
  fi
  code=$(http_status "$GALLEY_PUBLIC_URL/api/health" 15)
  if [[ "$code" == 200 ]]; then
    say "OK: deployed $(basename "$SRC") to $GALLEY_PUBLIC_URL (slot $slot) in $((SECONDS - t0)) s; public health from this machine: 200"
  else
    say "FAILED: deployed, but $GALLEY_PUBLIC_URL/api/health answers $code from this machine"
    exit 1
  fi
  exit 0
fi

# ---------------------------------------------------------------- on the server
exec 8> "$GALLEY_ROOT/.deploy.lock"
flock -n 8 || fail "another deploy is running"

switch_to() {  # slot
  ln -sfn "$1" "$GALLEY_ROOT/aldine.new" && mv -T "$GALLEY_ROOT/aldine.new" "$GALLEY_CODE"
  if [[ -f "$GALLEY_ROOT/source/galley-source-$1.tar.gz" ]]; then
    ln -f "$GALLEY_ROOT/source/galley-source-$1.tar.gz" "$GALLEY_ROOT/source/galley-source.tar.gz.new"
    mv -T "$GALLEY_ROOT/source/galley-source.tar.gz.new" "$GALLEY_ROOT/source/galley-source.tar.gz"
  fi
}
restart_and_check() {
  pm2 restart galley-compiler >/dev/null && pm2 restart galley-app >/dev/null || return 1
  wait_http_200 "http://127.0.0.1:$GALLEY_COMPILER_PORT/health" 60 || { say "   compiler not healthy"; return 1; }
  wait_http_200 "http://127.0.0.1:$GALLEY_APP_PORT/api/health" 90 || { say "   app not healthy on 127.0.0.1:$GALLEY_APP_PORT"; return 1; }
  say "   127.0.0.1: app and compiler healthy"
  wait_http_200 "$GALLEY_PUBLIC_URL/api/health" 60 || { say "   $GALLEY_PUBLIC_URL/api/health not healthy"; return 1; }
  say "   $GALLEY_PUBLIC_URL: healthy"
}
built() { [[ -f "$1/apps/server/dist/index.js" && -f "$1/apps/web/dist/index.html" && -f "$1/apps/server/assets/pdf-viewer.html" ]]; }

case "${1:-}" in
  --prepare-slot)
    # Print the inactive slot's name; seed it from the live slot the first
    # time so rsync sends only the differences and node_modules is reused.
    live="$(readlink -f "$GALLEY_CODE")"; target="$GALLEY_ROOT/$(other_slot)"
    if [[ ! -d "$target" ]]; then cp -a "$live" "$target"; fi
    basename "$target"
    exit 0 ;;

  --rollback)
    prev="$(other_slot)"; cur="$(active_slot)"
    built "$GALLEY_ROOT/$prev" || fail "$prev has no complete build to roll back to"
    say "== rollback: $cur -> $prev"
    ensure_compiler_token
    switch_to "$prev"
    if restart_and_check; then pm2 save >/dev/null; say "OK: rolled back to $prev (based on Aldine $(code_version))"; exit 0; fi
    say "FAILED: $prev is not healthy either; check ./logs.sh app"; exit 1 ;;

  --on-server)
    slot=${2:?slot}; dir="$GALLEY_ROOT/$slot"
    [[ "$slot" =~ ^app-[ab]$ && -d "$dir" ]] || fail "bad slot $slot"
    [[ "$dir" != "$(readlink -f "$GALLEY_CODE")" ]] || fail "$slot is the live slot; refusing to build in place"
    blog="$GALLEY_LOGS/deploy-$(date +%Y%m%d-%H%M%S).log"
    chmod -R go-rwx "$dir"
    cd "$dir"
    say "== 2/4 build in $slot (log: $blog)"
    lock_sha=$(sha256sum package-lock.json | cut -d' ' -f1)
    if [[ ! -d node_modules || "$(cat .galley-lock-sha 2>/dev/null)" != "$lock_sha" ]]; then
      say "   package-lock.json changed: npm ci"
      rm -f .galley-lock-sha
      npm ci --no-audit --no-fund >> "$blog" 2>&1 || { tail -n 30 "$blog"; fail "npm ci failed"; }
      printf '%s\n' "$lock_sha" > .galley-lock-sha
    else
      say "   package-lock.json unchanged: npm ci skipped"
    fi
    { npm run build -w apps/web && npm run build -w apps/server; } >> "$blog" 2>&1 || { tail -n 40 "$blog"; fail "build failed"; }
    built "$dir" || fail "build finished but its output is incomplete"
    say "   built Laytekz, based on Aldine $(code_version "$dir") (web bundle, server, PDF viewer)"
    "$GALLEY_BIN/libexec/make-source-tarball.sh" "$dir" --no-serve | sed 's/^/   /'

    prev="$(active_slot)"
    # Upstream migrates the SQLite schema at boot and has no downgrade: going
    # back to older code after a migration needs the database from before it.
    bk=$("$GALLEY_BIN/backup-now.sh" --quiet) || fail "pre-deploy backup failed; nothing was switched"
    say "   pre-deploy backup: ${bk##*backup OK: }"
    # The compiler refuses to start on 127.0.0.1 without a token, and the app
    # must send the same one: an install from before the token gets it here.
    ensure_compiler_token
    if (( COMPILER_TOKEN_CHANGED )); then say "   COMPILER_TOKEN: added to config/app.env and config/compiler.env (not shown)"; fi
    say "== 3/4 switch $prev -> $slot and restart"
    switch_to "$slot"
    say "== 4/4 health"
    if restart_and_check; then
      pm2 save >/dev/null
      say "   deploy OK on the server: slot $slot live, $prev kept for ./deploy.sh --rollback"
      exit 0
    fi
    say "   unhealthy: rolling back to $prev"
    switch_to "$prev"
    if restart_and_check; then say "   rolled back; $prev is live again"; else say "   ROLLBACK ALSO UNHEALTHY: check ./status.sh and ./logs.sh app"; fi
    say "   app log tail:"; tail -n 25 "$GALLEY_LOGS/app.log" | sed 's/^/   | /'
    exit 1 ;;

  *)
    fail "run deploy.sh from your workstation (it calls itself on the server with --prepare-slot / --on-server)" ;;
esac
