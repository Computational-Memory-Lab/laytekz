#!/bin/bash
# End-to-end check without a Google login: start a THROWAWAY second instance
# (accounts off, its own data/meta/cache in a temp directory, 127.0.0.1:3050
# app + 127.0.0.1:3051 compiler, launched by the same run-app.sh /
# run-compiler.sh and sandbox as production, with its own COMPILER_TOKEN),
# then through its HTTP API: create a project, write a .tex file, typeset it,
# fetch the PDF and check it starts with %PDF; check that the compiler
# refuses requests without the token or with a wrong one, and that a main
# document whose name a shell would run is refused with a message saying
# what to rename. With --verify it also runs verify-compiler.sh against this
# instance's compiler. With --backup it also runs backup-now.sh and
# restore.sh --into --boot against that instance (the restore boots on 3060).
# Stops it and deletes the temp directory at the end (--keep leaves it).
#
# With --serve it runs no API checks (with --verify, verify-compiler.sh runs
# first, and a failure means no serving): once the instance answers, it
# prints a line starting with READY and keeps the instance up for a client on another
# machine (reach it through `ssh -N -L <port>:127.0.0.1:<app port> <your-server>`, so
# nothing new is exposed), until its stdin closes (the ssh session that
# started it ended), a line "stop" arrives, SIGTERM/SIGINT/SIGHUP, or SECONDS
# pass (default 3600). Then it stops and deletes the instance as usual. The
# desktop app's end-to-end collaboration test (desktop/tests/e2e-collab) uses
# this.
#
#   smoke-instance.sh [--verify] [--backup] [--keep]
#   smoke-instance.sh --serve[=SECONDS] [--verify] [--keep]
#   GALLEY_CODE=~/galley-server/<dir> smoke-instance.sh   test another built code tree
#   GALLEY_BIN=~/galley-server/<dir> <dir>/libexec/smoke-instance.sh   test a copy of this tooling
#   SMOKE_APP_PORT=3052 SMOKE_COMPILER_PORT=3053 smoke-instance.sh   other ports (never the live ones)
#   SMOKE_PUBLIC_URL=http://127.0.0.1:<port> smoke-instance.sh --serve
#       the loopback origin the client will use (the forwarded port); it becomes
#       the instance's ALDINE_PUBLIC_URL, so the Origin checks run as on the site
set -uo pipefail
# shellcheck source=../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

BACKUP=0 KEEP=0 VERIFY=0 SERVE=0 SERVE_SECS=3600
for a in "$@"; do case "$a" in
  --backup) BACKUP=1 ;; --keep) KEEP=1 ;; --verify) VERIFY=1 ;;
  --serve) SERVE=1 ;;
  --serve=*) SERVE=1; SERVE_SECS=${a#--serve=}; [[ "$SERVE_SECS" =~ ^[1-9][0-9]{0,4}$ ]] || fail "--serve=SECONDS takes 1 to 99999 seconds" ;;
  *) fail "unknown option $a" ;;
esac; done
(( SERVE && BACKUP )) && fail "--serve runs no API checks; leave out --backup"
APP=${SMOKE_APP_PORT:-3050} COMP=${SMOKE_COMPILER_PORT:-3051}
for p in "$APP" "$COMP"; do
  [[ "$p" =~ ^[1-9][0-9]{3,4}$ ]] && (( p >= 1024 && p <= 65535 )) || fail "port $p: use 1024 to 65535"
  [[ "$p" == "$GALLEY_APP_PORT" || "$p" == "$GALLEY_COMPILER_PORT" ]] && fail "port $p belongs to the live instance"
done
[[ "$APP" != "$COMP" ]] || fail "the app and the compiler need two ports"
PUBLIC_URL=${SMOKE_PUBLIC_URL:-}
[[ -z "$PUBLIC_URL" || "$PUBLIC_URL" =~ ^http://(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$ ]] \
  || fail "SMOKE_PUBLIC_URL must be http://127.0.0.1:<port> or http://localhost:<port>"
ports=("$APP" "$COMP"); (( BACKUP )) && ports+=(3060)
for p in "${ports[@]}"; do ss -tlnH | awk '{print $4}' | grep -q ":$p\$" && fail "port $p is in use"; done

root=$(mktemp -d "$GALLEY_ROOT/smoke-XXXXXX")
mkdir -p "$root"/{data,meta,cache,config,logs,backups}
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  sleep 1
  for p in "${pids[@]}"; do kill -9 "$p" 2>/dev/null; done
  (( KEEP )) || rm -rf "$root"
}
trap cleanup EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
fails=0
pass() { printf '  PASS  %s\n' "$*"; }
flunk() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }

