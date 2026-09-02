# Shared helpers for the phren Herdr plugin. Sourced, never executed.
# shellcheck shell=bash

# Herdr hands plugin commands their context two ways: HERDR_ACTIVE_* env vars on
# the keybinding path, and HERDR_PLUGIN_CONTEXT_JSON everywhere. Read a flat
# string field out of the JSON without depending on jq being installed.
plugin_context_field() {
  [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ] || return 1
  local value
  value=$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

# The directory the phren shell should treat as "here".
caller_cwd() {
  if [ -n "${HERDR_ACTIVE_PANE_CWD:-}" ]; then printf '%s\n' "$HERDR_ACTIVE_PANE_CWD"; return 0; fi
  plugin_context_field focused_pane_cwd && return 0
  plugin_context_field workspace_cwd && return 0
  printf '%s\n' "$PWD"
}

caller_pane_id() {
  if [ -n "${HERDR_ACTIVE_PANE_ID:-}" ]; then printf '%s\n' "$HERDR_ACTIVE_PANE_ID"; return 0; fi
  plugin_context_field focused_pane_id
}

# PHREN_ARGV is the argv prefix that runs phren, resolved once per process.
PHREN_ARGV=()
PHREN_SOURCE=""

resolve_phren() {
  if [ -n "${PHREN_BIN:-}" ]; then
    PHREN_ARGV=("$PHREN_BIN"); PHREN_SOURCE="PHREN_BIN"; return 0
  fi
  if command -v phren >/dev/null 2>&1; then
    PHREN_ARGV=(phren); PHREN_SOURCE="PATH ($(command -v phren))"; return 0
  fi
  # Linked straight out of a phren checkout with `herdr plugin link`: use the
  # local build, so a contributor's plugin and CLI stay in step.
  local dist="${HERDR_PLUGIN_ROOT:-}/../../packages/cli/dist/index.js"
  if [ -n "${HERDR_PLUGIN_ROOT:-}" ] && [ -f "$dist" ] && command -v node >/dev/null 2>&1; then
    PHREN_ARGV=(node "$dist"); PHREN_SOURCE="checkout ($dist)"; return 0
  fi
  if command -v npx >/dev/null 2>&1; then
    PHREN_ARGV=(npx -y @phren/cli); PHREN_SOURCE="npx @phren/cli"; return 0
  fi
  return 1
}

# Popups vanish the moment their process exits, which would swallow any message
# worth reading. Hold the pane open until the user acknowledges it.
hold_open() {
  printf '\n  %s\n\n  Press enter to close… ' "$1"
  read -r _ || true
}
