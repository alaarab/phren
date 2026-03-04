#!/bin/bash
# Link cortex knowledge into Claude's config based on the current machine's profile.
#
# First run on a new machine: identifies the machine, picks a profile,
# sets up sparse-checkout, and symlinks everything into place.
#
# Usage:
#   ./link.sh                    # Normal sync
#   ./link.sh --profile <name>   # Override machine detection, use this profile
#   ./link.sh --register         # Force re-registration of this machine
#   ./link.sh --task <mode>      # Task-focused context (debugging|planning|clean)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MACHINE_FILE="$HOME/.cortex-machine"
CONTEXT_FILE="$HOME/.cortex-context.md"

# Allow overriding machines.yaml location for personal (non-framework) use
MACHINES_FILE="${CORTEX_PERSONAL:-$SCRIPT_DIR/machines.yaml}"

# Search paths when looking for project directories on disk
SEARCH_PATHS=(
  "$HOME"
  "$HOME/Sites"
  "$HOME/Projects"
  "$HOME/Code"
  "$HOME/dev"
)
[ -n "${PROJECTS_DIR:-}" ] && SEARCH_PATHS=("$PROJECTS_DIR" "${SEARCH_PATHS[@]}")

# ── Helpers ──────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

# Read a value from a YAML file. Handles simple key: value pairs only.
# Usage: yaml_value file key
yaml_value() {
  local file="$1" key="$2"
  grep -E "^${key}:" "$file" 2>/dev/null | sed "s/^${key}:[[:space:]]*//" | sed 's/[[:space:]]*$//'
}

# Read a YAML list into a bash array. Handles "  - item" format.
# Usage: yaml_list file key -> prints one item per line
yaml_list() {
  local file="$1" key="$2"
  sed -n "/^${key}:/,/^[^ #-]/p" "$file" | grep -E '^\s*-' | sed 's/^[[:space:]]*-[[:space:]]*//'
}

# Collect all known project names across every profile
all_known_projects() {
  for pfile in "$SCRIPT_DIR/profiles/"*.yaml; do
    [ -f "$pfile" ] || continue
    yaml_list "$pfile" "projects"
  done | sort -u
}

find_project_dir() {
  local name="$1"
  for dir in "${SEARCH_PATHS[@]}"; do
    if [ -d "$dir/$name" ]; then
      echo "$dir/$name"
      return 0
    fi
  done
  return 1
}

# Find a profile file by its name field. Returns path or empty string.
find_profile_file() {
  local target="$1"
  for pfile in "$SCRIPT_DIR/profiles/"*.yaml; do
    [ -f "$pfile" ] || continue
    if [ "$(yaml_value "$pfile" "name")" = "$target" ]; then
      echo "$pfile"
      return 0
    fi
  done
  return 1
}

# Convert project slug to display name: "my-project" -> "My Project"
display_name() {
  echo "$1" | sed 's/-/ /g; s/\b\(.\)/\u\1/g'
}

# Build the common header block for task-mode context files
context_header() {
  local mode="$1" machine="$2" profile="$3" mcp_status="$4"
  local header=""
  header+="# cortex context ($mode)"$'\n'
  header+="Machine: $machine"$'\n'
  header+="Profile: $profile"$'\n'
  header+="Last synced: $(date +%Y-%m-%d)"$'\n'

  local mcp_line
  mcp_line="$(format_mcp_status "$mcp_status")"
  [ -n "$mcp_line" ] && header+="$mcp_line"$'\n'

  printf '%s' "$header"
}

# Format MCP status as a human-readable line (empty if nothing to say)
format_mcp_status() {
  local mcp_status="$1"
  case "$mcp_status" in
    installed|already_configured)
      echo "MCP: active (search_cortex, get_project_summary, list_projects)" ;;
    not_built)
      echo "MCP: not built. Run: cd $SCRIPT_DIR/mcp && npm install && npm run build" ;;
  esac
}

