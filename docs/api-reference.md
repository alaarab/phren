# MCP API Reference

Cortex exposes 40 tools through the Model Context Protocol. Available to any MCP-compatible client when the cortex server is running.

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
| `type` | enum | no | Filter by document type. One of: `claude`, `findings`, `reference`, `skills`, `summary`, `backlog`, `changelog`, `canonical`, `memory-queue`, `skill`, `other`. |

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

## Backlog Management

### `get_backlog`

Get the backlog for a project, or all projects if no name is given. Supports progressive disclosure: use `summary:true` for lightweight planning views (~200 tokens), pagination for browsing, or `id` with a stable `bid:` hash for single-item fetches during execution. See [Context Optimization](context-optimization.md) for the full pattern.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to get all projects. |
| `id` | string | no | Backlog item ID. Accepts positional IDs (A1, Q3, D2) or stable `bid:XXXXXXXX` hashes. Requires project. Stable hashes are preferred for cross-session references because positional IDs shift when items complete. |
| `item` | string | no | Exact backlog item text. Requires project. |
| `summary` | boolean | no | If true, return counts and titles only (no full content). Reduces token usage to ~200 tokens. Use for planning and status checks. |
| `limit` | number | no | Max items per Active/Queue section to return (1-200, default 20). Use with `offset` for pagination. |
| `done_limit` | number | no | Max Done items to return, most recent first (1-200, default 5). Done sections are capped tightly by default to avoid large responses. |
| `offset` | number | no | Skip the first N items in each section before applying limit. Use with `limit` for pagination (e.g. offset:20, limit:20 for page 2). |
| `status` | enum | no | Filter by section: `all`, `active`, `queue`, `done`, `active+queue` (default). |

### `add_backlog_item`

Append a task to a project's backlog. Adds to the Queue section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name (must match a directory in your cortex). |
| `item` | string | yes | The task to add. |

### `add_backlog_items`

Append multiple tasks to a project's backlog in one call. Adds to the Queue section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `items` | string[] | yes | List of tasks to add. |

### `complete_backlog_item`

Move a backlog item to the Done section by matching text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Exact or partial text of the item to complete. |

### `complete_backlog_items`

Move multiple backlog items to Done in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `items` | string[] | yes | List of partial item texts to complete. |

### `update_backlog_item`

Update a backlog item's priority, context, or section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Partial text to match against existing backlog items. |
| `updates` | object | yes | Fields to update (all optional inside the object). |

The `updates` object accepts:

| Field | Type | Description |
|-------|------|-------------|
| `priority` | string | New priority tag: `high`, `medium`, or `low`. |
| `context` | string | Text to append to the Context line below the item. |
| `section` | string | Move item to this section: `Queue`, `Active`, or `Done`. |

---

## Finding Capture

### `add_finding`

Record a single insight to a project's FINDINGS.md. Call this the moment you discover a non-obvious pattern, hit a subtle bug, or find a workaround.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding` | string | yes | The insight, as a single bullet point. Be specific enough to act on without extra context. |
| `citation` | object | no | Optional source citation: `{ file?, line?, repo?, commit? }`. |
| `findingType` | enum | no | Prefix the finding inline with a type tag. One of: `decision`, `pitfall`, `pattern`. |

### `add_findings`

Record multiple insights to a project's FINDINGS.md in one call. FTS index rebuilds once at the end.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `findings` | string[] | yes | List of insights to record. |

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

### `export_project`

Export a project's data (findings, backlog, summary, CLAUDE.md) as portable JSON.

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

Mark the start of a session. Returns the prior session summary, recent findings, and active backlog. Designed for agents without lifecycle hooks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name to scope the session to. |

### `session_end`

Mark the end of a session and save a summary for the next session. Reports duration and number of findings added during the session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `summary` | string | no | Free-text summary of what was accomplished. |

### `session_context`

Get the current session state including project, duration, and findings added so far.

No parameters.

---

Governance, policy, and maintenance tools are CLI-only. See `cortex config` and `cortex maintain`.
