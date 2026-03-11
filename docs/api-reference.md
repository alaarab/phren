# MCP API Reference

Cortex exposes 51 tools through the Model Context Protocol. Available to any MCP-compatible client when the cortex server is running.

All tools return structured JSON: `{ ok, message, data?, error? }`.

---

## Search and Browse

### `get_memory_detail`

Fetch the full content of a specific memory entry by its ID. This is Layer 3 of the progressive disclosure system: when `CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE=1`, the hook-prompt injects a compact memory index instead of full snippets for 3+ results. Use this tool to expand any entry from that index.

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

### `get_project_summary`

Get a project's summary card and list of indexed documents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Project name (e.g. "my-app", "backend"). |

### `list_projects`

List all projects in the active cortex profile with a brief summary of each. Shows which documentation files exist per project.

No parameters.

### `get_findings`

List recent findings for a project without requiring a search query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `limit` | number | no | Max rows to return (1-200, default 50). |

---

## Task Management

### `get_tasks`

Get the task for a project, or all projects if no name is given. Supports progressive disclosure: use `summary:true` for lightweight planning views (~200 tokens), pagination for browsing, or `id` with a stable `bid:` hash for single-item fetches during execution. See [Context Optimization](context-optimization.md) for the full pattern.

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
| `project` | string | yes | Project name (must match a directory in your cortex). |
| `item` | string | yes | The task to add. |

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

### `complete_tasks`

Move multiple task items to Done in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `items` | string[] | yes | List of partial item texts to complete. |

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
| `repo` | string | no | Target GitHub repo in `owner/name` form. If omitted, cortex tries to infer it from the project's `CLAUDE.md` or `summary.md`. |
| `title` | string | no | Optional GitHub issue title. Defaults to the task item text. |
| `body` | string | no | Optional GitHub issue body. Defaults to a body built from the task item plus any `Context:` line. |
| `mark_done` | boolean | no | If true, mark the task item Done after creating and linking the issue. |

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
| `findingType` | enum | no | Prefix the finding inline with a type tag. One of: `decision`, `pitfall`, `pattern`, `tradeoff`, `architecture`, `bug`. |

### `add_findings`

Record multiple insights to a project's FINDINGS.md in one call. FTS index rebuilds once at the end.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `findings` | string[] | yes | List of insights to record. |
| `sessionId` | string | no | Optional session ID from `session_start`. Pass it if you want session metrics to include these writes. |

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

Commit and push any changes in the cortex repo.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | no | Commit message. Defaults to "update cortex". |

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

Bootstraps a repo or working directory into cortex and adds it to the active profile. Pass the path explicitly; when no `profile` is provided, cortex uses `CORTEX_PROFILE` or the current machine mapping from `machines.yaml`.
Creates or copies `CLAUDE.md`, `summary.md`, `FINDINGS.md`, and `tasks.md` under `~/.cortex/<project>`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path to import. Pass the current repo path explicitly. |
| `profile` | string | no | Profile to update. Defaults to the active profile. |

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

## Entity Graph

### `search_entities`

Find entities and related docs by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Entity name to search for. |

### `get_related_docs`

Get docs linked to a named entity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Entity name to look up related documents for. |

### `read_graph`

Read the entity graph for a project or all projects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to read the graph across all projects. |

### `link_findings`

Manually link a finding to an entity. The link persists to `manual-links.json` and survives graph rebuilds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding_text` | string | yes | Text of the finding to link. |
| `entity` | string | yes | Entity name to link to. |
| `relation` | string | no | Relationship type (e.g. "mentions", "implements"). |

### `cross_project_entities`

Find entities that appear in multiple projects. Useful for discovering shared patterns and dependencies.

No parameters.

---

## Session Management

### `session_start`

Mark the start of a session. Returns the prior session summary, recent findings, and active task. Designed for agents without lifecycle hooks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name to scope the session to. |
| `connectionId` | string | no | Optional stable client identifier. Bind once at `session_start`, then use it instead of passing `sessionId` every time. |

### `session_end`

Mark the end of a session and save a summary for the next session. Reports duration and number of findings added during the session.

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

---

## Skills Management

### `list_skills`

List all installed skills with metadata (name, description, scope).

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

---

## Hooks Management

### `list_hooks`

Show hook enable/disable status for all tools (claude, copilot, cursor, codex), custom hooks, and config file paths.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Include project-level lifecycle hook overrides from `<cortexPath>/<project>cortex.project.yaml`. |

### `toggle_hooks`

Enable or disable hooks globally, for a specific tool, or for a tracked project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `enabled` | boolean | yes | Whether to enable or disable hooks. |
| `tool` | string | no | Specific tool to toggle (e.g. "claude", "cursor"). Omit for global toggle. |
| `project` | string | no | Tracked project name for project-level lifecycle hook overrides. |
| `event` | string | no | Optional lifecycle event for a project override: `UserPromptSubmit`, `Stop`, `SessionStart`, `PostToolUse`. Requires `project`. |

### `add_custom_hook`

Add a custom integration hook that runs on cortex events.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event` | string | yes | Hook event (e.g. "pre-finding", "post-finding", "pre-save", "post-save"). |
| `command` | string | yes | Shell command to execute. |
| `timeout` | number | no | Timeout in milliseconds. |

### `remove_custom_hook`

Remove custom hooks by event and optional command match.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event` | string | yes | Hook event to remove. |
| `command` | string | no | Specific command to remove. Omit to remove all hooks for the event. |

---

Governance, policy, and maintenance tools are CLI-only. See `cortex config` and `cortex maintain`.