# This instance's own compiler token: never the production one, never printed,
# never on a command line (curl reads it from a header file).
token=$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')
cat > "$root/config/app.env" <<EOF
HOST=127.0.0.1
PORT=$APP
COMPILER_URL=http://127.0.0.1:$COMP
COMPILE_DEADLINE_MS=90000
DATA_DIR=$root/data
META_DIR=$root/meta
CACHE_DIR=$root/cache
ALDINE_INSTANCE_NAME=Laytekz-smoke-test
LOG_LEVEL=warn
EOF
[[ -n "$PUBLIC_URL" ]] && printf 'ALDINE_PUBLIC_URL=%s\n' "$PUBLIC_URL" >> "$root/config/app.env"
# The production compiler env with this instance's port, data directory and
# token. HOME (the warmed font and biber caches) stays the production one.
# A tooling copy given as GALLEY_BIN (to test it before it replaces bin/)
# also supplies the sandbox and shims the compiler and TeX runs use.
bin_rewrite=(); [[ "$GALLEY_BIN" != "$GALLEY_ROOT/bin" ]] && bin_rewrite=(-e "s#$GALLEY_ROOT/bin#$GALLEY_BIN#g")
sed -e "s#^PORT=.*#PORT=$COMP#" -e "s#^DATA_DIR=.*#DATA_DIR=$root/data#" \
    -e "s#^GALLEY_SANDBOX_RW=[^:]*#GALLEY_SANDBOX_RW=$root/data#" \
    -e '/^COMPILER_TOKEN=/d' "${bin_rewrite[@]}" \
    "$GALLEY_CONFIG/compiler.env" > "$root/config/compiler.env"
printf 'COMPILER_TOKEN=%s\n' "$token" >> "$root/config/app.env"
printf 'COMPILER_TOKEN=%s\n' "$token" >> "$root/config/compiler.env"
printf 'x-compiler-token: %s\n' "$token" > "$root/config/token.header"
printf 'x-compiler-token: %s\n' "not-the-token-$RANDOM-$RANDOM-$RANDOM-$RANDOM" > "$root/config/wrong.header"
token=""
chmod 600 "$root/config/"*

echo "== start the throwaway instance in $root (code: $(readlink -f "$GALLEY_CODE"))"
GALLEY_COMPILER_ENV="$root/config/compiler.env" "$GALLEY_BIN/libexec/run-compiler.sh" > "$root/logs/compiler.log" 2>&1 & pids+=($!)
GALLEY_APP_ENV="$root/config/app.env" "$GALLEY_BIN/libexec/run-app.sh" > "$root/logs/app.log" 2>&1 & pids+=($!)
if wait_http_200 "http://127.0.0.1:$COMP/health" 60 && wait_http_200 "http://127.0.0.1:$APP/api/health" 90; then
  pass "app on 127.0.0.1:$APP and compiler on 127.0.0.1:$COMP answer /health"
else
  flunk "instance did not start"; tail -n 20 "$root/logs/"*.log; exit 1
fi
B="http://127.0.0.1:$APP"
C="http://127.0.0.1:$COMP"
me=$(curl -s "$B/api/auth/me")
[[ "$(jget authEnabled <<< "$me")" == false ]] && pass "accounts are off on the throwaway instance" || flunk "auth/me: $me"
grep -q 'auth=token' "$root/logs/compiler.log" && pass "the compiler started with a token required" || flunk "compiler startup line: $(grep listening "$root/logs/compiler.log")"

verify_compiler() {
  echo "== verify-compiler.sh against this instance"
  "$GALLEY_BIN/libexec/verify-compiler.sh" --port "$COMP" --env "$root/config/compiler.env" --meta "$root/meta" | sed 's/^/  | /'
  [[ ${PIPESTATUS[0]} == 0 ]] && pass "verify-compiler.sh: all checks passed" || flunk "verify-compiler.sh reported failures (above)"
}

