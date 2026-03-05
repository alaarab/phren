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
  if command -v yq &>/dev/null; then
    yq -r ".\"${key}\" // \"\"" "$file" 2>/dev/null
  else
    grep -E "^${key}:" "$file" 2>/dev/null | sed "s/^${key}:[[:space:]]*//" | sed 's/[[:space:]]*$//'
  fi
}

# Read a YAML list into a bash array. Handles "  - item" format.
# Usage: yaml_list file key -> prints one item per line
yaml_list() {
  local file="$1" key="$2"
  if command -v yq &>/dev/null; then
    yq -r ".\"${key}\"[]? // empty" "$file" 2>/dev/null
  else
    sed -n "/^${key}:/,/^[^ #-]/p" "$file" | grep -E '^\s*-' | sed 's/^[[:space:]]*-[[:space:]]*//'
  fi
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

  # Append to machines.yaml (atomic write to avoid partial updates)
  local tmp
  tmp="$(mktemp "${MACHINES_FILE}.XXXXXX")"
  if [ -f "$MACHINES_FILE" ]; then
    cp "$MACHINES_FILE" "$tmp"
  fi
  echo "${machine}: ${profile}" >> "$tmp"
  mv "$tmp" "$MACHINES_FILE"

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

# Write managed content to the context file, preserving any user content
# outside the <!-- cortex-managed --> markers.
write_context_file() {
  local managed_content="$1"
  local wrapped=""
  wrapped+="<!-- cortex-managed -->"$'\n'
  wrapped+="$managed_content"$'\n'
  wrapped+="<!-- /cortex-managed -->"

  if [ -f "$CONTEXT_FILE" ] && grep -q '<!-- cortex-managed -->' "$CONTEXT_FILE" 2>/dev/null; then
    # Preserve user content before and after the managed block
    local before after
    before="$(sed -n '1,/<!-- cortex-managed -->/{ /<!-- cortex-managed -->/d; p; }' "$CONTEXT_FILE")"
    after="$(sed -n '/<!-- \/cortex-managed -->/,${  /<!-- \/cortex-managed -->/d; p; }' "$CONTEXT_FILE")"

    local tmp
    tmp="$(mktemp "${CONTEXT_FILE}.XXXXXX")"
    {
      [ -n "$before" ] && printf '%s\n' "$before"
      printf '%s\n' "$wrapped"
      [ -n "$after" ] && printf '%s\n' "$after"
    } > "$tmp"
    mv "$tmp" "$CONTEXT_FILE"
  else
    printf '%s\n' "$wrapped" > "$CONTEXT_FILE"
  fi
}

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

  local managed=""
  managed+="# cortex context"$'\n'
  managed+="Machine: $machine"$'\n'
  managed+="Profile: $profile"$'\n'
  managed+="Active projects: $active_str"$'\n'
  managed+="Not on this machine: $inactive_str"
  [ -n "$mcp_line" ] && managed+=$'\n'"$mcp_line"
  managed+=$'\n'"Last synced: $(date +%Y-%m-%d)"

  write_context_file "$managed"

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
  local mcp_dist="" mcp_cmd="" mcp_args=""
  local settings_file=""

  # Check for a local dist first (if you cloned the framework)
  for candidate in \
    "$SCRIPT_DIR/mcp/dist/index.js" \
    "$HOME/cortex/mcp/dist/index.js" \
    "$HOME/Projects/cortex/mcp/dist/index.js"; do
    if [ -f "$candidate" ]; then
      mcp_dist="$candidate"
      mcp_cmd="node"
      mcp_args="$candidate"
      break
    fi
  done

  # No local dist? Fall back to npx
  if [ -z "$mcp_dist" ]; then
    if command -v npx &>/dev/null; then
      mcp_cmd="npx"
      mcp_args="-y @alaarab/cortex $SCRIPT_DIR"
    else
      echo "not_built"
      return 0
    fi
  fi

  # Smoke test the server if we have a local dist
  if [ -n "$mcp_dist" ]; then
    if ! node "$mcp_dist" --health 2>/dev/null; then
      echo "health_failed"
      return 0
    fi
  fi

  # Find the settings file
  if [ -f "$HOME/.claude/settings.json" ]; then
    settings_file="$HOME/.claude/settings.json"
  elif [ -f "$HOME/.config/claude/settings.json" ]; then
    settings_file="$HOME/.config/claude/settings.json"
  fi

  if [ -z "$settings_file" ]; then
    echo "no_settings"
    return 0
  fi

  # Check if cortex MCP entry already exists
  if grep -q '"cortex"' "$settings_file" 2>/dev/null; then
    echo "already_configured"
    return 0
  fi

  # Build the args array for jq
  local jq_args_expr
  if [ "$mcp_cmd" = "npx" ]; then
    jq_args_expr='["-y", "@alaarab/cortex", $dir]'
  else
    jq_args_expr='[$dist]'
  fi

  # Patch settings.json
  if command -v jq &>/dev/null; then
    local tmp_file
    tmp_file="$(mktemp)"
    jq --arg cmd "$mcp_cmd" --arg dist "${mcp_dist:-}" --arg dir "$SCRIPT_DIR" \
      ".mcpServers.cortex = {\"command\": \$cmd, \"args\": $jq_args_expr}" \
      "$settings_file" > "$tmp_file"
    mv "$tmp_file" "$settings_file"
  else
    echo ""
    echo "WARNING: jq is not installed. Add this to $settings_file manually:"
    echo ""
    echo "  \"mcpServers\": {"
    echo "    \"cortex\": {\"command\": \"$mcp_cmd\", \"args\": [$(echo "$mcp_args" | sed 's/ /", "/g; s/^/"/; s/$/"/' )]}"
    echo "  }"
    echo ""
    echo "no_jq"
    return 0
  fi

  echo "installed"
}

