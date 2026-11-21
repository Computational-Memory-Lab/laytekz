# shellcheck shell=bash
# Shared settings and helpers for the Laytekz ops scripts.
#
# The scripts live in two places: the source of truth on your workstation
# (this folder) and a copy on the server (~/galley-server/bin). Run on the
# workstation, a script syncs that copy and re-runs itself on the server over
# ssh (remote_or_local), so every command works from either machine.
# Nothing here prints secrets: env files are only ever read for single,
# non-secret keys (env_get), never echoed or sourced into a printing shell.

# This file's own directory decides which copy is running.
GALLEY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GALLEY_TOOLS_DIR="$(dirname "$GALLEY_LIB_DIR")"

# What is particular to one installation (the server's SSH name, the site's
# public URL) lives in site.env beside the scripts on the workstation. The
# file is not tracked: copy site.env.example. A variable already set in the
# environment wins over the file.
load_site_env() {
  local file="$GALLEY_TOOLS_DIR/site.env" line key
  [[ -r "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    [[ -n "${!key+x}" ]] || printf -v "$key" '%s' "${BASH_REMATCH[2]}"
  done < "$file"
}
load_site_env

GALLEY_SSH_HOST=${GALLEY_SSH_HOST:-}
GALLEY_PUBLIC_URL=${GALLEY_PUBLIC_URL:-}
GALLEY_APP_PORT=${GALLEY_APP_PORT:-3040}
GALLEY_COMPILER_PORT=${GALLEY_COMPILER_PORT:-3041}

on_server() {
  case "${GALLEY_REMOTE:-auto}" in
    0) return 0 ;;
    1) return 1 ;;
  esac
  [[ "$(uname -s)" == Linux && -d "$HOME/galley-server" ]]
}

if on_server; then
  GALLEY_ROOT=${GALLEY_ROOT:-$HOME/galley-server}
  GALLEY_BIN=${GALLEY_BIN:-$GALLEY_ROOT/bin}
  GALLEY_CODE=${GALLEY_CODE:-$GALLEY_ROOT/aldine}
  GALLEY_NODE_BIN=${GALLEY_NODE_BIN:-$HOME/.local/opt/node/bin}
  GALLEY_TEXLIVE=${GALLEY_TEXLIVE:-$HOME/texlive/tl}
  GALLEY_TEXBIN=${GALLEY_TEXBIN:-$GALLEY_TEXLIVE/bin/x86_64-linux}
  GALLEY_BACKUP_DIR=${GALLEY_BACKUP_DIR:-$HOME/galley-backups}
  GALLEY_LOGS=${GALLEY_LOGS:-$GALLEY_ROOT/logs}
  GALLEY_CONFIG=${GALLEY_CONFIG:-$GALLEY_ROOT/config}
  export PATH="$GALLEY_NODE_BIN:$GALLEY_TEXBIN:/usr/local/bin:/usr/bin:/bin"
  umask 077
  # The site's URL comes from the caller, else from what setup wrote for the app.
  if [[ -z "$GALLEY_PUBLIC_URL" && -r "$GALLEY_CONFIG/app.env" ]]; then
    GALLEY_PUBLIC_URL=$(sed -n 's/^ALDINE_PUBLIC_URL=//p' "$GALLEY_CONFIG/app.env" | tail -n 1)
  fi
  if [[ -z "$GALLEY_PUBLIC_URL" ]]; then
    printf 'FAILED: %s\n' "GALLEY_PUBLIC_URL is not set. Run this from your workstation (it reads deploy/site.env), or export GALLEY_PUBLIC_URL=https://your.site first." >&2
    exit 1
  fi
else
  if [[ -z "$GALLEY_SSH_HOST" || -z "$GALLEY_PUBLIC_URL" ]]; then
    printf 'FAILED: %s\n' "this installation is not configured. Copy $GALLEY_TOOLS_DIR/site.env.example to $GALLEY_TOOLS_DIR/site.env and set GALLEY_SSH_HOST and GALLEY_PUBLIC_URL." >&2
    exit 1
  fi
fi

# Settings the server-side copy of a script needs from the workstation, as a
# prefix for a remote command line.
remote_env() { printf 'GALLEY_PUBLIC_URL=%q ' "$GALLEY_PUBLIC_URL"; }

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

# Copy the tooling (this directory) to ~/galley-server/bin on the server. The
# tooling holds no secrets, and nothing local-only travels with it: that folder
# is readable from inside the compile sandbox. Group/other permissions are
# stripped on arrival.
sync_tooling() {
  rsync -a --delete --chmod=go-rwx \
    --exclude .DS_Store --exclude site.env --exclude '*.env' --exclude '*.local.md' \
    --exclude 'secrets/' --exclude '*.pem' --exclude '*.key' --exclude '*credentials*.json' \
    "$GALLEY_TOOLS_DIR/" "$GALLEY_SSH_HOST:galley-server/bin/" \
    || fail "could not copy the ops tooling to $GALLEY_SSH_HOST:~/galley-server/bin"
}

