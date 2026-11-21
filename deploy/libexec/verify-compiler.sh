#!/bin/bash
# Prove, through the running compiler's HTTP API, that TeX is confined and
# that legitimate documents still compile:
#   1. pdfLaTeX cannot \input or \openin a canary file outside the project
#   2. LuaLaTeX's Lua io.open cannot read the canary, aldine.db, the app's
#      env file, the app's /proc/<pid>/environ, or another project's files
#   3. \write18 and Lua os.execute/io.popen cannot run arbitrary commands
#      (the restricted whitelist still works: kpsewhich)
#   4. an apa7 + biblatex/biber paper compiles to a valid PDF with SyncTeX,
#      and a SyncTeX lookup answers; XeLaTeX and LuaLaTeX with fontspec work;
#      the precompiled preamble gets built and used; latexindent formats
#   0. (first) the API refuses every route but /health without COMPILER_TOKEN
#   5. the compile path: a root file name that a shell would run is refused
#      before latexmk sees it, an oversized body gets 413, a project directory
#      beside DATA_DIR is refused, a typeset that never ends stops at its time
#      budget and says so, and no TeX run sees COMPILER_TOKEN
#
#   verify-compiler.sh [--port 3041] [--env FILE] [--data DIR] [--meta DIR] [--keep]
# --env: the compiler's env file (default config/compiler.env), for DATA_DIR,
# HOME and the token. Uses two throwaway project directories
# (DATA_DIR/projects/zzverify*) and a canary file in META_DIR, all removed
# afterwards (--keep leaves them). The token is read from the env file into a
# header file in a private directory, never put on a command line or printed.
set -uo pipefail
# shellcheck source=../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

PORT=$GALLEY_COMPILER_PORT
CENV_FILE=$GALLEY_CONFIG/compiler.env
DATA="" META=""
KEEP=0
while (( $# )); do
  case "$1" in
    --port) PORT=$2; shift ;;
    --env) CENV_FILE=$2; shift ;;
    --data) DATA=$2; shift ;;
    --meta) META=$2; shift ;;
    --keep) KEEP=1 ;;
    *) fail "unknown option $1" ;;
  esac
  shift
done
[[ -n "$DATA" ]] || DATA=$(env_get "$CENV_FILE" DATA_DIR)
[[ -n "$META" ]] || META=$(env_get "$GALLEY_CONFIG/app.env" META_DIR)
URL="http://127.0.0.1:$PORT"
[[ "$(http_status "$URL/health")" == 200 ]] || fail "no compiler answering at $URL"
priv=$(mktemp -d "$GALLEY_ROOT/.verify-XXXXXX")
HDR="$priv/token.header"
# The token goes from the env file into a header file without ever being a
# command-line argument (sed -n prints into the redirect, not to a terminal).
sed -n 's/^COMPILER_TOKEN=\(.*\)$/x-compiler-token: \1/p' "$CENV_FILE" | tail -n 1 > "$HDR"
printf 'x-compiler-token: wrong-%s%s%s%s\n' $RANDOM $RANDOM $RANDOM $RANDOM > "$priv/wrong.header"

id=$(printf '%04x%04x' $RANDOM $RANDOM)
P="projects/zzverify$id"; Q="projects/zzverifyother$id"
PD="$DATA/$P"; QD="$DATA/$Q"
CANARY="$META/zz-galley-canary-$id.txt"
token="CANARY$(printf '%08d' $((RANDOM * RANDOM)))"
other_token="OTHERPROJECT$(printf '%08d' $((RANDOM * RANDOM)))"
mkdir -p "$PD" "$QD"
# Real projects are git repositories; the sandbox treats .git specially.
git -C "$PD" init -q && git -C "$QD" init -q
printf '%s\n' "$token" > "$CANARY"
printf '%s\n' "$other_token" > "$QD/private.txt"
cleanup() { rm -rf "$priv"; (( KEEP )) || rm -rf "$PD" "$QD" "$CANARY" "$META/zz-pwned-$id"; }
trap cleanup EXIT
app_pid=$(pm2_states | awk '$1 == "galley-app" { print $4 }')
[[ -n "$app_pid" && "$app_pid" != 0 ]] || app_pid=1

