# cortex: LLM Installation Guide

cortex keeps project memory portable across sessions and machines. It runs as an MCP server and a set of lifecycle hooks.

## Quick Start

```bash
npm install -g @alaarab/cortex
cortex init
cortex init --dry-run
```

This creates `~/.cortex`, configures MCP for Claude Code (and any detected agents: VS Code, Cursor, Copilot CLI, Codex), and wires up lifecycle hooks.

Project setup note:
- `cortex add` is the supported enrollment path for an existing repo.

To update the installed package:

```bash
cortex update
```

To update the installed package and refresh shipped starter globals in one flow:

```bash
cortex update --refresh-starter
```

Use `cortex init --apply-starter-update` when you only want to refresh starter assets without running the full update flow.

To remove everything:

```bash
cortex uninstall
```

## Maintenance Safety

Destructive maintenance commands (`prune` and `consolidate`) should be run with `--dry-run` first. On write paths that rewrite `FINDINGS.md`, cortex creates/updates `FINDINGS.md.bak` and reports changed backup paths (for example, `Updated backups (1): <project>/FINDINGS.md.bak`). `--dry-run` previews changes without creating backups.

## MCP Tools (51)

### Search and Browse

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_knowledge` | `query`, `type?`, `limit?`, `project?` | FTS5 full-text search across your project store. Supports AND, OR, NOT, phrase matching. |
| `get_project_summary` | `name` | Returns a project's summary card, CLAUDE.md path, and list of indexed files. |
| `list_projects` | (none) | Lists all projects in the active profile with doc badges and brief descriptions. |
| `get_findings` | `project`, `limit?` | Read recent findings without a search query. |

### Task Management (`task` tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_tasks` | `project?`, `id?`, `item?` | Read the task list for one project, or all projects if omitted. Fetch a single item by ID or text. |
| `add_task` | `project`, `item` | Append a task to a project's Queue section in `tasks.md`. |
| `complete_task` | `project`, `item` | Move a task to Done by text match. |
| `complete_tasks` | `project`, `items[]` | Bulk complete multiple items in one call. |
| `update_task` | `project`, `item`, `updates` | Update an item's priority, context, section, or linked GitHub issue. |
| `link_task_issue` | `project`, `item`, `issue_number?`, `issue_url?`, `unlink?` | Link or unlink an existing GitHub issue on a task item. |
| `promote_task_to_issue` | `project`, `item`, `repo?`, `title?`, `body?`, `mark_done?` | Create a GitHub issue from a task item and write the link back. |

### Finding Capture

| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_finding` | `project`, `finding`, `citation?: { file?, line?, repo?, commit?, task_item? }`, `sessionId?` | Append an insight to FINDINGS.md with optional source citation. Pass `sessionId` to update session metrics. |
| `add_findings` | `project`, `findings[]`, `sessionId?` | Bulk add multiple findings in one call. Pass `sessionId` to update session metrics. |
| `remove_finding` | `project`, `finding` | Remove a finding by text match. Use when an insight is wrong or outdated. |
| `remove_findings` | `project`, `findings[]` | Bulk remove multiple findings in one call. |
| `push_changes` | `message?` | Commit and push all cortex changes. Retries with rebase on push conflicts. |

### Memory Quality

| Tool | Parameters | Description |
|------|-----------|-------------|
| `pin_memory` | `project`, `memory` | Promote an important memory into CANONICAL_MEMORIES.md for priority retrieval. |
| `memory_feedback` | `key`, `feedback` | Record whether an injected memory was `helpful`, a `reprompt`, or a `regression`. |

### Data Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_project` | `path`, `profile?` | Bootstrap a repo or working directory into cortex and add it to the active profile. |
| `export_project` | `project` | Export a project's data (findings, tasks, summary) as portable JSON. |
| `import_project` | `data` | Import project data from a previously exported JSON payload. |
| `manage_project` | `project`, `action` | Archive or unarchive a project. |

### Entity Graph

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_entities` | `name` | Find entities and related docs by name. |
| `get_related_docs` | `entity` | Get docs linked to a named entity. |
| `read_graph` | `project?` | Read the entity graph for a project or all projects. |
| `link_findings` | `project`, `finding_text`, `entity`, `relation?` | Manually link a finding to an entity. |
| `cross_project_entities` | (none) | Find entities shared across multiple projects. |

### Session Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `session_start` | `project?`, `connectionId?` | Mark session start. Returns prior summary, recent findings, active tasks, and a `sessionId`. |
| `session_end` | `summary?`, `sessionId?`, `connectionId?` | Mark session end and save summary for next session. Pass `sessionId` or a previously bound `connectionId`. |
| `session_context` | `sessionId?`, `connectionId?` | Get current session state. Pass `sessionId` or a previously bound `connectionId`. |

Governance, policy, and maintenance tools are CLI-only. Use `cortex config` and `cortex maintain` commands.

## Lifecycle Hooks

Hooks are registered in `~/.claude/settings.json` during init. They also install session wrappers for Copilot CLI, Cursor, and Codex.

| Hook | Event | What it does |
|------|-------|-------------|
| `hook-session-start` | SessionStart | Pulls latest cortex changes (`git pull --rebase`), runs doctor self-heal, schedules daily maintenance. |
| `hook-prompt` | UserPromptSubmit | Extracts keywords from the user's prompt, searches cortex, injects relevant context snippets. Checks consolidation thresholds and fires a one-time notice per session. |
| `hook-stop` | Stop | Auto-commits and pushes `~/.cortex` changes after every agent response. |
| `hook-context` | SessionStart | Detects the current project from cwd and injects its CLAUDE.md and summary. |

## Modes

Toggle MCP and hooks independently:

```bash
cortex mcp-mode on|off|status
cortex hooks-mode on|off|status
```

When MCP is off but hooks are on, cortex still injects context via hooks (no MCP tools available to the agent). When hooks are off, the hook commands exit immediately without doing work.

## Memory Governance Pipeline

cortex includes a trust filtering system that scores and ages memory entries before injection.

### Decay Curve

Findings lose confidence as they age. The default decay multipliers:

| Age | Multiplier | Effect |
|-----|-----------|--------|
| 0-30 days | 1.0 | Full confidence |
| 30-60 days | 0.85 | Slightly reduced |
| 60-90 days | 0.65 | Moderate reduction |
| 90-120 days | 0.45 | Low confidence |
| 120+ days | 0.0 | Expired (prunable) |

These values are configurable via `cortex config policy` or the `retention-policy.json` governance file.

### Citation Validation

Findings can include source citations (`file:line@commit`). The trust filter validates that cited files exist and optionally checks git history. Entries with invalid citations are flagged and queued for review.

### Canonical Locks

Entries in `CANONICAL_MEMORIES.md` are protected from pruning and decay. Use `pin_memory` to promote high-value findings that should persist indefinitely.

### Audit Trail

All governance actions (scans, prunes, migrations, feedback) are logged to `.runtime/audit.log` with timestamps and actor information. The `CORTEX_ACTOR` env var identifies who performed the action.

### Quality Feedback Loop

The hook-prompt system tracks which memories get injected and whether they correlate with productive sessions. The `memory_feedback` tool lets agents record explicit outcomes:

- **helpful**: the memory contributed to the task
- **reprompt**: the memory was injected again (indicates ongoing relevance)
- **regression**: the memory caused confusion or incorrect behavior

Feedback scores feed back into the trust multiplier for future injections.

## Environment Variables

See [docs/environment.md](environment.md) for the full reference.