# ── Machine identification ───────────────────────────────────────────────

get_machine_name() {
  if [ -f "$MACHINE_FILE" ]; then
    cat "$MACHINE_FILE"
  else
    hostname
  fi
}

lookup_profile() {
  yaml_value "$MACHINES_FILE" "$1"
}

# List available profiles by scanning profiles/*.yaml
list_profiles() {
  for pfile in "$SCRIPT_DIR/profiles/"*.yaml; do
    [ -f "$pfile" ] || continue
    local name desc
    name="$(yaml_value "$pfile" "name")"
    desc="$(yaml_value "$pfile" "description")"
    [ -n "$name" ] && echo "  $name  ($desc)"
  done
}

register_machine() {
  local machine=""
  local profile=""

  echo "This machine isn't registered with cortex yet."
  echo ""

  # Get machine name
  read -rp "What should this machine be called? (e.g. work-desktop): " machine
  [ -z "$machine" ] && die "Machine name can't be empty."

  # Show available profiles
  echo ""
  echo "Available profiles:"
  list_profiles
  echo ""
  read -rp "Which profile? " profile
  [ -z "$profile" ] && die "Profile name can't be empty."

  # Verify the profile file exists
  find_profile_file "$profile" >/dev/null || die "No profile named '$profile' found in profiles/."

  # Write machine file
  echo "$machine" > "$MACHINE_FILE"

  # Append to machines.yaml
  echo "${machine}: ${profile}" >> "$MACHINES_FILE"

  # Commit machines.yaml if we're in a git repo
  if git -C "$SCRIPT_DIR" rev-parse --git-dir &>/dev/null; then
    git -C "$SCRIPT_DIR" add "$MACHINES_FILE"
    git -C "$SCRIPT_DIR" commit -m "Register machine: $machine ($profile)" --allow-empty 2>/dev/null || true
  fi

  echo ""
  echo "Registered $machine with profile $profile."
}

# ── Sparse checkout ──────────────────────────────────────────────────────

setup_sparse_checkout() {
  local projects=("$@")

  # Only run sparse-checkout if we're in a git repo
  git -C "$SCRIPT_DIR" rev-parse --git-dir &>/dev/null || return 0

  # Always include these
  local paths=("profiles" "machines.yaml" "global" "link.sh" "README.md" ".gitignore")

  for p in "${projects[@]}"; do
    paths+=("$p")
  done

  git -C "$SCRIPT_DIR" sparse-checkout set "${paths[@]}" 2>/dev/null || true
  git -C "$SCRIPT_DIR" pull --ff-only 2>/dev/null || true
}

# ── Symlinking ───────────────────────────────────────────────────────────

link_global() {
  echo "  global skills -> ~/.claude/skills/"
  mkdir -p "$HOME/.claude/skills"

  for f in "$SCRIPT_DIR/global/skills/"*; do
    [ -f "$f" ] || continue
    ln -sf "$f" "$HOME/.claude/skills/$(basename "$f")"
  done

  if [ -f "$SCRIPT_DIR/global/CLAUDE.md" ]; then
    ln -sf "$SCRIPT_DIR/global/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  fi
}