if (( SERVE )); then
  (( VERIFY )) && verify_compiler
  (( fails )) && { echo "smoke-instance: not serving, $fails check(s) FAILED"; exit 1; }
  echo "== serving until stdin closes, a line \"stop\" arrives, a signal, or ${SERVE_SECS} s pass"
  echo "READY app=$B compiler=$C public=${PUBLIC_URL:-unset} root=$root"
  end=$((SECONDS + SERVE_SECS))
  while (( SECONDS < end )); do
    IFS= read -r -t 5 line; rc=$?
    if (( rc == 0 )); then
      [[ "$line" == stop ]] && break
    elif (( rc <= 128 )); then
      break  # end of input: whoever started this went away
    fi
    for p in "${pids[@]}"; do
      kill -0 "$p" 2>/dev/null || { flunk "a throwaway process exited while serving"; tail -n 20 "$root/logs/"*.log; exit 1; }
    done
  done
  echo "smoke-instance: stopping the served instance and deleting $root"
  exit 0
fi

echo "== project, file, typeset, PDF"
r=$(curl -s -H 'content-type: application/json' -d '{"name":"Laytekz smoke test","files":{}}' "$B/api/projects")
id=$(jget id <<< "$r")
[[ "$id" =~ ^[a-z0-9]{4,20}$ ]] && pass "POST /api/projects created project $id" || { flunk "create project: $r"; exit 1; }
tex='\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\title{Smoke test}
\begin{document}
\maketitle
Typeset through the app, the compiler and the sandbox \cite{knuth1984}.
\printbibliography
\end{document}
'
bib='@book{knuth1984, author = {Knuth, Donald E.}, title = {The TeXbook}, publisher = {Addison-Wesley}, year = {1984}}
'
put() {  # project path content -> HTTP status
  local body; body=$(node -e 'process.stdout.write(JSON.stringify({path:process.argv[1],content:process.argv[2]}))' "$2" "$3")
  curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d "$body" "$B/api/projects/$1/file"
}
for f in main.tex refs.bib; do
  content=$([[ $f == main.tex ]] && printf '%s' "$tex" || printf '%s' "$bib")
  code=$(put "$id" "$f" "$content")
  [[ "$code" == 200 ]] && pass "PUT /api/projects/$id/file $f -> 200" || flunk "PUT $f -> $code"
done
t0=$(date +%s%N)
r=$(curl -s -m 200 -H 'content-type: application/json' -d '{}' "$B/api/projects/$id/compile")
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
ok=$(jget ok <<< "$r"); url=$(jget pdfUrl <<< "$r")
[[ "$ok" == true && -n "$url" ]] && pass "POST /api/projects/$id/compile -> ok, ${ms} ms (the app sent its token)" || flunk "compile: $(head -c 800 <<< "$r")"
if [[ -n "$url" ]]; then
  curl -s -o "$root/out.pdf" "$B$url"
  if [[ "$(head -c 5 "$root/out.pdf")" == "%PDF-" ]]; then pass "GET pdfUrl -> $(stat -c %s "$root/out.pdf") bytes starting with %PDF-"; else flunk "PDF fetch: $(head -c 200 "$root/out.pdf")"; fi
fi
grep -q '"type":"error"' <<< "$(jget errors <<< "$r")" && flunk "the typeset reported errors" || pass "no typesetting errors reported"
git -C "$root/data/projects/$id" log --oneline -1 >/dev/null 2>&1 && pass "the project is a git repository with history ($(git -C "$root/data/projects/$id" rev-list --count HEAD) commit(s))" || flunk "no git history"

echo "== the compiler API needs the token"
creq="{\"projectDir\":\"projects/$id\",\"rootFile\":\"main.tex\"}"
code=$(http_status "$C/health"); [[ "$code" == 200 ]] && pass "GET /health without a token -> 200" || flunk "GET /health -> $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H 'content-type: application/json' -d "$creq" "$C/compile")
[[ "$code" == 401 ]] && pass "POST /compile without a token -> 401" || flunk "POST /compile without a token -> $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H @"$root/config/wrong.header" -H 'content-type: application/json' -d "$creq" "$C/compile")
[[ "$code" == 401 ]] && pass "POST /compile with a wrong token -> 401" || flunk "POST /compile with a wrong token -> $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$C/catalog")
[[ "$code" == 401 ]] && pass "GET /catalog without a token -> 401" || flunk "GET /catalog without a token -> $code"
r=$(curl -s -m 200 -H @"$root/config/token.header" -H 'content-type: application/json' -d "$creq" "$C/compile")
[[ "$(jget ok <<< "$r")" == true ]] && pass "POST /compile with the token -> ok" || flunk "POST /compile with the token: $(head -c 300 <<< "$r")"
pid=$(ss -tlnpH "sport = :$COMP" | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2)
if [[ -n "$pid" ]]; then
  ps -o args= -p "$pid" | grep -q 'COMPILER_TOKEN' && flunk "the compiler's command line names COMPILER_TOKEN" || pass "the compiler's command line holds no token"
  tr '\0' '\n' < "/proc/$pid/environ" | grep -q '^COMPILER_TOKEN=' && pass "the compiler process received COMPILER_TOKEN in its environment (owner-readable only)" || flunk "COMPILER_TOKEN missing from the compiler's start environment"
