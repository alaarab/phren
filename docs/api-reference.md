# MCP API Reference

Cortex exposes 19 tools through the Model Context Protocol. Available to any MCP-compatible client when the cortex server is running.

All tools return structured JSON: `{ ok, message, data?, error? }`.

---

## Search and Browse

### `search_knowledge`

Search the user's personal knowledge base using FTS5 full-text search with synonym expansion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query. Supports FTS5 syntax: AND, OR, NOT, phrase matching with quotes. |
| `limit` | number | no | Max results to return (1-20, default 5). |
| `project` | string | no | Filter results to a specific project. |
| `type` | enum | no | Filter by document type. One of: `claude`, `learnings`, `knowledge`, `skills`, `summary`, `backlog`, `changelog`, `canonical`, `memory-queue`, `skill`, `other`. |

### `get_project_summary`

Get a project's summary card and list of indexed documents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Project name (e.g. "my-app", "backend"). |

### `list_projects`

List all projects in the active cortex profile with a brief summary of each. Shows which documentation files exist per project.

No parameters.

### `get_learnings`

List recent learnings for a project without requiring a search query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `limit` | number | no | Max rows to return (1-200, default 50). |

---

## Backlog Management

### `get_backlog`

Get the backlog for a project, or all projects if no name is given.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to get all projects. |
| `id` | string | no | Backlog item ID like A1, Q3, D2. Requires project. |
| `item` | string | no | Exact backlog item text. Requires project. |

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

## Learning Capture

### `add_learning`

Record a single insight to a project's LEARNINGS.md. Call this the moment you discover a non-obvious pattern, hit a subtle bug, or find a workaround.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `learning` | string | yes | The insight, as a single bullet point. Be specific enough to act on without extra context. |
| `citation` | object | no | Optional source citation: `{ file?, line?, repo?, commit? }`. |

### `add_learnings`

Record multiple insights to a project's LEARNINGS.md in one call. FTS index rebuilds once at the end.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `learnings` | string[] | yes | List of insights to record. |

### `remove_learning`

Remove a learning from LEARNINGS.md by matching text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `learning` | string | yes | Partial text to match against existing learnings. |

### `remove_learnings`

Remove multiple learnings from a project's LEARNINGS.md in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `learnings` | string[] | yes | List of partial texts to match and remove. |

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

Export a project's data (learnings, backlog, summary, CLAUDE.md) as portable JSON.

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

Governance, policy, and maintenance tools are CLI-only. See `cortex config` and `cortex maintain`.