link_project() {
  local project="$1"
  local target

  target="$(find_project_dir "$project")" || true
  if [ -z "$target" ]; then
    echo "  skip $project (not found on disk)"
    return
  fi

  echo "  $project -> $target"

  # Symlink CLAUDE.md and other knowledge files
  for f in CLAUDE.md KNOWLEDGE.md LEARNINGS.md; do
    if [ -f "$SCRIPT_DIR/$project/$f" ]; then
      ln -sf "$SCRIPT_DIR/$project/$f" "$target/$f"
    fi
  done

  # Symlink CLAUDE-*.md split files (for @import support)
  for f in "$SCRIPT_DIR/$project"/CLAUDE-*.md; do
    [ -f "$f" ] && ln -sf "$f" "$target/$(basename "$f")"
  done

  # Add token budget annotation to CLAUDE.md if it's large
  local claude_file="$SCRIPT_DIR/$project/CLAUDE.md"
  if [ -f "$claude_file" ]; then
    local file_size
    file_size=$(wc -c < "$claude_file")
    local estimated_tokens
    estimated_tokens=$((file_size / 4))

    if [ "$estimated_tokens" -gt 500 ]; then
      # Check if annotation already exists
      if ! head -1 "$claude_file" | grep -q "<!-- tokens:"; then
        # Round to nearest 100
        local rounded
        rounded=$(( ((estimated_tokens + 50) / 100) * 100 ))
        local annotation="<!-- tokens: ~$rounded -->"

        # Read file, prepend annotation, write back
        local tmp_file
        tmp_file="$(mktemp)"
        {
          echo "$annotation"
          cat "$claude_file"
        } > "$tmp_file"
        mv "$tmp_file" "$claude_file"
      fi
    fi
  fi

  # Symlink project-level skills
  if [ -d "$SCRIPT_DIR/$project/.claude/skills" ]; then
    mkdir -p "$target/.claude/skills"
    for f in "$SCRIPT_DIR/$project/.claude/skills/"*; do
      [ -f "$f" ] || continue
      ln -sf "$f" "$target/.claude/skills/$(basename "$f")"
    done
  fi
}

# ── Context file ─────────────────────────────────────────────────────────

write_context_default() {
  local machine="$1" profile="$2" mcp_status="$3"
  shift 3
  local active_projects=("$@")

  # Figure out which projects are NOT in this profile
  local all_projects
  all_projects="$(all_known_projects)"
  local inactive=()
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    local found=0
    for a in "${active_projects[@]}"; do
      if [ "$a" = "$p" ]; then
        found=1
        break
      fi
    done
    [ "$found" -eq 0 ] && inactive+=("$p")
  done <<< "$all_projects"

  local active_str
  active_str="$(IFS=', '; echo "${active_projects[*]}")"
  local inactive_str
  if [ "${#inactive[@]}" -gt 0 ]; then
    inactive_str="$(IFS=', '; echo "${inactive[*]}")"
  else
    inactive_str="none"
  fi

  local mcp_line
  mcp_line="$(format_mcp_status "$mcp_status")"

  {
    echo "# cortex context"
    echo "Machine: $machine"
    echo "Profile: $profile"
    echo "Active projects: $active_str"
    echo "Not on this machine: $inactive_str"
    [ -n "$mcp_line" ] && echo "$mcp_line"
    echo "Last synced: $(date +%Y-%m-%d)"
  } > "$CONTEXT_FILE"

  echo "  wrote $CONTEXT_FILE"
}

# ── Memory rebuild ───────────────────────────────────────────────────────

