#!/usr/bin/env bash
# Diagnostics for the plugin itself. Invoke with:
#   herdr plugin action invoke check --plugin phren
#   herdr plugin log list --plugin phren --limit 1
set -uo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

echo "plugin_root : ${HERDR_PLUGIN_ROOT:-<unset>}"
echo "config_dir  : ${HERDR_PLUGIN_CONFIG_DIR:-<unset>}"
echo "state_dir   : ${HERDR_PLUGIN_STATE_DIR:-<unset>}"
echo "action_id   : ${HERDR_PLUGIN_ACTION_ID:-<unset>}"
echo "cwd         : $PWD"
echo "caller_cwd  : $(caller_cwd)"
echo "caller_pane : $(caller_pane_id || echo '<unknown>')"
echo "store       : ${PHREN_PATH:-$HOME/.phren} ($([ -d "${PHREN_PATH:-$HOME/.phren}" ] && echo present || echo missing))"

if resolve_phren; then
  echo "phren       : ${PHREN_ARGV[*]}  [$PHREN_SOURCE]"
  echo "version     : $("${PHREN_ARGV[@]}" --version 2>&1 | head -n 1)"
else
  echo "phren       : NOT FOUND — run 'npx @phren/cli init' or set PHREN_BIN"
  exit 1
fi