fails=0
pass() { printf '  PASS  %s\n' "$*"; }
flunk() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }

ccurl() { curl -s -H @"$HDR" -H 'content-type: application/json' "$@"; }
compile() {  # projectDir rootFile engine -> JSON on stdout
  ccurl -m 200 -d "{\"projectDir\":\"$1\",\"rootFile\":\"$2\",\"engine\":\"$3\"}" "$URL/compile"
}
jsonbody() {  # key value [key value ...] -> a JSON object of strings
  node -e 'const a=process.argv.slice(1),o={};for(let i=0;i<a.length;i+=2)o[a[i]]=a[i+1];process.stdout.write(JSON.stringify(o))' "$@"
}

echo "== 0. access: every route but /health needs COMPILER_TOKEN"
if [[ -s "$HDR" ]]; then
  pass "COMPILER_TOKEN is set in $(basename "$CENV_FILE")"
else
  flunk "COMPILER_TOKEN is not set in $CENV_FILE (run setup.sh)"
fi
req="{\"projectDir\":\"$P\",\"rootFile\":\"main.tex\"}"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H 'content-type: application/json' -d "$req" "$URL/compile")
[[ "$code" == 401 ]] && pass "POST /compile without a token: refused (401)" || flunk "POST /compile without a token answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H @"$priv/wrong.header" -H 'content-type: application/json' -d "$req" "$URL/compile")
[[ "$code" == 401 ]] && pass "POST /compile with a wrong token: refused (401)" || flunk "POST /compile with a wrong token answered $code"
for r in 'GET /catalog' 'POST /stop' 'POST /synctex' 'POST /format'; do
  m=${r% *} route=${r#* }
  if [[ $m == GET ]]; then code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$URL$route")
  else code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H 'content-type: application/json' -d '{}' "$URL$route"); fi
  [[ "$code" == 401 ]] && pass "$r without a token: refused (401)" || flunk "$r without a token answered $code"
done
cpid=$(ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2)
[[ -n "$cpid" ]] || cpid=1
field() {  # json key
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=j[process.argv[1]];process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))})' "$2" <<< "$1"
}

echo "== 1. pdfLaTeX: reading outside the project"
# openin_any=p does NOT stop \openin or \input of absolute or ../ paths on
# TeX Live 2026 (verified with plain tex); Landlock does. The open then fails
# with EACCES, which kpathsea treats as fatal: the run stops right there.
leak_pdf() {  # name, body line
  printf '%s\n' '\documentclass{article}' '\newread\galleyread' '\begin{document}' "$2" 'x' '\end{document}' > "$PD/$1.tex"
  local r; r=$(compile "$P" "$1.tex" pdf)
  local text; text="$(field "$r" log)$(field "$r" latexmkOutput)$(cat "$PD"/.aldine-out/"$1".* 2>/dev/null)"
  if grep -q "$token" <<< "$text"; then flunk "$3: the canary was READ"
  elif grep -q "OPENIN:BLOCKED\|Permission denied\|not found" <<< "$text"; then pass "$3: refused ($(grep -o 'OPENIN:BLOCKED\|Permission denied\|not found' <<< "$text" | head -n 1))"
  else flunk "$3: no evidence either way"; fi
}
leak_pdf open-abs "\\openin\\galleyread=$CANARY \\ifeof\\galleyread \\typeout{OPENIN:BLOCKED}\\else \\read\\galleyread to\\cl \\typeout{OPENIN:READ:\\cl}\\fi" "\\openin of the canary by absolute path"
leak_pdf open-rel "\\openin\\galleyread=../../../meta/$(basename "$CANARY") \\ifeof\\galleyread \\typeout{OPENIN:BLOCKED}\\else \\read\\galleyread to\\cl \\typeout{OPENIN:READ:\\cl}\\fi" "\\openin of the canary by ../../../meta/..."
leak_pdf input-abs "\\input{$CANARY}" "\\input of the canary by absolute path"
leak_pdf input-db "\\input{$META/aldine.db}" "\\input of META_DIR/aldine.db"

