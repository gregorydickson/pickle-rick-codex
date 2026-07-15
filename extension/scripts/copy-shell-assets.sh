#!/usr/bin/env bash
# tsc does not emit .sh files, so the build stages non-.ts runtime shell assets
# from src/scripts/ into the compiled bin/. src/scripts/ is the single source of
# truth; bin/*.sh is generated (and gitignored) so it can never drift from source.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_SCRIPTS="$EXT_ROOT/src/scripts"
BIN_DIR="$EXT_ROOT/bin"

mkdir -p "$BIN_DIR"

shopt -s nullglob
for asset in "$SRC_SCRIPTS"/*.sh; do
  cp "$asset" "$BIN_DIR/"
  chmod +x "$BIN_DIR/$(basename "$asset")"
done
shopt -u nullglob
