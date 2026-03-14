# phren: LLM Installation Guide

phren keeps project memory portable across sessions and machines. It runs as an MCP server and a set of lifecycle hooks.

## Quick Start

```bash
npm install -g @alaarab/phren
phren init
phren init --dry-run
```

This creates `~/.phren`, configures MCP for Claude Code (and any detected agents: VS Code, Cursor, Copilot CLI, Codex), and wires up lifecycle hooks.

Project setup note:
- `phren add` is the supported enrollment path for an existing repo.

To update the installed package:

```bash
phren update
```

To update the installed package and refresh shipped starter globals in one flow:

```bash
phren update --refresh-starter
```

Use `phren init --apply-starter-update` when you only want to refresh starter assets without running the full update flow.

To remove everything:

```bash
phren uninstall
```

## Maintenance Safety

Destructive maintenance commands (`prune` and `consolidate`) should be run with `--dry-run` first. On write paths that rewrite `FINDINGS.md`, phren creates/updates `FINDINGS.md.bak` and reports changed backup paths (for example, `Updated backups (1): <project>/FINDINGS.md.bak`). `--dry-run` previews changes without creating backups.

## MCP Tools (64)

### Search and Browse

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_knowledge` | `query`, `type?`, `limit?`, `project?` | FTS5 full-text search across your project store. Supports AND, OR, NOT, phrase matching. |
| `get_memory_detail` | `id` | Fetch full content of a memory by id (e.g. `mem:project/filename`). |
| `get_project_summary` | `name` | Returns a project's summary card, CLAUDE.md path, and list of indexed files. |
| `list_projects` | (none) | Lists all projects in the active profile with doc badges and brief descriptions. |
| `get_findings` | `project`, `limit?` | Read recent findings without a search query. |

### Task Management (`task` tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_tasks` | `project?`, `id?`, `item?` | Read the task list for one project, or all projects if omitted. Fetch a single item by ID or text. |
| `add_task` | `project`, `item` | Append a task to a project's Queue section in `tasks.md`. |
| `add_tasks` | `project`, `items[]` | Bulk add multiple tasks in one call. |
| `complete_task` | `project`, `item` | Move a task to Done by text match. |
| `complete_tasks` | `project`, `items[]` | Bulk complete multiple items in one call. |
| `remove_task` | `project`, `item` | Remove a task by matching text. |
| `update_task` | `project`, `item`, `updates` | Update an item's priority, context, section, or linked GitHub issue. |
| `link_task_issue` | `project`, `item`, `issue_number?`, `issue_url?`, `unlink?` | Link or unlink an existing GitHub issue on a task item. |
| `promote_task_to_issue` | `project`, `item`, `repo?`, `title?`, `body?`, `mark_done?` | Create a GitHub issue from a task item and write the link back. |
| `pin_task` | `project`, `item` | Pin a task so it stays visible across sessions. |
| `work_next_task` | `project?` | Pick the next highest-priority task to work on. |
| `promote_task` | `project`, `item` | Promote a task to a higher priority section. |
| `tidy_done_tasks` | `project?` | Archive completed tasks to keep the list clean. |

### Finding Capture

| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_finding` | `project`, `finding`, `citation?: { file?, line?, repo?, commit?, task_item? }`, `sessionId?`, `source?` | Append an insight to FINDINGS.md with optional source citation and provenance source (`human`, `agent`, `hook`, `extract`, `consolidation`, `unknown`). |
| `add_findings` | `project`, `findings[]`, `sessionId?` | Bulk add multiple findings in one call. Pass `sessionId` to update session metrics. |
| `supersede_finding` | `project`, `finding_text`, `superseded_by` | Mark a finding as superseded by a newer one. |
| `retract_finding` | `project`, `finding_text`, `reason` | Retract a finding and store lifecycle reason metadata. |
| `resolve_contradiction` | `project`, `finding_text`, `finding_text_other`, `resolution` | Resolve contradiction status between two findings (`keep_a`, `keep_b`, `keep_both`, `retract_both`). |
| `get_contradictions` | `project?`, `finding_text?` | List unresolved contradicted findings across one project or all projects, optionally filtered by selector. |
| `remove_finding` | `project`, `finding` | Remove a finding by text match. Use when an insight is wrong or outdated. |
| `remove_findings` | `project`, `findings[]` | Bulk remove multiple findings in one call. |
| `push_changes` | `message?` | Commit and push all phren changes. Retries with rebase on push conflicts. |
| `auto_extract_findings` | `context` | Extract findings from conversation context automatically. |

### Memory Quality

| Tool | Parameters | Description |
|------|-----------|-------------|
| `pin_memory` | `project`, `memory` | Write a truth into truths.md — never decays, always injected. |
| `memory_feedback` | `key`, `feedback` | Record whether an injected memory was `helpful`, a `reprompt`, or a `regression`. |

### Data Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_project` | `path`, `profile?` | Bootstrap a repo or working directory into phren and add it to the active profile. |
| `export_project` | `project` | Export a project's data (findings, tasks, summary) as portable JSON. |
| `import_project` | `data` | Import project data from a previously exported JSON payload. |
| `manage_project` | `project`, `action` | Archive or unarchive a project. |

### Fragment Graph

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_fragments` | `name` | Find fragments and related docs by name. |
| `get_related_docs` | `fragment` | Get docs linked to a named fragment. |
| `read_graph` | `project?` | Read the fragment graph for a project or all projects. |
| `link_findings` | `project`, `finding_text`, `fragment`, `relation?` | Manually link a finding to a fragment. |
| `cross_project_fragments` | (none) | Find fragments shared across multiple projects. |

### Session Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `session_start` | `project?`, `connectionId?` | Mark session start. Returns prior summary, recent findings, active tasks, checkpoint resume hints, and a `sessionId`. |
| `session_end` | `summary?`, `sessionId?`, `connectionId?` | Mark session end and save summary for next session. Also writes task checkpoint snapshots and updates finding impact outcomes. |
| `session_context` | `sessionId?`, `connectionId?` | Get current session state. Pass `sessionId` or a previously bound `connectionId`. |
| `session_history` | `limit?`, `sessionId?`, `project?` | List past sessions or drill into a specific session to see its findings and tasks. |

### Skills Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_skills` | `project?` | List all installed skills with metadata. |
| `read_skill` | `name`, `project?` | Read full skill file content and parsed frontmatter. |
| `write_skill` | `name`, `content`, `scope` | Create or update a skill (`scope`: `'global'` or project name). |
| `remove_skill` | `name`, `project?` | Delete a skill file. |
| `enable_skill` | `name`, `project?` | Enable a disabled skill without rewriting it. |
| `disable_skill` | `name`, `project?` | Disable a skill without deleting it. |

Skill system behavior:
- precedence: project-local skills override global skills with the same name
- alias collisions: conflicting commands/aliases are marked unregistered in generated command output
- visibility gating: disabled skills remain on disk but are excluded from active agent mirrors
- generated artifacts: `.claude/skill-manifest.json` and `.claude/skill-commands.json`

### Hooks Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_hooks` | `project?` | Show hook status for all tools + custom hooks + config paths, optionally including project overrides. |
| `toggle_hooks` | `enabled`, `tool?`, `project?`, `event?` | Enable/disable hooks globally, per tool, or per tracked project/event. |
| `add_custom_hook` | `event`, `command`, `timeout?` | Add a custom integration hook. |
| `remove_custom_hook` | `event`, `command?` | Remove custom hooks by event/command match. |

