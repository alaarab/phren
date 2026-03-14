# MCP API Reference

Phren exposes 60 MCP tools across 11 modules through the Model Context Protocol. These are available to any MCP-compatible client when the phren server is running.

All tools return structured JSON: `{ ok, message, data?, error? }`.

Module layout: search, tasks, findings, memory quality, data management, fragment graph, sessions, operations/review, skills, hooks, extraction.

---

## Search and Browse

### `get_memory_detail`

Fetch the full content of a specific memory entry by its ID. This is Layer 3 of the progressive disclosure system: when `PHREN_FEATURE_PROGRESSIVE_DISCLOSURE=1`, the hook-prompt injects a compact memory index instead of full snippets for 3+ results. Use this tool to expand any entry from that index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Memory ID in the format `mem:project/filename` (e.g. `mem:my-app/FINDINGS.md`). Returned by the hook-prompt compact index. |

---

### `search_knowledge`

Search the user's personal project store using FTS5 full-text search with synonym expansion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query. Supports FTS5 syntax: AND, OR, NOT, phrase matching with quotes. |
| `limit` | number | no | Max results to return (1-20, default 5). |
| `project` | string | no | Filter results to a specific project. |
| `type` | enum | no | Filter by document type. One of: `claude`, `findings`, `reference`, `skills`, `summary`, `task`, `changelog`, `canonical`, `memory-queue`, `skill`, `other`. |
| `tag` | enum | no | Filter findings by type tag: `decision`, `pitfall`, `pattern`, `tradeoff`, `architecture`, `bug`. |
| `since` | string | no | Filter findings by creation date. Formats: `7d`, `30d`, `YYYY-MM`, `YYYY-MM-DD`. |
| `status` | enum | no | Filter findings by lifecycle status: `active`, `superseded`, `contradicted`, `stale`, `invalid_citation`, `retracted`. |
| `include_history` | boolean | no | Include historical findings (`superseded`, `retracted`). Defaults to `false`. |
| `synthesize` | boolean | no | Generate a short synthesis paragraph from top hits (requires LLM endpoint/key configuration). |

### `get_project_summary`

Get a project's summary card and list of indexed documents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Project name (e.g. "my-app", "backend"). |

### `list_projects`

List all projects in the active phren profile with a brief summary of each. Shows which documentation files exist per project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | number | no | 1-based page number (default 1). |
| `page_size` | number | no | Results per page (default 20, max 50). |

### `get_findings`

List recent findings for a project without requiring a search query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `limit` | number | no | Max rows to return (1-200, default 50). |
| `include_superseded` | boolean | no | Include superseded findings (legacy compatibility flag). |
| `include_history` | boolean | no | Include historical findings (`superseded`, `retracted`). |
| `status` | enum | no | Filter by lifecycle status: `active`, `superseded`, `contradicted`, `stale`, `invalid_citation`, `retracted`. |

---

## Task Management

### `get_tasks`

Get tasks for a project (or all projects). Supports progressive disclosure: use `summary:true` for lightweight planning views (~200 tokens), pagination for browsing, or `id` with a stable `bid:` hash for single-item fetches during execution. Stable IDs are also used by cross-session task checkpoints.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to get all projects. |
| `id` | string | no | Task item ID. Accepts positional IDs (A1, Q3, D2) or stable `bid:XXXXXXXX` hashes. Requires project. Stable hashes are preferred for cross-session references because positional IDs shift when items complete. |
| `item` | string | no | Exact task item text. Requires project. |
| `summary` | boolean | no | If true, return counts and titles only (no full content). Reduces token usage to ~200 tokens. Use for planning and status checks. |
| `limit` | number | no | Max items per Active/Queue section to return (1-200, default 20). Use with `offset` for pagination. |
| `done_limit` | number | no | Max Done items to return, most recent first (1-200, default 5). Done sections are capped tightly by default to avoid large responses. |
| `offset` | number | no | Skip the first N items in each section before applying limit. Use with `limit` for pagination (e.g. offset:20, limit:20 for page 2). |
| `status` | enum | no | Filter by section: `all`, `active`, `queue`, `done`, `active+queue` (default). |

