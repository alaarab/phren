# MCP API Reference

Cortex exposes 22 tools through the Model Context Protocol. These are available to any MCP-compatible client (Claude Code, etc.) when the cortex server is running.

All tools return text responses. Error conditions return descriptive error messages in the same format.

---

## Search and Browse

### `search_cortex`

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

### `list_machines`

Show which machines are registered and which profile each uses.

No parameters.

### `list_profiles`

Show all profiles and which projects each includes.

No parameters.

---

## Backlog Management

### `get_backlog`

Get the backlog for a project, or all projects if no name is given.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to get all projects. |

### `add_backlog_item`

Append a task to a project's backlog. Adds to the Queue section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name (must match a directory in your cortex). |
| `item` | string | yes | The task to add. |

### `complete_backlog_item`

Move a backlog item to the Done section by matching text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Exact or partial text of the item to complete. |

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
| `citation_file` | string | no | Source file path that supports this learning. |
| `citation_line` | number | no | 1-based line number in citation_file. |
| `citation_repo` | string | no | Git repository root path for citation validation. |
| `citation_commit` | string | no | Git commit SHA that supports this learning. |

### `remove_learning`

Remove a learning from LEARNINGS.md by matching text. Use when a previously captured insight is wrong or outdated.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `learning` | string | yes | Partial text to match against existing learnings. |

### `save_learnings`

Commit and push any changes in the cortex repo. Call at the end of a session or after adding multiple learnings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | no | Commit message. Defaults to "update cortex". |

---

## Memory Governance

### `pin_memory`

Promote an important memory into CANONICAL_MEMORIES.md so retrieval prioritizes it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `memory` | string | yes | Canonical memory text to pin. |

### `govern_memories`

Scan LEARNINGS.md entries and queue stale, citation-conflicting, or low-value items in MEMORY_QUEUE.md.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to scan all indexed projects. |

### `prune_memories`

Delete stale memory entries based on retention policy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to prune all projects. |

### `consolidate_memories`

Deduplicate LEARNINGS.md bullets for one project or all projects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Project name. Omit to consolidate all indexed projects. |

### `memory_feedback`

Record feedback on whether an injected memory was helpful or noisy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Memory key to score. |
| `feedback` | enum | yes | One of: `helpful`, `reprompt`, `regression`. |

### `migrate_legacy_findings`

Promote legacy findings/retro docs into LEARNINGS.md and optionally CANONICAL_MEMORIES.md.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `pinCanonical` | boolean | no | When true, pin high-signal migrated findings as canonical memories. |
| `dryRun` | boolean | no | Preview how many findings would be migrated without writing files. |

---

## Policy Configuration

### `memory_policy`

Read or update memory governance policy (retention, TTL, confidence thresholds, decay).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | enum | yes | `get` returns current policy, `set` applies provided fields. |
| `ttlDays` | number | no | Time-to-live in days. |
| `retentionDays` | number | no | Retention period in days. |
| `autoAcceptThreshold` | number | no | Confidence threshold for auto-accepting memories. |
| `minInjectConfidence` | number | no | Minimum confidence for injecting memories into context. |
| `decay_d30` | number | no | Decay multiplier at 30 days. |
| `decay_d60` | number | no | Decay multiplier at 60 days. |
| `decay_d90` | number | no | Decay multiplier at 90 days. |
| `decay_d120` | number | no | Decay multiplier at 120 days. |

### `memory_workflow`

Read or update risky-memory approval workflow policy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | enum | yes | `get` returns workflow policy, `set` applies provided fields. |
| `requireMaintainerApproval` | boolean | no | Whether risky memories need maintainer approval. |
| `lowConfidenceThreshold` | number | no | Confidence below which memories are flagged as risky. |
| `riskySections` | array | no | Sections considered risky. Array of: `Review`, `Stale`, `Conflicts`. |

### `memory_access`

Read or update role-based memory access control.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | enum | yes | `get` returns current access control, `set` updates role lists. |
| `admins` | string[] | no | List of admin identifiers. |
| `maintainers` | string[] | no | List of maintainer identifiers. |
| `contributors` | string[] | no | List of contributor identifiers. |
| `viewers` | string[] | no | List of viewer identifiers. |

### `index_policy`

Read or update indexer include/exclude controls and hidden-doc coverage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | enum | yes | `get` returns current index policy, `set` applies provided fields. |
| `includeGlobs` | string[] | no | Glob patterns to include in indexing. |
| `excludeGlobs` | string[] | no | Glob patterns to exclude from indexing. |
| `includeHidden` | boolean | no | Whether to index hidden files/directories. |
