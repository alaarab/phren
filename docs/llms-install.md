# cortex: LLM Installation Guide

cortex gives AI coding agents persistent memory across sessions and machines. It runs as an MCP server and a set of lifecycle hooks.

## Quick Start

```bash
npx @alaarab/cortex init
npx @alaarab/cortex init --dry-run
```

This creates `~/.cortex`, configures MCP for Claude Code (and any detected agents: VS Code, Cursor, Copilot CLI, Codex), and wires up lifecycle hooks.

To update an existing install:

```bash
npx @alaarab/cortex init --apply-starter-update
```

To remove everything:

```bash
npx @alaarab/cortex uninstall
```

## Migration and Safety

Use migration commands when upgrading old governance/data layouts:

```bash
# preview governance schema migrations (no writes)
cortex maintain migrate governance --dry-run

# apply governance schema migrations
cortex maintain migrate governance

# preview legacy findings migration for one project
cortex maintain migrate data <project> --dry-run

# migrate legacy findings and pin high-signal entries as canonical
cortex maintain migrate data <project> --pin

# run both governance + data migration paths
cortex maintain migrate all <project> --dry-run

# equivalent alias for data migration
cortex migrate-findings <project> --dry-run
```

Destructive maintenance commands (`prune`, `consolidate`, and non-dry-run migrations) should be run with `--dry-run` first. On write paths that rewrite `LEARNINGS.md`, cortex creates/updates `LEARNINGS.md.bak` and reports changed backup paths (for example, `Updated backups (1): <project>/LEARNINGS.md.bak`). `--dry-run` previews changes without creating backups.

## MCP Tools (22)

### Search and Browse

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_cortex` | `query`, `type?`, `limit?`, `project?` | FTS5 full-text search across your knowledge base. Supports AND, OR, NOT, phrase matching. |
| `get_project_summary` | `name` | Returns a project's summary card, CLAUDE.md path, and list of indexed files. |
| `list_projects` | (none) | Lists all projects in the active profile with doc badges and brief descriptions. |
| `list_machines` | (none) | Shows registered machines and which profile each uses. |
| `list_profiles` | (none) | Shows all profiles and their project lists. |

### Backlog Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_backlog` | `project?` | Read the backlog for one project, or all projects if omitted. |
| `add_backlog_item` | `project`, `item` | Append a task to a project's backlog Queue section. |
| `complete_backlog_item` | `project`, `item` | Move a backlog item to Done by text match. |
| `update_backlog_item` | `project`, `item`, `updates` | Update an item's priority, context, or section. |

### Learning Capture

| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_learning` | `project`, `learning`, `citation_file?`, `citation_line?`, `citation_repo?`, `citation_commit?` | Append an insight to LEARNINGS.md with optional source citation. |
| `remove_learning` | `project`, `learning` | Remove a learning by text match. Use when an insight is wrong or outdated. |
| `save_learnings` | `message?` | Commit and push all cortex changes. Retries with rebase on push conflicts. |

### Memory Governance

| Tool | Parameters | Description |
|------|-----------|-------------|
| `pin_memory` | `project`, `memory` | Promote an important memory into CANONICAL_MEMORIES.md for priority retrieval. |
| `govern_memories` | `project?` | Scan learnings and queue stale, citation-conflicting, or low-value entries into MEMORY_QUEUE.md. Also runs deduplication. |
| `prune_memories` | `project?` | Delete expired entries based on retention policy. |
| `consolidate_memories` | `project?` | Deduplicate LEARNINGS.md bullets for one or all projects. |
| `memory_feedback` | `key`, `feedback` | Record whether an injected memory was `helpful`, a `reprompt`, or a `regression`. |
| `migrate_legacy_findings` | `project`, `pinCanonical?`, `dryRun?` | Promote legacy findings/retro docs into LEARNINGS.md and optionally CANONICAL_MEMORIES.md. |

### Policy Configuration

| Tool | Parameters | Description |
|------|-----------|-------------|
| `memory_policy` | `mode`, `ttlDays?`, `retentionDays?`, `autoAcceptThreshold?`, `minInjectConfidence?`, `decay_d30?`/`d60?`/`d90?`/`d120?` | Read or update retention, TTL, confidence thresholds, and decay curve. |
| `memory_workflow` | `mode`, `requireMaintainerApproval?`, `lowConfidenceThreshold?`, `riskySections?` | Read or update the approval workflow for risky memory sections. |
| `memory_access` | `mode`, `admins?`, `maintainers?`, `contributors?`, `viewers?` | Read or update role-based memory access control. |
| `index_policy` | `mode`, `includeGlobs?`, `excludeGlobs?`, `includeHidden?` | Configure which files the indexer includes or excludes. |

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
npx @alaarab/cortex mcp-mode on|off|status
npx @alaarab/cortex hooks-mode on|off|status
```

When MCP is off but hooks are on, cortex still injects context via hooks (no MCP tools available to the agent). When hooks are off, the hook commands exit immediately without doing work.

## Memory Governance Pipeline

cortex includes a trust filtering system that scores and ages memory entries before injection.

### Decay Curve

Learnings lose confidence as they age. The default decay multipliers:

| Age | Multiplier | Effect |
|-----|-----------|--------|
| 0-30 days | 1.0 | Full confidence |
| 30-60 days | 0.85 | Slightly reduced |
| 60-90 days | 0.65 | Moderate reduction |
| 90-120 days | 0.45 | Low confidence |
| 120+ days | 0.0 | Expired (prunable) |

These values are configurable via `memory_policy` or the `memory-policy.json` governance file.

### Citation Validation

Learnings can include source citations (`file:line@commit`). The trust filter validates that cited files exist and optionally checks git history. Entries with invalid citations are flagged and queued for review.

### Canonical Locks

Entries in `CANONICAL_MEMORIES.md` are protected from pruning and decay. Use `pin_memory` to promote high-value learnings that should persist indefinitely.

### Audit Trail

All governance actions (scans, prunes, migrations, feedback) are logged to `.governance/audit.log` with timestamps and actor information. The `CORTEX_ACTOR` env var identifies who performed the action.

### Quality Feedback Loop

The hook-prompt system tracks which memories get injected and whether they correlate with productive sessions. The `memory_feedback` tool lets agents record explicit outcomes:

- **helpful**: the memory contributed to the task
- **reprompt**: the memory was injected again (indicates ongoing relevance)
- **regression**: the memory caused confusion or incorrect behavior

Feedback scores feed back into the trust multiplier for future injections.

## Environment Variables

See [docs/environment.md](environment.md) for the full reference.