### `add_task`

Append a task to a project's task. Adds to the Queue section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name (must match a directory in your phren). |
| `item` | string | yes | The task to add. |
| `scope` | string | no | Optional memory scope label (defaults to `shared`; for example `researcher` or `builder`). |

### `add_tasks`

Append multiple tasks to a project's task in one call. Adds to the Queue section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `items` | string[] | yes | List of tasks to add. |

### `complete_task`

Move a task item to the Done section by matching text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Exact or partial text of the item to complete. |
| `sessionId` | string | no | Optional session ID from `session_start` for per-session completion metrics. |

When a task is completed, phren clears any checkpoint file associated with that task.

### `complete_tasks`

Move multiple task items to Done in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `items` | string[] | yes | List of partial item texts to complete. |
| `sessionId` | string | no | Optional session ID from `session_start` for per-session completion metrics. |

When tasks are completed, phren clears matching checkpoint files for those task IDs.

### `remove_task`

Remove a task from a project's `tasks.md` by matching text or task ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Exact/partial task text, or task ID like `A1`, `Q3`, `D2`. |

### `update_task`

Update a task item's priority, context, section, or linked GitHub issue.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Partial text to match against existing task items. |
| `updates` | object | yes | Fields to update (all optional inside the object). |

The `updates` object accepts:

| Field | Type | Description |
|-------|------|-------------|
| `priority` | string | New priority tag: `high`, `medium`, or `low`. |
| `context` | string | Text to append to the Context line below the item. |
| `replace_context` | boolean | Replace the existing `Context:` value instead of appending. |
| `section` | string | Move item to this section: `Queue`, `Active`, or `Done`. |
| `github_issue` | number or string | GitHub issue number (for example `14` or `#14`). |
| `github_url` | string | GitHub issue URL to associate with the item. |
| `unlink_github` | boolean | Remove any linked issue metadata from the item. |

### `link_task_issue`

Link or unlink an existing GitHub issue on a task item.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Task item text, ID, or stable `bid:` hash. |
| `issue_number` | number or string | no | Existing GitHub issue number (for example `14` or `#14`). |
| `issue_url` | string | no | Existing GitHub issue URL. |
| `unlink` | boolean | no | If true, remove any linked issue metadata from the task item. |

### `promote_task_to_issue`

Create a GitHub issue from a task item and link it back into the task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Task item text, ID, or stable `bid:` hash. |
| `repo` | string | no | Target GitHub repo in `owner/name` form. If omitted, phren tries to infer it from the project's `CLAUDE.md` or `summary.md`. |
| `title` | string | no | Optional GitHub issue title. Defaults to the task item text. |
| `body` | string | no | Optional GitHub issue body. Defaults to a body built from the task item plus any `Context:` line. |
| `mark_done` | boolean | no | If true, mark the task item Done after creating and linking the issue. |

### `pin_task`

Pin a task so it floats to the top of its section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Partial task text or task ID to pin. |

### `work_next_task`

Move the highest-priority Queue item to Active so it becomes the next task to execute.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |

### `promote_task`

Promote a speculative task to committed by clearing the speculative flag. Optionally move it to Active.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Task selector by partial text, positional ID, or stable `bid:` ID. |
| `move_to_active` | boolean | no | If true, move the promoted task to Active. Defaults to false. |

### `tidy_done_tasks`

Archive older Done items beyond a keep threshold to keep task lists short.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `keep` | number | no | Number of recent Done items to keep (default 30). |
| `dry_run` | boolean | no | Preview what would change without writing. |

---

## Finding Capture

### `add_finding`

