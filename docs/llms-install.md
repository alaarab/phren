# phren: LLM Installation Guide

phren keeps project memory portable across sessions and machines. It runs as an MCP server and a set of lifecycle hooks.

## Quick Start

```bash
npx @phren/cli init
```

No global install needed — `npx` runs it directly. On Windows, if `npx` isn't available, use `npm install -g @phren/cli && phren init`.

Preview what init will do without making changes:

```bash
npx @phren/cli init --dry-run
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

## Team Stores

Phren supports shared team stores for collaborative knowledge. A team store is a separate git repo that multiple people push to.

Create a team store:

```bash
phren team init my-team --remote git@github.com:org/phren-team.git
phren team add-project my-team my-project
```

Join an existing team store:

```bash
phren team join git@github.com:org/phren-team.git
```

List registered stores:

```bash
phren team list
```

Team stores sync independently via git. Findings and tasks in a team store are visible to all members through federated search and context injection.

## Maintenance Safety

Destructive maintenance commands (`prune` and `consolidate`) should be run with `--dry-run` first. On write paths that rewrite `FINDINGS.md`, phren creates/updates `FINDINGS.md.bak` and reports changed backup paths (for example, `Updated backups (1): <project>/FINDINGS.md.bak`). `--dry-run` previews changes without creating backups.

## MCP Tools (53)

### Search and Browse

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_knowledge` | `query`, `type?`, `limit?`, `project?`, `tag?`, `since?`, `status?`, `include_history?`, `synthesize?` | FTS5 full-text search across your project store. Supports AND, OR, NOT, phrase matching. Filter by tag, date, or lifecycle status. |
| `get_memory_detail` | `id` | Fetch full content of a memory by id (e.g. `mem:project/filename`). |
| `get_project_summary` | `name` | Returns a project's summary card, CLAUDE.md path, and list of indexed files. |
| `list_projects` | `page?`, `page_size?` | Lists all projects in the active profile with pagination. |
| `get_findings` | `project`, `limit?`, `include_superseded?`, `include_history?`, `status?` | Read recent findings, filterable by lifecycle status. |

### Task Management (`task` tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_tasks` | `project?`, `id?`, `item?`, `status?`, `limit?`, `done_limit?`, `offset?`, `summary?` | Read tasks with pagination, summary mode, and section filtering. |
| `add_task` | `project`, `item: string \| string[]` | Add one or more tasks to a project's Queue section. Pass a string or array. |
| `complete_task` | `project`, `item: string \| string[]` | Move one or more tasks to Done by text match. Pass a string or array. |
| `remove_task` | `project`, `item: string \| string[]` | Remove one or more tasks by matching text or ID. Pass a string or array. |
| `update_task` | `project`, `item?`, `updates` | Update text, priority, context, section, GitHub metadata, pin, promote, or work_next. Item optional when work_next is true. |
| `tidy_done_tasks` | `project`, `keep?`, `dry_run?` | Archive completed tasks to keep the list clean. |

### Finding Capture

| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_finding` | `project`, `finding: string \| string[]`, `citation?`, `sessionId?`, `source?`, `findingType?`, `scope?` | Append one or more insights. Pass a string or array. Citation, provenance, type tag, and scope apply to single-string mode. |
| `supersede_finding` | `project`, `finding_text`, `superseded_by` | Mark a finding as superseded by a newer one. |
| `retract_finding` | `project`, `finding_text`, `reason` | Retract a finding and store lifecycle reason metadata. |
| `resolve_contradiction` | `project`, `finding_text`, `finding_text_other`, `resolution` | Resolve contradiction status between two findings (`keep_a`, `keep_b`, `keep_both`, `retract_both`). |
| `get_contradictions` | `project?`, `finding_text?` | List unresolved contradicted findings across one project or all projects, optionally filtered by selector. |
| `edit_finding` | `project`, `old_text`, `new_text` | Edit a finding in place while preserving inline metadata such as `fid` and citations. |
| `remove_finding` | `project`, `finding: string \| string[]` | Remove one or more findings by text match. Pass a string or array. |
| `push_changes` | `message?` | Commit and push all phren changes. Retries with rebase on push conflicts. |
| `auto_extract_findings` | `project`, `text`, `model?`, `dryRun?` | Extract findings from text (max 10000 chars). |

### Memory Quality

| Tool | Parameters | Description |
|------|-----------|-------------|
| `pin_memory` | `project`, `memory` | Write a truth into truths.md. Never decays, always prepended to context. |
| `get_truths` | `project` | Read all pinned truths for a project. |
| `memory_feedback` | `key`, `feedback` | Record whether an injected memory was `helpful`, a `reprompt`, or a `regression`. |

### Data Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_project` | `path`, `profile?`, `ownership?` | Bootstrap a repo or working directory into phren and add it to the active profile. |
| `export_project` | `project` | Export a project's data (findings, tasks, summary) as portable JSON. |
| `import_project` | `data` | Import project data from a previously exported JSON payload. |
| `manage_project` | `project`, `action` | Archive or unarchive a project. |

