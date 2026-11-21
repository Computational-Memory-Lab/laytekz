#!/bin/bash
# Fill the compiler's caches OUTSIDE the per-run sandbox, which only lets TeX
# runs read them (a run that could write them could plant files that other
# users' runs load):
#   - biber's self-extraction (PAR) cache: a cold extraction takes long enough
#     to time out a user's first biblatex compile;
#   - luaotfload's font-name database and font caches (compiler-home/texmf-var,
#     first in TEXMFCACHE per config/texmf/texmf.cnf);
#   - fontconfig's cache of TeX Live's fonts, for XeLaTeX.
# Runs with the compiler's own environment (compiler.env), so the caches land
# where the compiler looks. Skipped when the TeX Live installation has not
# changed since the last run, unless --force.
set -euo pipefail
umask 077
# shellcheck source=../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

ENV_FILE=${GALLEY_COMPILER_ENV:-$GALLEY_CONFIG/compiler.env}
home=$(env_get "$ENV_FILE" HOME)
stamp_file="$home/.warm-stamp"
stamp="$(stat -c %Y "$GALLEY_TEXLIVE/tlpkg/texlive.tlpdb" 2>/dev/null)-$(sha256sum "$GALLEY_BIN/config/fonts.conf.template" "$GALLEY_BIN/config/texmf/texmf.cnf" | sha256sum | cut -c1-16)"
if [[ "${1:-}" != --force && -f "$stamp_file" && "$(cat "$stamp_file")" == "$stamp" ]]; then
  say "caches are current (TeX Live unchanged since the last warm-up)"
  exit 0
fi

vars=()
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in ''|'#'*) continue ;; esac
  # Not the API token: TeX tools never need it, and `env -i` puts every
  # variable on its command line.
  [[ "$line" == COMPILER_TOKEN=* ]] && continue
  [[ "$line" == *=* ]] && vars+=("$line")
done < "$ENV_FILE"
# The real binaries, not the sandbox shims.
vars+=("PATH=$GALLEY_TEXBIN:/usr/bin:/bin")
cenv() { env -i "${vars[@]}" "$@"; }

work=$(mktemp -d "$home/tmp/warm-XXXXXX")
trap 'rm -rf "$work"' EXIT
cd "$work"

t0=$SECONDS
cenv biber --version >/dev/null
say "biber cache: ready ($((SECONDS - t0)) s)"

t0=$SECONDS
cenv luaotfload-tool --update >/dev/null 2>&1 || warn "luaotfload-tool --update failed"
cat > lua.tex <<'TEX'
\documentclass{article}
\usepackage{fontspec}
\setmainfont{TeX Gyre Termes}
\setsansfont{TeX Gyre Heros}
\setmonofont{Latin Modern Mono}
\begin{document}
Warm \textsf{caches} \texttt{now}. \textbf{Bold} \emph{italic}.
\end{document}
TEX
cenv lualatex -interaction=nonstopmode -halt-on-error lua.tex >/dev/null 2>&1 || warn "lualatex warm-up failed (see $work/lua.log)"
# Popular OpenType families: cached once here instead of on every LuaLaTeX
# run that uses them (a TeX run's own font cache lasts one run).
for font in "Libertinus Serif" "Libertinus Sans" "Libertinus Math" "Latin Modern Math" \
            "Source Serif 4" "Source Sans 3" "Source Code Pro" "Fira Sans" "Fira Mono" \
            "EB Garamond" "STIX Two Text" "STIX Two Math" "TeX Gyre Pagella" "TeX Gyre Bonum" \
            "TeX Gyre Schola" "TeX Gyre Cursor" "Noto Serif" "Noto Sans" "Noto Sans Mono" \
            "Linux Libertine O" "Linux Biolinum O" "Inconsolatazi4" "Roboto" "Lato" "Open Sans"; do
  printf '%s\n' '\documentclass{article}' '\usepackage{fontspec}' "\\setmainfont{$font}" \
    '\begin{document}' 'Aa \textbf{Bb} \emph{Cc} \textbf{\emph{Dd}}' '\end{document}' > font.tex
  cenv lualatex -interaction=nonstopmode font.tex >/dev/null 2>&1 || say "   (font not available: $font)"
done
say "luaotfload caches: ready ($((SECONDS - t0)) s)"

t0=$SECONDS
cp lua.tex xe.tex
cenv xelatex -interaction=nonstopmode -halt-on-error xe.tex >/dev/null 2>&1 || warn "xelatex warm-up failed (see $work/xe.log)"
say "fontconfig cache: ready ($((SECONDS - t0)) s)"

printf '%s\n' "$stamp" > "$stamp_file"