Record a single insight to a project's FINDINGS.md. Call this the moment you discover a non-obvious pattern, hit a subtle bug, or find a workaround.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding` | string | yes | The insight, as a single bullet point. Be specific enough to act on without extra context. |
| `citation` | object | no | Optional source citation: `{ file?, line?, repo?, commit?, task_item? }`. |
| `sessionId` | string | no | Optional session ID from `session_start`. Pass it if you want session metrics to include this write. |
| `source` | enum | no | Optional finding provenance source: `human`, `agent`, `hook`, `extract`, `consolidation`, `unknown`. |
| `findingType` | enum | no | Prefix the finding inline with a type tag. One of: `decision`, `pitfall`, `pattern`, `tradeoff`, `architecture`, `bug`. |
| `scope` | string | no | Optional memory scope label (defaults to `shared`; for example `researcher` or `builder`). |

### `add_findings`

Record multiple insights to a project's FINDINGS.md in one call. FTS index rebuilds once at the end.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `findings` | string[] | yes | List of insights to record. |
| `sessionId` | string | no | Optional session ID from `session_start`. Pass it if you want session metrics to include these writes. |

### `supersede_finding`

Mark an existing finding as superseded by a newer finding.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding_text` | string | yes | Finding selector (supports `fid:`, exact text, or partial match). |
| `superseded_by` | string | yes | New finding text that supersedes the old one. |

### `retract_finding`

Retract an existing finding and record the reason in lifecycle metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding_text` | string | yes | Finding selector (supports `fid:`, exact text, or partial match). |
| `reason` | string | yes | Retraction reason. |

### `resolve_contradiction`

Resolve a contradiction between two findings and update lifecycle statuses.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding_text` | string | yes | First finding selector (`fid:`, exact text, or partial match). |
| `finding_text_other` | string | yes | Second finding selector (`fid:`, exact text, or partial match). |
| `resolution` | enum | yes | One of: `keep_a`, `keep_b`, `keep_both`, `retract_both`. |

### `get_contradictions`

List unresolved contradicted findings (status = `contradicted`) in one project or across all projects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Optional project filter. Omit to scan all projects. |
| `finding_text` | string | no | Optional finding selector (`fid:`, exact text, or partial match). |

### `remove_finding`

Remove a finding from FINDINGS.md by matching text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding` | string | yes | Partial text to match against existing findings. |

### `remove_findings`

Remove multiple findings from a project's FINDINGS.md in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `findings` | string[] | yes | List of partial texts to match and remove. |

### `push_changes`

Commit and push any changes in the phren repo.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | no | Commit message. Defaults to "update phren". |

Finding lifecycle and impact scoring notes:
- Lifecycle state is stored inline on finding bullets (for example: active, superseded, contradicted, retracted).
- Hook/context injection records which finding IDs were surfaced.
- `session_end` marks those entries as successful when tasks from that session reach Done, powering high-impact finding ranking.

---

## Memory Quality

### `pin_memory`

Promote an important memory into CANONICAL_MEMORIES.md so retrieval prioritizes it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `memory` | string | yes | Canonical memory text to pin. |

### `memory_feedback`

Record feedback on whether an injected memory was helpful or noisy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Memory key to score. |
| `feedback` | enum | yes | One of: `helpful`, `reprompt`, `regression`. |

---

## Data Management

### `add_project`

Bootstraps a repo or working directory into phren and adds it to the active profile. Pass the path explicitly; when no `profile` is provided, phren uses `PHREN_PROFILE` or the current machine mapping from `machines.yaml`.
Creates or copies `CLAUDE.md`, `summary.md`, `FINDINGS.md`, and `tasks.md` under `~/.phren/<project>`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path to import. Pass the current repo path explicitly. |
| `profile` | string | no | Profile to update. Defaults to the active profile. |
| `ownership` | enum | no | Repo-file ownership mode: `phren-managed`, `detached`, or `repo-managed`. |

### `export_project`

Export a project's data (findings, task, summary, CLAUDE.md) as portable JSON.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name to export. |

### `import_project`

Import project data from a previously exported JSON payload. Creates the project directory if needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | string | yes | JSON string from a previous `export_project` call. |

### `manage_project`