rebuild_memory() {
  local active_projects=("$@")
  local user
  user="$(whoami)"
  local memory_dir="$HOME/.claude/projects/-home-${user}/memory"
  local memory_file="$memory_dir/MEMORY.md"

  mkdir -p "$memory_dir"

  # If no summary.md files exist, nothing to rebuild
  local has_summaries=0
  for project in "${active_projects[@]}"; do
    [ "$project" = "global" ] && continue
    if [ -f "$SCRIPT_DIR/$project/summary.md" ]; then
      has_summaries=1
      break
    fi
  done
  [ "$has_summaries" -eq 0 ] && return 0

  # Preserve user-written content above the managed section
  local header=""
  if [ -f "$memory_file" ]; then
    header="$(sed '/^<!-- cortex:projects:start -->/,$d' "$memory_file")"
  fi

  # Build a pointer table (not inline content) for token efficiency
  local managed=""
  managed+="<!-- cortex:projects:start -->"$'\n'
  managed+="<!-- Auto-generated by link.sh. Do not edit below this line. -->"$'\n'$'\n'
  managed+="## Active Projects"$'\n'$'\n'
  managed+="| Project | What | Memory |"$'\n'
  managed+="|---------|------|--------|"$'\n'

  for project in "${active_projects[@]}"; do
    [ "$project" = "global" ] && continue
    local summary_file="$SCRIPT_DIR/$project/summary.md"
    [ -f "$summary_file" ] || continue

    local what
    what="$(grep -E '^\*\*What:\*\*' "$summary_file" 2>/dev/null | sed 's/\*\*What:\*\*[[:space:]]*//' | head -1)"
    [ -z "$what" ] && what="(see summary)"

    managed+="| $(display_name "$project") | $what | MEMORY-${project}.md |"$'\n'
  done

  managed+=$'\n'"<!-- cortex:projects:end -->"

  if [ -n "$header" ]; then
    printf '%s\n%s\n' "$header" "$managed" > "$memory_file"
  else
    {
      echo "# Root Memory"
      echo ""
      echo "## Machine Context"
      echo 'Read `~/.cortex-context.md` for profile, active projects, last sync date.'
      echo ""
      echo "## Cross-Project Notes"
      echo "- Read a project's CLAUDE.md before making changes."
      echo "- Per-project memory files (MEMORY-{name}.md) have commands, versions, gotchas."
      echo ""
      printf '%s\n' "$managed"
    } > "$memory_file"
  fi

  echo "  rebuilt $memory_file (pointer format)"

  # Generate per-project MEMORY-{name}.md from summary.md (skip if already exists)
  for project in "${active_projects[@]}"; do
    [ "$project" = "global" ] && continue
    local summary_file="$SCRIPT_DIR/$project/summary.md"
    [ -f "$summary_file" ] || continue

    local project_memory="$memory_dir/MEMORY-${project}.md"
    if [ ! -f "$project_memory" ]; then
      {
        echo "# $(display_name "$project")"
        echo ""
        cat "$summary_file"
        echo ""
        echo "## Notes"
        echo "<!-- Session learnings, patterns, decisions -->"
      } > "$project_memory"

      echo "  created $project_memory"
    fi
  done
}

# ── MCP auto-install ─────────────────────────────────────────────────

configure_mcp() {
  local mcp_dist="$SCRIPT_DIR/mcp/dist/index.js"
  local settings_file=""

  # Find the settings file
  if [ -f "$HOME/.claude/settings.json" ]; then
    settings_file="$HOME/.claude/settings.json"
  elif [ -f "$HOME/.config/claude/settings.json" ]; then
    settings_file="$HOME/.config/claude/settings.json"
  fi

  # If MCP isn't built, return status for context file
  if [ ! -f "$mcp_dist" ]; then
    echo "not_built"
    return 0
  fi

  # No settings file found, nothing to patch
  if [ -z "$settings_file" ]; then
    echo "no_settings"
    return 0
  fi

  # Check if cortex MCP entry already exists
  if grep -q '"cortex"' "$settings_file" 2>/dev/null; then
    echo "already_configured"
    return 0
  fi

  # Patch settings.json to add mcpServers.cortex
  if command -v jq &>/dev/null; then
    local tmp_file
    tmp_file="$(mktemp)"
    jq --arg dist "$mcp_dist" '.mcpServers.cortex = {"command": "node", "args": [$dist]}' "$settings_file" > "$tmp_file"
    mv "$tmp_file" "$settings_file"
  else
    # Fallback: sed-based patching when jq isn't available
    local tmp_file
    tmp_file="$(mktemp)"
    if grep -q '"mcpServers"' "$settings_file" 2>/dev/null; then
      sed '/"mcpServers"[[:space:]]*:[[:space:]]*{/a\
    "cortex": {"command": "node", "args": ["'"$mcp_dist"'"]},' "$settings_file" > "$tmp_file"
    else
      sed '$s/}$/,\n  "mcpServers": {\n    "cortex": {"command": "node", "args": ["'"$mcp_dist"'"]}\n  }\n}/' "$settings_file" > "$tmp_file"
    fi
    mv "$tmp_file" "$settings_file"
  fi
  echo "installed"
}

