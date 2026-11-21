#!/usr/bin/env bash
# Provision (or re-provision) Laytekz on the server. Idempotent: safe to run again
# at any time; it only fills in what is missing and re-renders the configs.
#
#   ./setup.sh               from your workstation or on the server
#   ./setup.sh --restart     also restart galley-app and galley-compiler
#   ./setup.sh --warm        rebuild the compiler's font and biber caches
#   ./setup.sh --rotate-compiler-token
#                            new COMPILER_TOKEN in both env files, then restart
#                            galley-compiler and galley-app
#
# What it does: directory layout and permissions, the code-slot symlink,
# config/app.env + config/compiler.env from the templates (the signing secret
# and the compiler token are generated once and kept), PM2 and pm2-logrotate,
# the compiler caches,
# the PM2 processes (moving the tunnel out of its old tmux session), pm2 save,
# the crontab block, and the AGPL source tarball if there is none yet.
# It never touches data/, meta/ or backups, and never prints a secret.
set -euo pipefail
# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"
remote_or_local "$@"

RESTART=0 WARM=0 ROTATE=0
for a in "$@"; do
  case "$a" in
    --restart) RESTART=1 ;;
    --warm) WARM=1 ;;
    --rotate-compiler-token) ROTATE=1 RESTART=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) fail "unknown option $a" ;;
  esac
done

PM2_VERSION=7.1.2
LOGROTATE_VERSION=3.0.1
ECOSYSTEM="$GALLEY_BIN/config/ecosystem.config.cjs"

say "== preconditions"
[[ -x "$GALLEY_NODE_BIN/node" ]] || fail "Node not found at $GALLEY_NODE_BIN"
[[ -x "$GALLEY_TEXBIN/latexmk" ]] || fail "TeX Live not found at $GALLEY_TEXBIN"
[[ -x /usr/local/bin/cloudflared ]] || fail "cloudflared not found at /usr/local/bin/cloudflared"
[[ -r "$GALLEY_ROOT/cloudflared/config.yml" ]] || fail "tunnel config missing: $GALLEY_ROOT/cloudflared/config.yml"
/usr/bin/python3 -I "$GALLEY_BIN/libexec/galley-sandbox.py" selftest \
  || fail "Landlock is unavailable on this kernel; the compiler would run unconfined"
[[ -r "$GALLEY_ROOT/secrets/google-oauth.env" ]] || warn "$GALLEY_ROOT/secrets/google-oauth.env is missing: Google sign-in will not work"

say "== directories (mode 700)"
chmod 700 "$GALLEY_ROOT"
for d in data meta cache logs bin backups-staging config compiler-home source secrets cloudflared opt; do
  mkdir -p "$GALLEY_ROOT/$d"; chmod 700 "$GALLEY_ROOT/$d"
done
mkdir -p "$GALLEY_BACKUP_DIR"; chmod 700 "$GALLEY_BACKUP_DIR"
# Files that predate this setup were made with umask 002.
find "$GALLEY_ROOT/logs" "$GALLEY_ROOT/cloudflared" "$GALLEY_ROOT/secrets" -type f -perm /077 -exec chmod go-rwx {} +
chmod -R go-rwx "$GALLEY_BIN"

say "== code slots"
if [[ -d "$GALLEY_CODE" && ! -L "$GALLEY_CODE" ]]; then
  # First run: the snapshot directory becomes slot app-a behind the symlink.
  [[ -e "$GALLEY_ROOT/app-a" ]] && fail "$GALLEY_ROOT/app-a exists and $GALLEY_CODE is a directory; sort this out by hand"
  mv "$GALLEY_CODE" "$GALLEY_ROOT/app-a"
  ln -s app-a "$GALLEY_CODE"
  say "moved the code tree to app-a; $GALLEY_CODE -> app-a"
fi
[[ -L "$GALLEY_CODE" ]] || fail "$GALLEY_CODE is not a symlink to a code slot"
slot_dir="$(readlink -f "$GALLEY_CODE")"
chmod -R go-rwx "$slot_dir"
if [[ -f "$slot_dir/node_modules/.package-lock.json" && ! -f "$slot_dir/.galley-lock-sha" ]]; then
  sha256sum "$slot_dir/package-lock.json" | cut -d' ' -f1 > "$slot_dir/.galley-lock-sha"
fi
[[ -f "$slot_dir/apps/server/dist/index.js" && -f "$slot_dir/apps/web/dist/index.html" ]] \
  || fail "$slot_dir is not built (run deploy.sh, or npm ci && npm run build there)"
say "live slot: $(basename "$slot_dir") (based on Aldine $(code_version "$slot_dir"))"