echo "== 2. LuaLaTeX: Lua io.open (ignores openin_any; Landlock must stop it)"
cat > "$PD/leak-lua.tex" <<TEX
\\documentclass{article}
\\begin{document}
\\directlua{
local function try(label, path)
  local f = io.open(path, "r")
  if f then local s = f:read(200) or "" f:close() texio.write_nl("term and log", "LUA-" .. label .. ":READ:" .. string.gsub(s, "[^A-Za-z0-9]", "."))
  else texio.write_nl("term and log", "LUA-" .. label .. ":BLOCKED") end
end
try("CANARY", "$CANARY")
try("DB", "$META/aldine.db")
try("APPENV", "$GALLEY_CONFIG/app.env")
try("GOOGLE", "$GALLEY_ROOT/secrets/google-oauth.env")
try("ENVIRON", "/proc/$app_pid/environ")
try("COMPILERENV", "/proc/$cpid/environ")
try("OTHERPROJECT", "$QD/private.txt")
try("SSHDIR", "$HOME/.ssh/authorized_keys")
local ok = pcall(function() for e in lfs.dir("$DATA/projects") do end end)
texio.write_nl("term and log", "LUA-LISTPROJECTS:" .. (ok and "LISTED" or "BLOCKED"))
texio.write_nl("term and log", "LUA-TOKENENV:" .. (os.getenv("COMPILER_TOKEN") and "PRESENT" or "ABSENT"))
local lim = io.open("/proc/self/limits") local st = io.open("/proc/self/status")
for l in lim:lines() do if l:find("address space", 1, true) or l:find("file size", 1, true) or l:find("Max nice", 1, true) then texio.write_nl("term and log", "LIMIT:" .. string.gsub(l, " +", " ")) end end
for l in st:lines() do if l:find("Seccomp:", 1, true) or l:find("NoNewPrivs:", 1, true) then texio.write_nl("term and log", "STATUS:" .. string.gsub(l, "[ \\string\t]+", " ")) end end
}
x
\\end{document}
TEX
r=$(compile "$P" leak-lua.tex lualatex); log=$(field "$r" log)
for k in CANARY DB APPENV GOOGLE ENVIRON COMPILERENV OTHERPROJECT SSHDIR; do
  if grep -q "LUA-$k:BLOCKED" <<< "$log"; then pass "io.open $k: refused"
  elif grep -q "LUA-$k:READ" <<< "$log"; then flunk "io.open $k: READ"
  else flunk "io.open $k: no result in the log"; fi
done
grep -q 'LUA-LISTPROJECTS:BLOCKED' <<< "$log" && pass "lfs.dir of DATA_DIR/projects: refused" || flunk "lfs.dir of DATA_DIR/projects"
grep -q 'LUA-TOKENENV:ABSENT' <<< "$log" && pass "os.getenv(\"COMPILER_TOKEN\") in a TeX run: not set" || flunk "COMPILER_TOKEN in a TeX run's environment: $(grep -o 'LUA-TOKENENV:[A-Z]*' <<< "$log")"
grep -E '^(LIMIT|STATUS):' <<< "$log" | sed 's/^/        /'
grep -q "$token\|$other_token" <<< "$log" && flunk "a canary token leaked into the log" || pass "neither canary token appears in the log"