configure_vscode_mcp() {
  local mcp_dist="$SCRIPT_DIR/mcp/dist/index.js"
  [ -f "$mcp_dist" ] || { echo "not_built"; return 0; }

  # Find VS Code user config directory (Linux, macOS)
  local vscode_dir=""
  for d in "$HOME/.config/Code/User" "$HOME/Library/Application Support/Code/User"; do
    [ -d "$d" ] && vscode_dir="$d" && break
  done
  [ -z "$vscode_dir" ] && { echo "no_vscode"; return 0; }

  local mcp_file="$vscode_dir/mcp.json"

  if [ -f "$mcp_file" ] && grep -q '"cortex"' "$mcp_file" 2>/dev/null; then
    echo "already_configured"
    return 0
  fi

  if command -v jq &>/dev/null; then
    local tmp_file
    tmp_file="$(mktemp)"
    if [ -f "$mcp_file" ]; then
      jq --arg dist "$mcp_dist" '.servers.cortex = {"command": "node", "args": [$dist]}' "$mcp_file" > "$tmp_file"
    else
      jq -n --arg dist "$mcp_dist" '{"servers": {"cortex": {"command": "node", "args": [$dist]}}}' > "$tmp_file"
    fi
    mv "$tmp_file" "$mcp_file"
  else
    if [ ! -f "$mcp_file" ]; then
      printf '{\n  "servers": {\n    "cortex": {"command": "node", "args": ["%s"]}\n  }\n}\n' "$mcp_dist" > "$mcp_file"
    else
      echo "no_jq"
      return 0
    fi
  fi
  echo "installed"
}

# ── Task-mode context ────────────────────────────────────────────────

write_context_debugging() {
  local machine="$1" profile="$2" mcp_status="$3"
  shift 3
  local active_projects=("$@")

  local content=""
  content+="$(context_header "debugging" "$machine" "$profile" "$mcp_status")"

  content+=$'\n'"## Project Learnings"$'\n'

  for project in "${active_projects[@]}"; do
    [ "$project" = "global" ] && continue
    local learnings="$SCRIPT_DIR/$project/LEARNINGS.md"
    if [ -f "$learnings" ]; then
      content+=$'\n'"### $project"$'\n'
      content+="$(cat "$learnings")"$'\n'
    fi
  done

  printf '%s' "$content" > "$CONTEXT_FILE"
  echo "  wrote $CONTEXT_FILE (debugging mode)"
}

write_context_planning() {
  local machine="$1" profile="$2" mcp_status="$3"
  shift 3
  local active_projects=("$@")

  local content=""
  content+="$(context_header "planning" "$machine" "$profile" "$mcp_status")"

  for project in "${active_projects[@]}"; do
    [ "$project" = "global" ] && continue
    local summary="$SCRIPT_DIR/$project/summary.md"
    local backlog="$SCRIPT_DIR/$project/backlog.md"

    if [ -f "$summary" ] || [ -f "$backlog" ]; then
      content+=$'\n'"## $project"$'\n'
    fi

    if [ -f "$summary" ]; then
      content+="$(cat "$summary")"$'\n'
    fi
    if [ -f "$backlog" ]; then
      content+=$'\n'"### Backlog"$'\n'
      content+="$(cat "$backlog")"$'\n'
    fi
  done

  printf '%s' "$content" > "$CONTEXT_FILE"
  echo "  wrote $CONTEXT_FILE (planning mode)"
}