say "== configuration"
render() {  # template -> stdout
  local admin=${1//\\/\\\\}
  admin=${admin//&/\\&}
  sed -e "s#@ROOT@#$GALLEY_ROOT#g" -e "s#@BIN@#$GALLEY_BIN#g" \
      -e "s#@TEXLIVE@#$GALLEY_TEXLIVE#g" -e "s#@TEXBIN@#$GALLEY_TEXBIN#g" \
      -e "s#@APP_PORT@#$GALLEY_APP_PORT#g" -e "s#@COMPILER_PORT@#$GALLEY_COMPILER_PORT#g" \
      -e "s#@PUBLIC_URL@#$GALLEY_PUBLIC_URL#g" -e "s#@ADMIN_EMAILS@#$admin#g" "$2"
}
admin_file="$GALLEY_ROOT/admin-email"
admin_value="__SET_ME__put-your-address-in-galley-server-admin-email"
if [[ -r "$admin_file" ]]; then
  candidate="$(tr -d ' \t\r' < "$admin_file" | grep -v '^$' | paste -sd, -)"
  if [[ "$candidate" =~ ^[^@,#[:space:]]+@[^@,#[:space:]]+\.[^@,#[:space:]]+(,[^@,#[:space:]]+@[^@,#[:space:]]+\.[^@,#[:space:]]+)*$ ]]; then
    admin_value="$candidate"
    say "ALDINE_ADMIN_EMAILS: from $admin_file ($(tr ',' '\n' <<< "$candidate" | wc -l | tr -d ' ') address(es))"
  else
    warn "$admin_file does not hold a valid address list; ALDINE_ADMIN_EMAILS is a placeholder"
  fi
else
  warn "no $admin_file: ALDINE_ADMIN_EMAILS is a placeholder, nobody can approve accounts (see README)"
fi

app_env="$GALLEY_CONFIG/app.env"
secret_line="$(grep -E '^ALDINE_SIGNING_SECRET=.{43,}$' "$app_env" 2>/dev/null | tail -n 1 || true)"
if [[ -z "$secret_line" ]]; then
  secret_line="ALDINE_SIGNING_SECRET=$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')"
  say "ALDINE_SIGNING_SECRET: generated (64 characters, written to $app_env only)"
else
  say "ALDINE_SIGNING_SECRET: kept"
fi
token_before="$(compiler_token_line | sha256sum)"
if (( ROTATE )); then token_line="$(new_compiler_token_line)"; else token_line="$(compiler_token_line)"; fi
[[ -n "$token_line" ]] || token_line="$(new_compiler_token_line)"
token_note='# ---- generated once by setup.sh; the same line is in app.env and compiler.env (./setup.sh --rotate-compiler-token)'
{
  render "$admin_value" "$GALLEY_BIN/config/app.env.template"
  printf '\n# ---- generated once by setup.sh; rotating it expires PDF links and device cookies only\n%s\n' "$secret_line"
  printf '%s\n%s\n' "$token_note" "$token_line"
} > "$app_env.tmp"
unset secret_line
chmod 600 "$app_env.tmp"; mv "$app_env.tmp" "$app_env"
{
  render "" "$GALLEY_BIN/config/compiler.env.template"
  printf '\n%s\n%s\n' "$token_note" "$token_line"
} > "$GALLEY_CONFIG/compiler.env.tmp"
token_line=""
chmod 600 "$GALLEY_CONFIG/compiler.env.tmp"; mv "$GALLEY_CONFIG/compiler.env.tmp" "$GALLEY_CONFIG/compiler.env"
if [[ "$(compiler_token_line | sha256sum)" != "$token_before" ]]; then
  # A process still on the old value would refuse, or be refused by, the other.
  RESTART=1
  say "COMPILER_TOKEN: $( ((ROTATE)) && echo rotated || echo generated) (64 characters, in app.env and compiler.env only); galley-compiler and galley-app will restart"
else
  say "COMPILER_TOKEN: kept"
fi
ch="$GALLEY_ROOT/compiler-home"
mkdir -p "$ch/.config/fontconfig" "$ch/tmp" "$ch/texmf" "$ch/texmf-var" "$ch/texmf-config" "$ch/.cache" "$ch/par"
render "" "$GALLEY_BIN/config/fonts.conf.template" > "$ch/.config/fontconfig/fonts.conf"
mkdir -p "$ch/.config/luaotfload"
cp "$GALLEY_BIN/config/luaotfload.conf" "$ch/.config/luaotfload/luaotfload.conf"
chmod -R go-rwx "$ch"
say "wrote config/app.env, config/compiler.env, compiler-home/.config/{fontconfig/fonts.conf,luaotfload/luaotfload.conf}"

say "== latexindent Perl modules (user space)"
# latexindent (the editor's Format document) needs YAML::Tiny and
# File::HomeDir, which Ubuntu does not install by default. Both are pure
# Perl: take Ubuntu's own packages (apt-get download verifies them against
# the signed archive) and unpack them under opt/perl5. No root needed.
perl5="$GALLEY_ROOT/opt/perl5"
if PERL5LIB="$perl5" perl -MYAML::Tiny -MFile::HomeDir -e1 2>/dev/null; then
  say "present in $perl5"
else
  debs=$(mktemp -d "$GALLEY_ROOT/backups-staging/debs-XXXXXX")
  (cd "$debs" && apt-get download libyaml-tiny-perl libfile-homedir-perl libfile-which-perl >/dev/null 2>&1) \
    || fail "apt-get download of the latexindent Perl modules failed"
  for deb in "$debs"/*.deb; do dpkg-deb -x "$deb" "$debs/x"; done
  mkdir -p "$perl5"; cp -a "$debs/x/usr/share/perl5/." "$perl5/"
  rm -rf "$debs"
  PERL5LIB="$perl5" perl -MYAML::Tiny -MFile::HomeDir -e1 || fail "the unpacked Perl modules do not load"
  say "installed YAML::Tiny, File::HomeDir, File::Which into $perl5"
fi
chmod -R go-rwx "$GALLEY_ROOT/opt"

say "== AGPL source tarball"
if [[ ! -e "$GALLEY_ROOT/source/galley-source.tar.gz" ]]; then
  "$GALLEY_BIN/libexec/make-source-tarball.sh" "$slot_dir"
else
  say "present: $(served_source)"
fi

say "== PM2"
if [[ "$(pm2 --version 2>/dev/null | tail -n 1)" != "$PM2_VERSION" ]]; then
  npm install -g --no-audit --no-fund "pm2@$PM2_VERSION" >/dev/null
  say "installed pm2 $PM2_VERSION into $GALLEY_NODE_BIN"
fi
pm2 ping >/dev/null
if ! pm2_has pm2-logrotate; then
  pm2 install "pm2-logrotate@$LOGROTATE_VERSION" >/dev/null
fi
pm2 set pm2-logrotate:max_size 10M >/dev/null
pm2 set pm2-logrotate:retain 14 >/dev/null
pm2 set pm2-logrotate:compress true >/dev/null
pm2 set pm2-logrotate:rotateInterval '0 3 * * *' >/dev/null
say "pm2 $(pm2 --version | tail -n 1), pm2-logrotate (10M, keep 14, gzip)"

say "== compiler caches"
if [[ $WARM == 1 ]]; then "$GALLEY_BIN/libexec/warm-caches.sh" --force; else "$GALLEY_BIN/libexec/warm-caches.sh"; fi

say "== processes"
# The tunnel used to run in tmux session "galley-tunnel"; PM2 takes it over.
if tmux has-session -t galley-tunnel 2>/dev/null; then
  tmux kill-session -t galley-tunnel
  say "stopped the old tmux session galley-tunnel"
fi
for name in galley-compiler galley-app galley-tunnel; do
  if pm2_has "$name"; then
    if [[ $RESTART == 1 && $name != galley-tunnel ]]; then pm2 restart "$name" >/dev/null; say "$name restarted"; else say "$name already managed by PM2"; fi
  else
    pm2 start "$ECOSYSTEM" --only "$name" >/dev/null
    say "$name started"
  fi
done
wait_http_200 "http://127.0.0.1:$GALLEY_COMPILER_PORT/health" 60 || warn "compiler did not answer on :$GALLEY_COMPILER_PORT"
wait_http_200 "http://127.0.0.1:$GALLEY_APP_PORT/api/health" 90 || warn "app did not answer on :$GALLEY_APP_PORT"
pm2 save >/dev/null
say "pm2 save: done"

say "== crontab"
block="# >>> galley (managed by ~/galley-server/bin/setup.sh) >>>
@reboot $GALLEY_BIN/libexec/resurrect.sh >> $GALLEY_LOGS/cron.log 2>&1
30 3 * * * $GALLEY_BIN/backup-now.sh --quiet >> $GALLEY_LOGS/backup.log 2>&1
17 * * * * $GALLEY_BIN/libexec/tidy.sh >> $GALLEY_LOGS/cron.log 2>&1
# <<< galley <<<"
current="$(crontab -l 2>/dev/null || true)"
others="$(printf '%s\n' "$current" | sed '/^# >>> galley/,/^# <<< galley <<</d')"
{ [[ -n "${others//[[:space:]]/}" ]] && printf '%s\n' "$others"; printf '%s\n' "$block"; } | crontab -
say "installed (reboot resurrect, nightly backup 03:30, hourly tidy)"

say "== done"
"$GALLEY_BIN/status.sh" --brief || true