echo "== 2b. the sandbox itself, with plain programs (stand-ins for native code in a TeX run)"
# /bin/sh and python3 have no TeX file-name checks; they run under exactly
# the per-run rules a compile gets, from inside the project.
# Not COMPILER_TOKEN: every variable here becomes an argument of env.
cenv=$(grep -v '^#' "$CENV_FILE" | grep = | grep -v '^COMPILER_TOKEN=')
sb() { (cd "$PD" && env -i $cenv /usr/bin/python3 -I "$GALLEY_BIN/libexec/galley-sandbox.py" run -- "$@" 2>&1); }
probe() {  # label expect(ALLOWED|REFUSED) shell-command
  local out; out=$(sb /bin/sh -c "$3 && echo RESULT:ALLOWED || echo RESULT:REFUSED")
  if grep -q "RESULT:$2" <<< "$out"; then pass "$1: $(tr '[:upper:]' '[:lower:]' <<< "$2")"; else flunk "$1: expected $2, got $(tail -n 1 <<< "$out")"; fi
}
probe "append to the project's .git/config" REFUSED 'echo "[core]" >> .git/config'
probe "create .git/hooks/post-commit" REFUSED 'echo x > .git/hooks/post-commit'
probe "rename .aldine-out/x over .git/config" REFUSED 'echo x > .aldine-out/x && mv .aldine-out/x .git/config'
probe "create a file in the project root" REFUSED 'echo x > new-root-file.txt'
probe "symlink inside .aldine-out" REFUSED 'ln -s /etc/passwd .aldine-out/link'
probe "write into .aldine-out" ALLOWED 'echo x > .aldine-out/scratch.txt'
probe "read the canary in META_DIR" REFUSED "cat '$CANARY' >/dev/null"
probe "read another project's file" REFUSED "cat '$QD/private.txt' >/dev/null"
probe "write the compiler's shared caches" REFUSED "echo x > '$(env_get "$CENV_FILE" HOME)/.cache/zz-$id'"
probe "write TeX Live" REFUSED "echo x > '$GALLEY_TEXLIVE/zz-$id'"
out=$(sb /usr/bin/python3 -I -c 'import socket
try:
    socket.socket(socket.AF_UNIX); print("SOCKET:ALLOWED")
except OSError as e: print("SOCKET:REFUSED", e)')
grep -q 'SOCKET:REFUSED' <<< "$out" && pass "socket() (unix and TCP, e.g. PM2's control socket): refused" || flunk "socket(): $out"
out=$(sb kpsewhich -var-value=TEXMFVAR)
[[ "$out" == *"/run-"*"/texmf-var" ]] && pass "TeX runs get a private TEXMFVAR (.../$(basename "$(dirname "$out")")/texmf-var)" || flunk "TEXMFVAR: $out"
rm -f "$PD/.aldine-out/scratch.txt" "$PD/.aldine-out/x"

echo "== 3. shell escape"
cat > "$PD/shell.tex" <<TEX
\\documentclass{article}
\\begin{document}
\\immediate\\write18{touch pwned-write18.txt}
\\immediate\\write18{touch $META/zz-pwned-$id}
\\immediate\\write18{kpsewhich article.cls}
x
\\end{document}
TEX
r=$(compile "$P" shell.tex pdf); log=$(field "$r" log)
cat > "$PD/shell-lua.tex" <<TEX
\\documentclass{article}
\\begin{document}
\\directlua{
os.execute("touch pwned-lua.txt")
local p = io.popen("id") if p then texio.write_nl("term and log", "POPEN:" .. (p:read("*a") or "")) p:close() else texio.write_nl("term and log", "POPEN:REFUSED") end
}
x
\\end{document}
TEX
r=$(compile "$P" shell-lua.tex lualatex); log="$log$(field "$r" log)"
[[ ! -e "$PD/pwned-write18.txt" && ! -e "$PD/.aldine-out/pwned-write18.txt" ]] && pass "\\write18{touch ...} did not run" || flunk "\\write18 ran"
[[ ! -e "$META/zz-pwned-$id" ]] && pass "\\write18 writing into META_DIR did not run" || flunk "\\write18 wrote into META_DIR"
[[ ! -e "$PD/pwned-lua.txt" ]] && pass "Lua os.execute did not run" || flunk "os.execute ran"
grep -q 'uid=' <<< "$log" && flunk "io.popen(\"id\") ran" || pass "Lua io.popen(\"id\") did not run"
grep -o 'runsystem([^)]*)\.\.\.[a-z ()]*' <<< "$log" | sed 's/^/        /'
grep -q 'kpsewhich article.cls)...executed safely (allowed)' <<< "$log" && pass "restricted mode is on (whitelisted kpsewhich still runs)" || flunk "restricted whitelist did not run kpsewhich"

echo "== 4. legitimate documents"
cat > "$PD/refs.bib" <<'BIB'
@book{knuth1984, author = {Knuth, Donald E.}, title = {The {TeX}book}, publisher = {Addison-Wesley}, year = {1984}, address = {Reading, MA}}
@book{lamport1994, author = {Lamport, Leslie}, title = {{LaTeX}: A Document Preparation System}, edition = {2}, publisher = {Addison-Wesley}, year = {1994}}
@article{apa2020, author = {{American Psychological Association}}, title = {Publication manual of the {American Psychological Association}}, journal = {APA}, year = {2020}, doi = {10.1037/0000165-000}}
BIB
cat > "$PD/main.tex" <<'TEX'
\documentclass[stu,12pt,floatsintext]{apa7}
\usepackage[american]{babel}
\usepackage{csquotes}
\usepackage[style=apa,sortcites=true,sorting=nyt,backend=biber]{biblatex}
\DeclareLanguageMapping{american}{american-apa}
\addbibresource{refs.bib}
\title{A Laytekz Verification Paper}
\authorsnames{A. Tester}
\authorsaffiliations{Laytekz}
\course{TEST 101}
\professor{Dr. Example}
\duedate{November 20, 2026}
\abstract{This paper checks that the compiler still typesets real work.}
\begin{document}
\maketitle
TeX was described by \textcite{knuth1984}, and LaTeX by \textcite{lamport1994}.
Style follows the manual \parencite{apa2020}.
\printbibliography
\end{document}
TEX
t0=$(date +%s%N)
r=$(compile "$P" main.tex pdf); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
ok=$(field "$r" ok); pdf=$(field "$r" pdf); syn=$(field "$r" synctex)
if [[ "$ok" == true && -f "$PD/$pdf" && "$(head -c 5 "$PD/$pdf")" == "%PDF-" ]]; then
  pass "apa7 + biblatex/biber (pdfLaTeX): ok, $pdf starts with %PDF-, $(stat -c %s "$PD/$pdf") bytes, ${ms} ms"
else
  flunk "apa7 compile: ok=$ok pdf=$pdf errors=$(field "$r" errors | head -c 600)"
fi
[[ -f "$PD/.aldine-out/main.bbl" ]] && grep -q 'knuth1984' "$PD/.aldine-out/main.bbl" && pass "biber wrote the bibliography (main.bbl)" || flunk "no main.bbl from biber"
grep -q 'Citation .* undefined\|There were undefined references' "$PD/.aldine-out/main.log" && flunk "undefined citations remain" || pass "all citations resolved"
[[ "$syn" == *synctex.gz && -s "$PD/$syn" ]] && pass "SyncTeX file written ($syn)" || flunk "no SyncTeX file"
s=$(ccurl -m 30 -d "{\"projectDir\":\"$P\",\"rootFile\":\"main.tex\",\"direction\":\"forward\",\"line\":15,\"column\":0,\"file\":\"main.tex\"}" "$URL/synctex")
[[ "$(field "$s" records)" == *'"page":'* ]] && pass "SyncTeX forward lookup (main.tex:15) -> $(field "$s" records | head -c 80)..." || flunk "SyncTeX lookup: $s"

r=$(compile "$P" main.tex pdf); pc1=$(field "$r" preambleCache)
for _ in $(seq 1 45); do [[ -f "$PD/.aldine-out/fmt/main/main.fmt" ]] && break; sleep 1; done
touch "$PD/main.tex"; r=$(compile "$P" main.tex pdf); pc2=$(field "$r" preambleCache)
[[ "$pc2" == hit && "$(field "$r" ok)" == true ]] && pass "precompiled preamble built in the background and used (cache: $pc1 -> $pc2)" || flunk "preamble cache: $pc1 -> $pc2"

cat > "$PD/xe.tex" <<'TEX'
\documentclass{article}
\usepackage{fontspec}
\setmainfont{TeX Gyre Pagella}
\begin{document}
XeLaTeX with a TeX Live font found by name through fontconfig.
\end{document}
TEX
t0=$(date +%s%N); r=$(compile "$P" xe.tex xelatex); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
[[ "$(field "$r" ok)" == true ]] && pass "XeLaTeX + fontspec (TeX Gyre Pagella by name): ok, ${ms} ms" || flunk "XeLaTeX: $(field "$r" errors | head -c 400)"
cat > "$PD/lua.tex" <<'TEX'
\documentclass{article}
\usepackage{fontspec}
\setmainfont{TeX Gyre Termes}
\begin{document}
LuaLaTeX with fontspec and luaotfload.
\end{document}
TEX
t0=$(date +%s%N); r=$(compile "$P" lua.tex lualatex); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
[[ "$(field "$r" ok)" == true ]] && pass "LuaLaTeX + fontspec (TeX Gyre Termes): ok, ${ms} ms" || flunk "LuaLaTeX: $(field "$r" errors | head -c 400)"

f=$(ccurl -m 30 -d '{"text":"\\begin{itemize}\n\\item a\n\\end{itemize}\n"}' "$URL/format")
[[ "$(field "$f" ok)" == true ]] && pass "latexindent formats (POST /format)" || flunk "latexindent: $f"

echo "== 5. the compile path"
# Each payload only ever tries to create a marker file in the project.
for evil in 'p1`cd .aldine-out;touch PWNED-P1`.tex' 'p2$(touch PWNED-P2).tex' 'sub`cd .aldine-out;touch PWNED-P3`dir/main.tex'; do
  mkdir -p "$PD/$(dirname "$evil")"
  printf '%s\n' '\documentclass{article}' '\begin{document}' 'x' '\end{document}' > "$PD/$evil"
  r=$(ccurl -m 60 -w ' HTTP %{http_code}' -d "$(jsonbody projectDir "$P" rootFile "$evil" engine pdf)" "$URL/compile")
  if [[ "$r" == *'HTTP 400' && "$r" == *'invalid rootFile'* ]]; then pass "root file name $evil: refused ($(field "${r% HTTP *}" error))"
  else flunk "root file name $evil: $(head -c 300 <<< "$r")"; fi
done
sleep 1
[[ -z "$(find "$PD" -name 'PWNED*' -print -quit)" ]] && pass "no payload ran (no PWNED marker in the project)" || flunk "a PWNED marker exists: $(find "$PD" -name 'PWNED*')"
code=$(head -c 100000 /dev/zero | tr '\0' x | sed 's/^/{"pad":"/; s/$/"}/' | ccurl -o /dev/null -w '%{http_code}' -m 30 --data-binary @- "$URL/compile")
[[ "$code" == 413 ]] && pass "a 100 KB request body: refused (413)" || flunk "a 100 KB request body answered $code"
r=$(ccurl -m 30 -d "$(jsonbody projectDir "${DATA%/}-zzsibling/projects/x" rootFile main.tex)" "$URL/compile")
[[ "$(field "$r" error)" == *'escapes DATA_DIR'* ]] && pass "a project directory beside DATA_DIR sharing its prefix: refused" || flunk "sibling projectDir: $(head -c 300 <<< "$r")"
printf '%s\n' '\documentclass{article}' '\def\loopforever{\loopforever}' '\begin{document}' '\loopforever' '\end{document}' > "$PD/loop.tex"
t0=$(date +%s)
r=$(ccurl -m 60 -d "{\"projectDir\":\"$P\",\"rootFile\":\"loop.tex\",\"engine\":\"pdf\",\"timeoutMs\":5000}" "$URL/compile")
took=$(( $(date +%s) - t0 ))
if [[ "$(field "$r" timedOut)" == true && "$(field "$r" errors)" == *'Typesetting was stopped after 5 s'* && $took -lt 20 ]]; then
  pass "a document that never ends: stopped at its 5 s budget and reported (answer after ${took} s)"
else
  flunk "endless document: timedOut=$(field "$r" timedOut) after ${took} s, errors=$(field "$r" errors | head -c 300)"
fi
sleep 1
left=0
for p in $(pgrep -u "$(id -u)" -f 'pdflatex|latexmk' 2>/dev/null); do
  [[ "$(readlink "/proc/$p/cwd" 2>/dev/null)" == "$PD"* ]] && left=$((left + 1))
done
(( left == 0 )) && pass "no TeX process of that typeset is left running" || flunk "$left TeX process(es) of the endless document still run"

echo
if (( fails )); then echo "verify-compiler: $fails check(s) FAILED"; exit 1; fi
echo "verify-compiler: all checks passed"
