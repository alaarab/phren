#!/bin/bash
# post-session.sh: Remind Claude to capture learnings before a session ends.
#
# Wired as a Stop hook in Claude Code. When Claude finishes responding,
# this script checks whether you're inside a cortex-managed project
# and nudges a cortex-learn pass.
#
# If CORTEX_AUTO_LEARN=1, it outputs a stronger prompt that tells Claude
# to run the extraction automatically instead of just reminding.
#
# The Stop hook fires every time Claude finishes a turn. To avoid
# spamming, we guard against re-entry when the hook itself triggered
# a continuation (stop_hook_active=true).

set -euo pipefail

INPUT=$(cat)

# Guard: if we're already inside a stop-hook continuation, bail out
# so we don't loop forever.
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

# Find the cortex directory
CORTEX_DIR="${CORTEX_DIR:-$HOME/cortex}"
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# If no cwd from stdin, skip
if [ -z "$CWD" ]; then
  exit 0
fi

# Check if the current directory is a cortex-managed project.
# Walk up the directory tree looking for a CLAUDE.md that's a symlink
# pointing back into cortex.
detect_project() {
  local dir="$1"
  local basename
  basename="$(basename "$dir")"

  # Direct check: does cortex have a directory for this project?
  if [ -d "$CORTEX_DIR/$basename" ]; then
    echo "$basename"
    return 0
  fi

  # Symlink check: is CLAUDE.md a symlink to cortex?
  if [ -L "$dir/CLAUDE.md" ]; then
    local target
    target="$(readlink -f "$dir/CLAUDE.md")"
    if [[ "$target" == "$CORTEX_DIR"/* ]]; then
      echo "$basename"
      return 0
    fi
  fi

  return 1
}

PROJECT=$(detect_project "$CWD") || true

if [ -z "$PROJECT" ]; then
  # Not a cortex project, nothing to do
  exit 0
fi

# Output a reminder. Stdout from Stop hooks gets injected into
# Claude's context, so Claude will see this as its next instruction.
if [ "${CORTEX_AUTO_LEARN:-0}" = "1" ]; then
  cat <<EOF
Session wrapping up for project "$PROJECT". Before stopping, run a quick cortex-learn pass:
1. Look at what changed this session (files edited, problems solved, patterns discovered).
2. Append anything worth remembering to $CORTEX_DIR/$PROJECT/LEARNINGS.md.
3. Keep entries short, one line per learning, grouped by topic.
EOF
else
  echo "Session ended for project \"$PROJECT\". Consider running /cortex-learn to capture what you just learned."
fi

exit 0
