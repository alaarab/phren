#!/usr/bin/env bash
# Run the phren web UI (the 3D memory graph) for as long as this pane lives.
set -uo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if ! resolve_phren; then
  hold_open "phren is not installed. Run:  npx @phren/cli init   (or point PHREN_BIN at your binary)"
  exit 1
fi

printf '  phren web-ui — close this pane to stop the server\n\n'
exec "${PHREN_ARGV[@]}" web-ui "$@"
