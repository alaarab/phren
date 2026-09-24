#!/usr/bin/env bash
# Bound to a key: open one of this plugin's panes against the pane the user is
# actually in. Actions run detached, so this only asks Herdr to open the pane.
set -uo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

entrypoint="${1:-dashboard}"
herdr="${HERDR_BIN_PATH:-herdr}"

args=(plugin pane open --plugin phren --entrypoint "$entrypoint" --focus)

cwd="$(caller_cwd)"
[ -n "$cwd" ] && args+=(--cwd "$cwd")

# split panes need something to split; popups and overlays target the active
# pane on their own.
case "$entrypoint" in
  dock|web)
    pane="$(caller_pane_id || true)"
    [ -n "$pane" ] && args+=(--target-pane "$pane")
    # The dashboard wants a column; the web UI is just a server log, so it gets
    # a strip along the bottom instead.
    [ "$entrypoint" = "web" ] && args+=(--direction down) || args+=(--direction right)
    ;;
esac

exec "$herdr" "${args[@]}"