Archive or unarchive a project. Archive renames the directory with `.archived` suffix, removing it from the active index without deleting data.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `action` | enum | yes | `archive` or `unarchive`. |

---

## Fragment Graph

### `search_fragments`

Find fragments and related docs by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Fragment name to search for (partial match). |
| `project` | string | no | Optional project filter. |
| `limit` | number | no | Max results (default 10). |

### `get_related_docs`

Get docs linked to a named fragment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fragment` | string | yes | Fragment name to look up related documents for. |
| `project` | string | no | Optional project filter. |
| `limit` | number | no | Max docs to return (default 10). |

### `read_graph`

Read the fragment graph for a project or all projects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to read the graph across all projects. |
| `limit` | number | no | Max fragments to return (default 500, max 2000). |
| `offset` | number | no | Pagination offset (default 0). |

### `link_findings`

Manually link a finding to a fragment. The link persists to `manual-links.json` and survives graph rebuilds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding_text` | string | yes | Text of the finding to link. |
| `fragment` | string | yes | Fragment name to link to. |
| `relation` | string | no | Relationship type (e.g. "mentions", "implements"). |
| `fragment_type` | string | no | Fragment type label (for example `library`, `service`, `concept`, `architecture`). Defaults to `fragment`. |

### `cross_project_fragments`

Find fragments that appear in multiple projects. Useful for discovering shared patterns and dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fragment` | string | yes | Fragment name to search for (partial match). |
| `exclude_project` | string | no | Exclude one project from the result set. |
| `limit` | number | no | Max results (default 20). |

---

## Session Management

### `session_start`

Mark the start of a session. Returns prior summary, recent findings, active task context, and task checkpoints for resume guidance. Designed for agents without native lifecycle hooks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name to scope the session to. |
| `agentScope` | string | no | Optional memory scope for the session (for example `researcher` or `builder`). |
| `connectionId` | string | no | Optional stable client identifier. Bind once at `session_start`, then use it instead of passing `sessionId` every time. |

### `session_end`

Mark the end of a session and save a summary for the next session. Reports duration and findings added, writes a task checkpoint snapshot for active work, and updates finding impact outcomes when session tasks were completed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `summary` | string | no | Free-text summary of what was accomplished. |
| `sessionId` | string | no | Session ID returned by `session_start`. Required unless you pass `connectionId`. |
| `connectionId` | string | no | Stable client identifier previously passed to `session_start`. Required unless you pass `sessionId`. |

### `session_context`

Get the current session state including project, duration, and findings added so far.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | no | Session ID returned by `session_start`. Required unless you pass `connectionId`. |
| `connectionId` | string | no | Stable client identifier previously passed to `session_start`. Required unless you pass `sessionId`. |

### `session_history`

List recent sessions, or drill into one session to return artifacts (findings + tasks) linked to that session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | no | Max sessions to return (default 20). |
| `sessionId` | string | no | If provided, returns detailed artifacts for that session. |
| `project` | string | no | Optional project filter for listing or artifact drill-down. |

---

## Skills Management

### `list_skills`

List installed skills with resolved metadata (name, command, aliases, scope, enabled/visible state, command registration state).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Filter skills to a specific project. Omit to list all skills (global + per-project). |

### `read_skill`

Read the full content of a skill file including parsed frontmatter.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Skill name (e.g. "commit", "review-pr"). |
| `project` | string | no | Project scope. Omit to search global skills. |

### `write_skill`

Create or update a skill file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Skill name. |
| `content` | string | yes | Full skill file content (frontmatter + body). |
| `scope` | string | yes | Where to save: `global` or a project name. |

### `remove_skill`

Delete a skill file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Skill name to remove. |
| `project` | string | no | Project scope. Omit to remove from global skills. |

### `enable_skill`

Enable a skill without deleting its file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Skill name to enable. |
| `project` | string | yes | Skill scope: `global` or a project name. |

### `disable_skill`

Disable a skill without deleting its file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Skill name to disable. |
| `project` | string | yes | Skill scope: `global` or a project name. |

Skill resolution behavior:
- Source precedence: project scope overrides global scope for same skill name.
- Alias/command collisions are detected and marked unregistered in generated command output.
- Visibility gating: disabled skills stay on disk but are hidden from active agent links.
- Generated artifacts: `.claude/skill-manifest.json` and `.claude/skill-commands.json`.

---

## Hooks Management

### `list_hooks`

Show hook enable/disable status for all tools (claude, copilot, cursor, codex), custom hooks, and config paths.

Integration model:
- Claude uses full native lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `Stop`).
- Copilot/Cursor/Codex use generated hook config plus session wrappers that enforce start/stop lifecycle behavior around tool invocation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Include project-level lifecycle hook overrides from `<phrenPath>/<project>/phren.project.yaml`. |

### `toggle_hooks`

Enable or disable hooks globally, for a specific tool, or for a tracked project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `enabled` | boolean | yes | Whether to enable or disable hooks. |
| `tool` | string | no | Specific tool to toggle (e.g. "claude", "cursor"). Omit for global toggle. |
| `project` | string | no | Tracked project name for project-level lifecycle hook overrides. |
| `event` | string | no | Optional lifecycle event for a project override: `UserPromptSubmit`, `Stop`, `SessionStart`, `PostToolUse`. Requires `project`. |

### `add_custom_hook`

Add a custom integration hook that runs on phren events.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event` | string | yes | Hook event (e.g. "pre-finding", "post-finding", "pre-save", "post-save"). |
| `command` | string | no | Shell command to execute (use this or `webhook`, but not both). |
| `webhook` | string | no | HTTP POST URL for async webhook delivery (use this or `command`, but not both). |
| `secret` | string | no | Optional HMAC signing secret for webhook hooks (`X-Phren-Signature`). |
| `timeout` | number | no | Timeout in milliseconds. |

