#!/bin/sh
# PATH shim for one TeX tool (the compiler's PATH starts with this directory).
# It runs the real tool from TeX Live inside galley-sandbox's per-project
# Landlock + seccomp layer. Symlinked as shims/<tool>.
exec /usr/bin/python3 -I "$(dirname "$0")/../galley-sandbox.py" tool "$(basename "$0")" "$@"
