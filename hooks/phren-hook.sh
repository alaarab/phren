#!/bin/sh
# phren-hook.sh: the Claude Code plugin's lifecycle hooks.
#
#   sh phren-hook.sh hook-prompt | hook-session-start | hook-tool | hook-stop
#
# Runs the same `phren hook-*` commands `phren init` writes into
# ~/.claude/settings.json, with three rules on top:
#
# 1. One owner. If settings.json already runs phren for this event (the user
#    ran `phren init`), this script does nothing, so nobody gets two
#    injections. Uninstalling the plugin or re-running `phren init` never
#    leaves both active.
# 2. Never slow. UserPromptSubmit runs on every prompt, so this never starts
#    a cold `npx`: it uses an installed `phren`, then the npx cache the
#    plugin's MCP server filled (offline, pinned to PHREN_PIN), else nothing.
# 3. Fail open. No store, no phren, or a phren error: exit 0 with no output.
#
# POSIX sh (Claude Code runs plugin hooks through Git Bash on Windows).
# PHREN_PLUGIN_HOOKS=off turns every plugin hook off.

EVENT="${1:-}"
case "$EVENT" in
  hook-prompt|hook-session-start|hook-tool|hook-stop) ;;
  *) exit 0 ;;
esac

# Kept in step with packages/cli/package.json by scripts/validate-docs.sh.
PHREN_PIN="0.3.31"

standdown() {
  # Drain stdin so Claude Code never sees a broken pipe, then exit quietly.
  cat >/dev/null 2>&1
  exit 0
}

[ "${PHREN_PLUGIN_HOOKS:-on}" = "off" ] && standdown

# ── 1. One owner ──────────────────────────────────────────────────────────
# `phren init` writes command hooks ending in `phren hook-prompt"` (or
# `index.js" hook-prompt"`) into the user's settings. If one is there for
# this event, settings.json owns it. Only the file Claude Code itself reads
# counts: under CLAUDE_CONFIG_DIR, hooks in ~/.claude/settings.json never run.
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
if [ -f "$SETTINGS" ] && grep -Eq -- '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*(PHREN_PATH|phren|index\.js)([^"\\]|\\.)*'"$EVENT"'([^"\\]|\\.)*"' "$SETTINGS" 2>/dev/null; then
  standdown
fi

# ── 2. Is there a store? ──────────────────────────────────────────────────
has_store() {
  [ -n "${PHREN_PATH:-}" ] && return 0
  # The same markers phren's findPhrenPath accepts for ~/.phren.
  for _marker in phren.root.yaml machines.yaml .config global; do
    [ -e "$HOME/.phren/$_marker" ] && return 0
  done
  _dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  while [ -n "$_dir" ] && [ "$_dir" != "/" ]; do
    [ -f "$_dir/.phren/phren.root.yaml" ] && return 0
    _dir=$(dirname "$_dir")
  done
  return 1
}

# The setup-mode MCP server offers phren_setup. Tell Claude about it once,
# at the first session start, so a first-run user need not know the skill or
# tool name; someone who declines is not asked again every session.
SETUP_OFFERED="${XDG_STATE_HOME:-$HOME/.local/state}/phren/plugin-setup-offered"
if ! has_store; then
  if [ "$EVENT" = "hook-session-start" ] && [ ! -e "$SETUP_OFFERED" ]; then
    cat >/dev/null 2>&1
    mkdir -p "$(dirname "$SETUP_OFFERED")" 2>/dev/null && : > "$SETUP_OFFERED" 2>/dev/null
    printf '%s\n' 'phren has no memory store yet. Tell the user setup creates a local git-backed store and wires Claude Code, then offer to run phren_setup with confirm=true after they agree. Restart Claude Code after setup.'
    exit 0
  fi
  standdown
fi

# ── 3. Find phren without touching the network ────────────────────────────
run_phren() {
  if [ -n "${PHREN_BIN:-}" ] && [ -x "$PHREN_BIN" ]; then
    "$PHREN_BIN" "$@"
  elif command -v phren >/dev/null 2>&1; then
    phren "$@"
  elif [ -x "$HOME/.local/bin/phren" ]; then
    "$HOME/.local/bin/phren" "$@"
  elif command -v npx >/dev/null 2>&1; then
    # Offline: only the copy already in npm's cache (the MCP server's).
    npx --offline --yes "@phren/cli@$PHREN_PIN" "$@"
  else
    cat >/dev/null 2>&1
  fi
}

run_phren "$EVENT"
exit 0
