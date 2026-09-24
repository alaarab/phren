#!/usr/bin/env bash
# Entry point for every phren pane this plugin opens.
set -uo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

view="${1:-dashboard}"

if ! resolve_phren; then
  hold_open "phren is not installed. Run:  npx @phren/cli init   (or point PHREN_BIN at your binary)"
  exit 127
fi

args=(shell --here)
case "$view" in
  dashboard) ;;
  tasks)     args+=(--view tasks) ;;
  findings)  args+=(--view findings) ;;
  review)    args+=(--view review) ;;
  *)         args+=(--view "$view") ;;
esac

# Not exec'd: a popup closes the instant its process ends, so a phren that
# fails to start — no store yet, a bad flag — would flash past unread.
"${PHREN_ARGV[@]}" "${args[@]}"
status=$?
if [ "$status" -ne 0 ]; then
  hold_open "phren exited with status $status. Store: ${PHREN_PATH:-$HOME/.phren}"
fi
exit "$status"
