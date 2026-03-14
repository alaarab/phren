#!/bin/sh
# post-session.sh: Remind Claude to capture learnings before a session ends.
#
# Wired as a Stop hook in Claude Code. When Claude finishes responding,
# this script checks whether you're inside a phren-managed project
# and nudges a phren-learn pass.
#
# If PHREN_AUTO_LEARN=1, it outputs a stronger prompt that tells Claude
# to run the extraction automatically instead of just reminding.
#
# The Stop hook fires every time Claude finishes a turn. To avoid
# spamming, we guard against re-entry when the hook itself triggered
# a continuation (stop_hook_active=true).
#
# Shell compatibility: POSIX sh. No bash-specific syntax.

set -eu

INPUT=$(cat)

# Guard: if we're already inside a stop-hook continuation, bail out
# so we don't loop forever.
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

# Find the phren directory
PHREN_DIR="${PHREN_DIR:-$HOME/.phren}"
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# If no cwd from stdin, skip
if [ -z "$CWD" ]; then
  exit 0
fi

# Check if the current directory is a phren-managed project.
# Walk up the directory tree looking for a CLAUDE.md that's a symlink
# pointing back into phren.
detect_project() {
  _dp_dir="$1"
  _dp_basename="$(basename "$_dp_dir")"

  # Direct check: does phren have a directory for this project?
  if [ -d "$PHREN_DIR/$_dp_basename" ]; then
    echo "$_dp_basename"
    return 0
  fi

  # Symlink check: is CLAUDE.md a symlink to phren?
  if [ -L "$_dp_dir/CLAUDE.md" ]; then
    _dp_target="$(readlink -f "$_dp_dir/CLAUDE.md")"
    case "$_dp_target" in
      "$PHREN_DIR"/*)
        echo "$_dp_basename"
        return 0
        ;;
    esac
  fi

  return 1
}

PROJECT=$(detect_project "$CWD") || true

if [ -z "$PROJECT" ]; then
  # Not a phren project, nothing to do
  exit 0
fi

# Output a reminder. Stdout from Stop hooks gets injected into
# Claude's context, so Claude will see this as its next instruction.
if [ "${PHREN_AUTO_LEARN:-0}" = "1" ]; then
  cat <<EOF
Session wrapping up for project "$PROJECT". Before stopping, tell phren what you learned:
1. Look at what changed this session (files edited, problems solved, patterns discovered).
2. Tell phren anything worth remembering — he'll append it to $PHREN_DIR/$PROJECT/LEARNINGS.md.
3. Keep entries short, one line per learning, grouped by topic.
EOF
else
  echo "Session ended for project \"$PROJECT\". Tell phren what you learned before you go — run phren-learn."
fi

exit 0
