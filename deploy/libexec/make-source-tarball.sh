#!/bin/bash
# Build the AGPL "Corresponding Source" tarball of one code slot and make it
# the one the server offers (GALLEY_SOURCE_TARBALL, served at /source.tar.gz).
#
#   make-source-tarball.sh <slot dir>             build it and serve it
#   make-source-tarball.sh <slot dir> --no-serve  build only (deploy.sh serves it
#                                                 when it switches the code)
#
# The slot holds exactly what deploy.sh sent from the local tree (rsync with
# the repo's .gitignore rules, so no .env, .data*, .secrets*, node_modules) plus
# build output, which is left out here. Written as
# source/galley-source-<slot>.tar.gz (the file names are internal; inside, the
# top folder is laytekz-source/, and the server sends the download as
# laytekz-source.tar.gz); source/galley-source.tar.gz becomes a hard link to
# it (atomic rename); a rollback switches it back with the code.
set -euo pipefail
umask 077
# shellcheck source=../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

slot_dir=$(readlink -f "${1:?usage: make-source-tarball.sh <slot dir>}")
slot=$(basename "$slot_dir")
[[ -f "$slot_dir/package.json" ]] || fail "$slot_dir is not a code tree"
out_dir="$GALLEY_ROOT/source"
mkdir -p "$out_dir"
out="$out_dir/galley-source-$slot.tar.gz"

tar -C "$(dirname "$slot_dir")" \
  --exclude="$slot/node_modules" --exclude="$slot/apps/*/node_modules" \
  --exclude="$slot/apps/web/dist" --exclude="$slot/apps/server/dist" \
  --exclude="$slot/apps/server/assets/pdf-viewer.html" \
  --exclude="$slot/.galley-*" \
  --exclude='.env' --exclude='.env.*' --exclude='.secrets*' --exclude='.data*' \
  --sort=name --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' \
  --transform="s#^$slot#laytekz-source#" \
  -czf "$out.tmp" "$slot"
gzip -t "$out.tmp"
mv "$out.tmp" "$out"
if [[ "${2:-}" == --no-serve ]]; then
  say "source tarball: $out ($(du -h "$out" | cut -f1))"
  exit 0
fi
# A hard link, not a symlink: the file the server serves is a plain file
# whatever check the server applies, and replacing it is one atomic rename.
ln -f "$out" "$out_dir/galley-source.tar.gz.new"
mv -T "$out_dir/galley-source.tar.gz.new" "$out_dir/galley-source.tar.gz"
say "source tarball: $out ($(du -h "$out" | cut -f1)), now served as source/galley-source.tar.gz"