write_context_clean() {
  local machine="$1" profile="$2" mcp_status="$3"
  shift 3
  local active_projects=("$@")

  local project_list
  project_list="$(IFS=', '; echo "${active_projects[*]}")"

  local content=""
  content+="# cortex context (clean)"$'\n'
  content+="Machine: $machine | Profile: $profile | Projects: $project_list"$'\n'

  local mcp_line
  mcp_line="$(format_mcp_status "$mcp_status")"
  [ -n "$mcp_line" ] && content+="$mcp_line"$'\n'

  printf '%s' "$content" > "$CONTEXT_FILE"
  echo "  wrote $CONTEXT_FILE (clean mode)"
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
  local force_register=0
  local override_profile=""
  local task_mode=""

  # Parse flags
  while [ $# -gt 0 ]; do
    case "$1" in
      --register)
        force_register=1
        shift
        ;;
      --profile)
        [ -z "${2:-}" ] && die "--profile requires a value"
        override_profile="$2"
        shift 2
        ;;
      --task)
        [ -z "${2:-}" ] && die "--task requires a value (debugging|planning|clean)"
        task_mode="$2"
        case "$task_mode" in
          debugging|planning|clean) ;;
          *) die "Unknown task mode: $task_mode (expected: debugging, planning, clean)" ;;
        esac
        shift 2
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done

  echo "cortex link"
  echo ""

  # Step 1: Identify machine
  local machine profile

  machine="$(get_machine_name)"

  if [ -n "$override_profile" ]; then
    profile="$override_profile"
  else
    if [ "$force_register" -eq 1 ]; then
      register_machine
    else
      profile="$(lookup_profile "$machine")"
      if [ -z "$profile" ]; then
        register_machine
      fi
    fi
    # After register_machine writes $MACHINE_FILE, re-read both in case
    # the user entered a different machine name than the current hostname.
    machine="$(get_machine_name)"
    profile="$(lookup_profile "$machine")"
  fi

  [ -z "$profile" ] && die "Could not determine profile for machine '$machine'."

  # Step 2: Find the profile file
  local profile_file
  profile_file="$(find_profile_file "$profile")" || die "Profile '$profile' not found in profiles/."

  echo "Machine: $machine"
  echo "Profile: $profile ($profile_file)"
  echo ""

  # Step 3: Read projects from profile
  local projects=()
  while IFS= read -r line; do
    [ -n "$line" ] && projects+=("$line")
  done <<< "$(yaml_list "$profile_file" "projects")"

  [ "${#projects[@]}" -eq 0 ] && die "Profile '$profile' has no projects listed."

  # Step 4: Sparse checkout
  echo "Setting up sparse checkout..."
  setup_sparse_checkout "${projects[@]}"
  echo ""

  # Step 5: Symlink everything
  echo "Linking..."
  link_global
  for p in "${projects[@]}"; do
    [ "$p" = "global" ] && continue
    link_project "$p"
  done
  echo ""

  # Step 6: Configure MCP
  echo "Configuring MCP..."
  local mcp_status
  mcp_status="$(configure_mcp)"
  case "$mcp_status" in
    installed)          echo "  Claude: installed cortex MCP server" ;;
    already_configured) echo "  Claude: cortex MCP already configured" ;;
    not_built)          echo "  MCP not built — run: cd mcp && npm install && npm run build" ;;
    no_settings)        echo "  Claude settings not found (skipping)" ;;
  esac

  local vscode_status
  vscode_status="$(configure_vscode_mcp)"
  case "$vscode_status" in
    installed)          echo "  VS Code: installed cortex MCP server" ;;
    already_configured) echo "  VS Code: cortex MCP already configured" ;;
    no_vscode)          ;; # VS Code not installed, skip silently
    no_jq)              echo "  VS Code: mcp.json exists but jq not available to patch it" ;;
  esac
  echo ""

  # Step 7: Write context file (based on task mode)
  if [ -n "$task_mode" ]; then
    "write_context_${task_mode}" "$machine" "$profile" "$mcp_status" "${projects[@]}"
  else
    write_context_default "$machine" "$profile" "$mcp_status" "${projects[@]}"
  fi

  # Step 8: Rebuild memory
  rebuild_memory "${projects[@]}"

  echo ""
  echo "Done. Profile '$profile' is active."
  [ -n "$task_mode" ] && echo "Task mode: $task_mode"
}

main "$@"