### Health and Review

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_consolidation_status` | `project?` | Check if findings need consolidation. |
| `health_check` | (none) | Run doctor checks and return results. |
| `list_hook_errors` | (none) | Show recent hook errors and failures. |
| `get_review_queue` | `project?` | Read items waiting for review. |
| `approve_queue_item` | `project`, `item` | Approve an item from the review queue. |
| `reject_queue_item` | `project`, `item` | Reject an item from the review queue. |
| `edit_queue_item` | `project`, `item`, `new_text` | Edit an item in the review queue before accepting. |

Governance, policy, and maintenance tools are CLI-only. Use `phren config` and `phren maintain` commands.

## Lifecycle Hooks and Integrations

Claude receives full native lifecycle hooks in `~/.claude/settings.json`.
Copilot CLI, Cursor, and Codex receive generated hook config files plus session wrappers in `~/.local/bin` so start/stop lifecycle behavior still executes around each tool run.

| Hook | Event | What it does |
|------|-------|-------------|
| `hook-session-start` | SessionStart | Pulls latest phren changes (`git pull --rebase`), runs doctor self-heal, schedules daily maintenance. |
| `hook-prompt` | UserPromptSubmit | Extracts keywords from the user's prompt, searches phren, injects relevant context snippets. Checks consolidation thresholds and fires a one-time notice per session. |
| `hook-stop` | Stop | Auto-commits and pushes `~/.phren` changes after every agent response. |
| `hook-context` | SessionStart | Detects the current project from cwd and injects its CLAUDE.md and summary. |

Tool integration summary:
- Claude: full lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `Stop`) + MCP
- Copilot/Cursor/Codex: MCP + wrapper-driven lifecycle + generated per-tool hook config

## Modes

Toggle MCP and hooks independently:

```bash
phren mcp-mode on|off|status
phren hooks-mode on|off|status
```

When MCP is off but hooks are on, phren still injects context via hooks (no MCP tools available to the agent). When hooks are off, the hook commands exit immediately without doing work.

## Memory Governance Pipeline

phren includes a trust filtering system that scores and ages memory entries before injection.

### Decay Curve

Findings lose confidence as they age. The default decay multipliers:

| Age | Multiplier | Effect |
|-----|-----------|--------|
| 0-30 days | 1.0 | Full confidence |
| 30-60 days | 0.85 | Slightly reduced |
| 60-90 days | 0.65 | Moderate reduction |
| 90-120 days | 0.45 | Low confidence |
| 120+ days | 0.0 | Expired (prunable) |

These values are configurable via `phren config policy` or the `retention-policy.json` governance file.

### Citation Validation

Findings can include source citations (`file:line@commit`). The trust filter validates that cited files exist and optionally checks git history. Entries with invalid citations are flagged and queued for review.

### Finding Lifecycle and Impact Scoring

Finding lifecycle metadata is stored inline and updated by lifecycle tools (`supersede_finding`, `retract_finding`, `resolve_contradiction`).
Impact scoring tracks which finding IDs were injected into context and marks successful outcomes when session tasks are completed, boosting retrieval priority for repeatedly useful findings.

### Truth Locks

Entries in `truths.md` are protected from pruning and decay. Use `pin_memory` to save high-value findings that should persist indefinitely.

### Audit Trail

All governance actions (scans, prunes, migrations, feedback) are logged to `.runtime/audit.log` with timestamps and actor information. The `PHREN_ACTOR` env var identifies who performed the action.

### Identity and RBAC

Access control is role-based (`admin`, `maintainer`, `contributor`, `viewer`):
- shared policy: `.governance/access-control.json`
- local actor overrides: `.runtime/access-control.local.json`
- actor identity source: `PHREN_ACTOR` (when trusted) or OS user identity

### Quality Feedback Loop

The hook-prompt system tracks which memories get injected and whether they correlate with productive sessions. The `memory_feedback` tool lets agents record explicit outcomes:

- **helpful**: the memory contributed to the task
- **reprompt**: the memory was injected again (indicates ongoing relevance)
- **regression**: the memory caused confusion or incorrect behavior

Feedback scores feed back into the trust multiplier for future injections.

## Web UI Security

`phren web-ui` binds loopback-only (`127.0.0.1`) and generates a per-run auth token.
Mutating routes require both:
- auth token (bearer/query/body)
- CSRF token (single-use, TTL-bound)

The server also sets CSP and anti-framing headers.

## Telemetry (Opt-In)

Telemetry is disabled by default. Enable with:

```bash
phren config telemetry on
```

Telemetry is local-only and stored in `.runtime/telemetry.json` (tool/command/session/error counters). No external reporting is sent by default.

## Environment Variables

See [docs/environment.md](environment.md) for the full reference.