fi

echo "== main documents whose names a shell would run"
evil='p1`cd .aldine-out;touch PWNED`.tex'
body=$(node -e 'process.stdout.write(JSON.stringify({rootFile:process.argv[1]}))' "$evil")
r=$(curl -s -w ' HTTP %{http_code}' -X PATCH -H 'content-type: application/json' -d "$body" "$B/api/projects/$id")
[[ "$r" == *'HTTP 400' && "$r" == *backtick* ]] && pass "choosing it as the main document is refused: $(jget error <<< "${r% HTTP *}")" || flunk "PATCH rootFile: $r"
body=$(node -e 'process.stdout.write(JSON.stringify({name:"evil root",files:{[process.argv[1]]:process.argv[2]}}))' "$evil" '\documentclass{article}\begin{document}x\end{document}')
r=$(curl -s -H 'content-type: application/json' -d "$body" "$B/api/projects")
eid=$(jget id <<< "$r")
if [[ "$eid" =~ ^[a-z0-9]{4,20}$ ]]; then
  [[ "$(jget rootFile <<< "$r")" == "$evil" ]] && pass "a project made from such a file has it as its main document (as an older project may)" || flunk "rootFile: $(jget rootFile <<< "$r")"
  r=$(curl -s -m 60 -w ' HTTP %{http_code}' -H 'content-type: application/json' -d '{}' "$B/api/projects/$eid/compile")
  msg=$(jget error <<< "${r% HTTP *}")
  [[ "$r" == *'HTTP 400' && "$msg" == *"rename the file"* ]] && pass "its typeset is refused with what to rename: $msg" || flunk "compile of the evil root: $(head -c 400 <<< "$r")"
  sleep 1
  [[ -z "$(find "$root/data" -name 'PWNED*' -print -quit)" ]] && pass "the payload never ran (no PWNED marker anywhere)" || flunk "a PWNED marker exists"
  r=$(curl -s -m 30 -H @"$root/config/token.header" -H 'content-type: application/json' \
       -d "$(node -e 'process.stdout.write(JSON.stringify({projectDir:"projects/"+process.argv[1],rootFile:process.argv[2]}))' "$eid" "$evil")" "$C/compile")
  [[ "$(jget error <<< "$r")" == "invalid rootFile: it contains a backtick"* ]] && pass "the compiler itself refuses it too: $(jget error <<< "$r")" || flunk "compiler: $(head -c 300 <<< "$r")"
else
  flunk "create the evil-root project: $r"
fi

(( VERIFY )) && verify_compiler
grep -iE 'thumbnail|EACCES|sandbox|not starting' "$root/logs/compiler.log" "$root/logs/app.log" | head -n 5

if (( BACKUP )); then
  echo "== backup of the throwaway instance, then restore into a scratch directory"
  sleep 2
  GALLEY_ROOT="$root" GALLEY_BIN="$GALLEY_BIN" GALLEY_CODE="$GALLEY_CODE" GALLEY_BACKUP_DIR="$root/backups" \
    "$GALLEY_BIN/backup-now.sh" | sed 's/^/  | /'
  f=$(ls -1t "$root"/backups/galley-*.tar.gz 2>/dev/null | head -n 1)
  [[ -n "$f" ]] && pass "backup written: $(basename "$f")" || flunk "no backup written"
  if [[ -n "$f" ]]; then
    GALLEY_ROOT="$root" GALLEY_BIN="$GALLEY_BIN" GALLEY_CODE="$GALLEY_CODE" GALLEY_BACKUP_DIR="$root/backups" \
      "$GALLEY_BIN/restore.sh" latest --into "$root/restored" --boot | sed 's/^/  | /'
    [[ ${PIPESTATUS[0]} == 0 ]] && pass "restore into a scratch directory checked out and booted" || flunk "restore check failed"
    [[ -d "$root/restored/data/projects/$id/.git" ]] && pass "restored copy holds project $id with its git repository" || flunk "project missing from the restored copy"
  fi
fi

echo
if (( fails )); then echo "smoke-instance: $fails check(s) FAILED (logs in $root/logs; rerun with --keep to inspect)"; exit 1; fi
echo "smoke-instance: all checks passed; stopping the instance and deleting $root"