configure_vscode_mcp() {
  local mcp_dist="" mcp_cmd="" jq_args_expr=""

  # Check for a local dist first
  for candidate in \
    "$SCRIPT_DIR/mcp/dist/index.js" \
    "$HOME/cortex/mcp/dist/index.js" \
    "$HOME/Projects/cortex/mcp/dist/index.js"; do
    if [ -f "$candidate" ]; then
      mcp_dist="$candidate"
      mcp_cmd="node"
      jq_args_expr='[$dist]'
      break
    fi
  done

  # No local dist? Fall back to npx
  if [ -z "$mcp_dist" ]; then
    if command -v npx &>/dev/null; then
      mcp_cmd="npx"
      jq_args_expr='["-y", "@alaarab/cortex", $dir]'
    else
      echo "not_built"
      return 0
    fi
  fi

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
      jq --arg cmd "$mcp_cmd" --arg dist "${mcp_dist:-}" --arg dir "$SCRIPT_DIR" \
        ".servers.cortex = {\"command\": \$cmd, \"args\": $jq_args_expr}" \
        "$mcp_file" > "$tmp_file"
    else
      jq -n --arg cmd "$mcp_cmd" --arg dist "${mcp_dist:-}" --arg dir "$SCRIPT_DIR" \
        "{\"servers\": {\"cortex\": {\"command\": \$cmd, \"args\": $jq_args_expr}}}" > "$tmp_file"
    fi
    mv "$tmp_file" "$mcp_file"
  else
    if [ ! -f "$mcp_file" ]; then
      if [ "$mcp_cmd" = "npx" ]; then
        printf '{\n  "servers": {\n    "cortex": {"command": "npx", "args": ["-y", "@alaarab/cortex", "%s"]}\n  }\n}\n' "$SCRIPT_DIR" > "$mcp_file"
      else
        printf '{\n  "servers": {\n    "cortex": {"command": "node", "args": ["%s"]}\n  }\n}\n' "$mcp_dist" > "$mcp_file"
      fi
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

  write_context_file "$content"
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

  write_context_file "$content"
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

  write_context_file "$content"
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
    not_built)          echo "  MCP: no local dist found and npx not available. Install Node.js or build from source." ;;
    no_settings)        echo "  Claude settings not found (skipping)" ;;
    no_jq)              echo "  Claude: skipped (install jq to auto-configure)" ;;
    health_failed)      echo "  WARNING: MCP dist found but failed health check. Try rebuilding: cd mcp && npm run build" ;;
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