# Run on the workstation: sync the tooling, then run the same script on the
# server with the same arguments, and exit with its status. Run on the server:
# do nothing.
remote_or_local() {
  if ! on_server; then
    sync_tooling
    local script args=""; script="$(basename "$0")"
    (( $# )) && args="$(printf '%q ' "$@")"
    # shellcheck disable=SC2029  # the arguments are quoted for the remote shell on purpose
    exec ssh ${GALLEY_SSH_TTY:+-t} "$GALLEY_SSH_HOST" "$(remote_env)galley-server/bin/$script $args"
  fi
}

# One key from a KEY=VALUE env file, without loading the rest of the file.
env_get() {
  local file=$1 key=$2
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# GET a URL; prints the HTTP status only (body discarded), 000 when unreachable.
http_status() {
  curl -s -o /dev/null -m "${2:-10}" -w '%{http_code}' "$1" 2>/dev/null || true
}

# Wait until a URL answers 200, up to $2 seconds.
wait_http_200() {
  local url=$1 limit=${2:-60} waited=0
  while (( waited < limit )); do
    [[ "$(http_status "$url" 5)" == 200 ]] && return 0
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

# The code slot (app-a / app-b) the live symlink points at.
active_slot() { basename "$(readlink -f "$GALLEY_CODE")"; }
other_slot()  { if [[ "$(active_slot)" == app-a ]]; then echo app-b; else echo app-a; fi; }

# "name status restarts pid" for every PM2 process (JSON parsed by Node).
pm2_states() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list = []; try { list = JSON.parse(s.slice(s.indexOf("["))); } catch { process.exit(0); }
      for (const p of list) console.log(p.name, p.pm2_env.status, p.pm2_env.restart_time, p.pid);
    });'
}
pm2_has()    { pm2_states | awk -v n="$1" '$1 == n { f = 1 } END { exit !f }'; }
pm2_online() { pm2_states | awk -v n="$1" '$1 == n && $2 == "online" { f = 1 } END { exit !f }'; }

# Which slot's source tarball is the one served (galley-source.tar.gz is a
# hard link to source/galley-source-<slot>.tar.gz).
served_source() {
  local live="$GALLEY_ROOT/source/galley-source.tar.gz" f
  [[ -f "$live" ]] || { echo MISSING; return; }
  for f in "$GALLEY_ROOT"/source/galley-source-app-*.tar.gz; do
    [[ "$f" -ef "$live" ]] && { basename "$f"; return; }
  done
  echo "galley-source.tar.gz (no slot copy)"
}

# Upstream Aldine's version string of a code tree (package.json "version").
code_version() {
  sed -n 's/^  "version": "\(.*\)",$/\1/p' "${1:-$GALLEY_CODE}/package.json" | head -n 1
}

# COMPILER_TOKEN is the shared secret the app sends to the compiler in the
# x-compiler-token header; the compiler refuses every request but GET /health
# without it. The same line sits in config/app.env and config/compiler.env.
# These helpers only ever move it between files: it is never printed.
COMPILER_TOKEN_LINE_RE='^COMPILER_TOKEN=[A-Za-z0-9_-]{43,}$'

# The token line in use (app.env first, then compiler.env), or nothing.
compiler_token_line() {
  local f line
  for f in "$GALLEY_CONFIG/app.env" "$GALLEY_CONFIG/compiler.env"; do
    line=$(grep -E "$COMPILER_TOKEN_LINE_RE" "$f" 2>/dev/null | tail -n 1 || true)
    if [[ -n "$line" ]]; then printf '%s' "$line"; return 0; fi
  done
  return 0
}

# A fresh token line: 64 base64url characters (48 random bytes).
new_compiler_token_line() {
  printf 'COMPILER_TOKEN=%s' "$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')"
}

# Make both env files carry the same token, generating one when neither has
# a valid one (--rotate: always a new one). Sets COMPILER_TOKEN_CHANGED=1
# when a file was rewritten; the app and the compiler must then restart
# together, or the one still on the old value refuses or is refused.
ensure_compiler_token() {
  local app="$GALLEY_CONFIG/app.env" comp="$GALLEY_CONFIG/compiler.env" line f
  [[ -f "$app" && -f "$comp" ]] || fail "$app or $comp is missing; run setup.sh"
  if [[ ${1:-} == --rotate ]]; then line=$(new_compiler_token_line); else line=$(compiler_token_line); fi
  [[ -n "$line" ]] || line=$(new_compiler_token_line)
  COMPILER_TOKEN_CHANGED=0
  for f in "$app" "$comp"; do
    if [[ "$(grep -c '^COMPILER_TOKEN=' "$f" || true)" != 1 || "$(grep '^COMPILER_TOKEN=' "$f")" != "$line" ]]; then
      { grep -v '^COMPILER_TOKEN=' "$f" || true; printf '%s\n' "$line"; } > "$f.tmp"
      chmod 600 "$f.tmp"; mv "$f.tmp" "$f"
      COMPILER_TOKEN_CHANGED=1
    fi
  done
  line=""
}