### `remove_custom_hook`

Remove custom hooks by event and optional command match.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event` | string | yes | Hook event to remove. |
| `command` | string | no | Specific command to remove. Omit to remove all hooks for the event. |

---

## Operations and Review

### `get_consolidation_status`

Check whether a project's `FINDINGS.md` has crossed consolidation thresholds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Optional project filter. Omit to check all projects. |

### `health_check`

Return runtime health status (version, profile, project count, index status, MCP/hooks state).

No parameters.

### `list_hook_errors`

Read recent hook/debug failures from runtime logs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | no | Max rows to return (default 20). |

### `get_review_queue`

Read review queue items for one project or all active-profile projects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Optional project filter. |

### `approve_queue_item`

Approve a review queue item.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Queue item selector text. |

### `reject_queue_item`

Reject a review queue item.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Queue item selector text. |

### `edit_queue_item`

Edit a review queue item.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Queue item selector text. |
| `new_text` | string | yes | Replacement queue item text. |

---

## Extraction

### `auto_extract_findings`

Extract candidate findings from session/transcript context for bulk capture workflows.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name to save findings to. |
| `text` | string | yes | Source text to mine for finding candidates (max 10,000 chars). |
| `model` | string | no | Optional Ollama model override. |
| `dryRun` | boolean | no | If true, return extracted candidates without writing findings. |

---

## Runtime Notes

### Governance identity and RBAC

- Actor identity is resolved from `PHREN_ACTOR` (in trusted/test contexts) or OS user identity.
- Access policy comes from `.governance/access-control.json` with local augmentation from `.runtime/access-control.local.json`.
- RBAC is enforced before write/policy/delete operations.

### Web UI security model

- Web UI binds loopback-only (`127.0.0.1`).
- A random per-run auth token is required.
- Mutating routes require CSRF tokens (single-use, TTL-bound).
- CSP and anti-framing response headers are set by default.

### Telemetry model

- Telemetry is opt-in (`phren config telemetry on`).
- Data is stored locally in `.runtime/telemetry.json`.
- No external reporting is sent by default.

---

Governance, policy, and maintenance tools are CLI-only. See `phren config` and `phren maintain`.