### Fragment Graph

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_fragments` | `query`, `project?`, `limit?` | Find fragments and related docs by name. |
| `get_related_docs` | `entity`, `project?`, `limit?` | Get docs linked to a named fragment. |
| `read_graph` | `project?`, `limit?`, `offset?` | Read the fragment graph with pagination. |
| `link_findings` | `project`, `finding_text`, `entity`, `relation?`, `entity_type?` | Manually link a finding to a fragment. |
| `cross_project_fragments` | `entity`, `exclude_project?`, `limit?` | Find fragments shared across multiple projects. |

### Session Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `session_start` | `project?`, `agentScope?`, `connectionId?` | Mark session start. Returns prior summary, recent findings, active tasks, checkpoint resume hints, and a `sessionId`. |
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
| `toggle_skill` | `name`, `enabled`, `project` | Enable or disable a skill without deleting its file. |

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
| `add_custom_hook` | `event`, `command?`, `webhook?`, `secret?`, `timeout?` | Add a custom integration hook (command or webhook). |
| `remove_custom_hook` | `event`, `command?` | Remove custom hooks by event/command match. |

### Health and Review

| Tool | Parameters | Description |
|------|-----------|-------------|
| `health_check` | `include_consolidation?` | Run doctor checks and return health status including consolidation status for all projects. |
| `list_hook_errors` | `limit?` | Show recent hook errors and failures. |
| `get_review_queue` | `project?` | Read items waiting for review. The review queue is read-only. |
| `manage_review_item` | `project`, `line`, `action`, `new_text?` | Manage a review queue item: approve (removes from queue), reject (removes from queue and FINDINGS.md), or edit (updates text in both; `new_text` required for edit). |
| `doctor_fix` | `check_data?` | Run doctor self-heal checks and apply fixes automatically. |

### Configuration

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_config` | `domain?`, `project?` | Read governance and policy config (proactivity, taskMode, findingSensitivity, retention, workflow, access, index, topic, or all). |
| `set_config` | `domain`, `settings`, `project?` | Update config for a domain (proactivity, taskMode, findingSensitivity, retention, workflow, index, topic). |

Maintenance tools are CLI-only. Use `phren config` and `phren maintain` commands.

## Lifecycle Hooks and Integrations

Claude receives full native lifecycle hooks in `~/.claude/settings.json`.
Copilot CLI, Cursor, and Codex receive generated hook config files plus session wrappers in `~/.local/bin` so start/stop lifecycle behavior still executes around each tool run.

| Hook | Event | What it does |
|------|-------|-------------|
| `hook-session-start` | SessionStart | Pulls latest phren changes (`git pull --rebase`), runs doctor self-heal, schedules daily maintenance. |
| `hook-prompt` | UserPromptSubmit | Extracts keywords from the user's prompt, searches phren, injects relevant context snippets. Checks consolidation thresholds and fires a one-time notice per session. |
| `hook-tool` | PostToolUse | Watches Claude tool results and queues compact review candidates from interesting file/command activity. |
| `hook-stop` | Stop | Auto-commits and pushes `~/.phren` changes after every agent response. |
| `hook-context` | SessionStart | Detects the current project from cwd and injects its CLAUDE.md and summary. |

Tool integration summary:
- Claude: full lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PostToolUse`) + MCP
- Copilot/Cursor/Codex: MCP + wrapper-driven lifecycle + generated per-tool hook config

Important:
- Lifecycle hooks do retrieval and persistence, but they do not create `session_history` records on their own. Agents still need to call `session_start` / `session_end` when resumable session history, checkpoints, or provenance matter.

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

Lifecycle state also applies retrieval penalties so stale or invalid findings rank lower:
- Superseded findings: 0.25× confidence multiplier
- Retracted findings: 0.1× confidence multiplier
- Contradicted (unresolved) findings: 0.4× confidence multiplier

Inactive findings (superseded, retracted) are also stripped from the FTS index so they cannot appear in search results at all.

### Decay Resistance

Findings that have been repeatedly confirmed or injected into productive sessions accumulate a decay-resistance boost, causing them to decay 3× slower than the default curve.

### Auto-Tagging

Findings without an explicit type tag are auto-detected from content at write time:
- "We decided..." → `[decision]`
- "Watch out for..." or "gotcha:..." → `[pitfall]`
- "Pattern:..." or "always ... before..." → `[pattern]`
- "Bug in..." or "crashes when..." → `[bug]`
- "Workaround:..." or "temporary fix" → `[workaround]`
- "Currently..." or "as of..." → `[context]`

Auto-tagged findings can be corrected by using `findingType` in `add_finding` or by manually editing the type prefix.

### Session Context Diff

On `session_start`, phren reports how many new findings were added since the previous session, giving the agent a quick summary of what changed between sessions without re-reading the full findings file.

### Snippet Deduplication

When the same bullet appears in both a project findings file and the global findings file, phren injects it only once to avoid redundant context.

### Session Momentum

Topics that are frequently queried within a session get up to 30% more of the token budget for context injection, keeping hot topics well-represented as work progresses.

### Truth Locks

Entries in `truths.md` are protected from pruning and decay. Use `pin_memory` to save high-value findings that should persist indefinitely.

### Audit Trail

All governance actions (scans, prunes, migrations, feedback) are logged to `.runtime/audit.log` with timestamps and actor information. The `PHREN_ACTOR` env var identifies who performed the action.

### Identity and RBAC

Access control is role-based (`admin`, `maintainer`, `contributor`, `viewer`):
- shared policy: `.config/access-control.json`
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
