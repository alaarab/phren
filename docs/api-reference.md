# MCP API Reference

Phren exposes 69 MCP tools across 16 modules in the bundled implementation catalog, through two presentation profiles. Runtime availability is controlled by the seven built-in [Modules](modules.md). **`core`**, the default, exposes the seven memory tools plus enabled modules' core additions; tasks adds `get_tasks`, `add_task` and `manage_task`, preserving the default ten. **`full`** exposes only enabled modules' handlers and composites. `phren_admin` and other composites cannot call disabled tools. Switch presentation with `phren config mcp-profile core|full` or `PHREN_MCP_PROFILE`; use `phren modules enable|disable <name>` for enablement and restart the client afterwards.

## Core profile

| Tool | Does | Stands for (full-profile names) |
|------|------|--------------------------------|
| `search_knowledge` | Search the store | None |
| `get_memory_detail` | Fetch one memory entry in full | None |
| `get_project_summary` | A project's summary and counts | None |
| `add_finding` | Save a finding; `kind: "note"` saves a daily note instead | `add_note` |
| `revise_finding` | `action`: supersede, retract, edit, remove, link, resolve_contradiction, pin, feedback | `supersede_finding`, `retract_finding`, `edit_finding`, `remove_finding`, `link_findings`, `resolve_contradiction`, `pin_memory`, `memory_feedback` |
| `get_tasks` | List tasks | None |
| `add_task` | Add a task | None |
| `manage_task` | `action`: complete, update, remove, pin, tidy | `complete_task`, `update_task`, `remove_task`, `pin_task`, `tidy_done_tasks` |
| `session` | `action`: start, end, context, history | `session_start`, `session_end`, `session_context`, `session_history` |
| `phren_admin` | `action`: any remaining tool by name, or `list_actions` | skills, hooks, config, notes, review queue, export/import, doctor, health, stores, projects, fragment graph, extraction, topic summaries (`get_topic_summaries`, `set_topic_summary`), code index (`code_search`, `code_definition`, `code_references`, `code_outline`, `code_usage`), dispatch and hand-off |

A composite takes `action` plus the target tool's own parameters, validated against that tool's schema; a miss returns the parameter list. A nested object parameter (`manage_task` `updates`, `set_config` `settings`, `add_finding` `citation`) may arrive as a real object or as its JSON string (some hosts serialize what a passthrough schema does not name); both are accepted, and a decoded value that misses its own schema fails at the inner field rather than as a type error on the parameter. `phren_admin list_actions` returns every admin action with its full parameter list. The individual tool sections below still describe each tool's parameters; in the core profile, reach them through the composite that stands for them.

Most tools return structured JSON: `{ ok, message, data?, error? }`. The five code query tools return compact text.

Module layout: search, tasks, findings, daily notes, memory quality, data management, fragment graph, sessions, operations/review, skills, hooks, extraction, configuration, topic summaries, code index, dispatch and hand-off.

## Cross-computer dispatch

### `dispatch`

Send a worker brief through the local Phren Hook to an enrolled computer. In the
core profile use `phren_admin(action: "dispatch", ...)`; full exposes `dispatch`
directly. The local Hook must be running. Enroll the sender's computer key on the
receiver with `phren bridge enroll-computer <name>` and its `--accept` command,
then configure verified SSH peers in the local Hook's private `hooks.yaml`.
See [Conductor](conductor.md) for setup, trust boundaries and worker contracts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `computer` | string | yes | Enrolled name, or `anywhere` for the connected peer with the fewest working agents. |
| `project` | string | yes | Project slug whose `phren.project.yaml` sourcePath exists on the receiver. No local checkout paths. |
| `harness` | enum | yes | `codex`, `claude`, or `opencode`. |
| `model` | string | no | Explicit remote model, up to 200 characters; otherwise its configured default. |
| `prompt` | string | yes | Worker brief, up to 32768 characters. |
| `label` | string | yes | Task label, up to 200 characters. |
| `parent` | object | no | Conversation identity to retain in the dispatch receipt. |
| `parentTarget` | object | no | Live local target used to validate the parent identity. |

Returns the receipt in `data`: dispatch ID, computer, project, harness/model,
label, timestamps, state, remote target when known, grant match (`granted`), and an optional error.
`accepted` means first-prompt acceptance, not task completion. `uncertain` means
delivery might have occurred; never retry it automatically. Receipts are available
through `phren dispatch status`. Remote leads and their workers appear in
`/v1/subagents`. The headless receiver, question relay and report outbox have
internal adapters but are not wired into dispatch placement.

CLI equivalent:
`phren dispatch Desk phren --harness codex --label 'Checks' --prompt 'Run the assigned checks'`.

### `live_sessions`

List every live agent session on this computer and each enrolled computer:
computer, project (none for a conductor), harness, status, role, branch, model
and the `target` that `hand_off` takes. Computers that could not be reached come
back in `unreachable`; `enrolled` counts this Hook's peers. No parameters. In the
core profile use `phren_admin(action: "live_sessions")`.

CLI equivalent: `phren dispatch sessions`.

### `hand_off`

Deliver a prompt to an existing session through the local Hook or a verified
peer. In the core profile use `phren_admin(action: "hand_off", ...)`; full
exposes `hand_off` directly. Supply exactly one of `target` or `session`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `computer` | string | no | Enrolled computer name. Omit for the local Hook. |
| `target` | object | one of | Complete live Hook target. |
| `session` | string | one of | Session id resolved through the selected Hook's workspace overview. |
| `text` | string | yes | Prompt to deliver, up to 32768 characters. |
| `project` | string | no | Project scope for standing-grant matching. |

Returns `{ ok, delivered, target, granted }`. CLI equivalent:
`phren hand-off local --session <id> --text 'Continue with the review'`.

### Standing grants

`GET /v1/conductor/grants` lists grants. `POST /v1/conductor/grants` adds a
validated `scope`, `actions` and optional `computers` rule.
`DELETE /v1/conductor/grants` takes an `index` and optional `expected` grant;
a changed row returns 409 instead of revoking a different grant.
Concurrent writes are serialized per store and protected by a file lock.
See [Conductor](conductor.md) for scope and matching rules.

### Hook workspace launch fields

`POST /v1/workspaces/launch` accepts `role: "agent" | "conductor"` (default
`agent`) and `effort: "low" | "medium" | "high"` (default `medium`). A
conductor launch supports Claude, Codex and OpenCode, attaches the shipped
conductor brief, prefixes the Herdr agent name with `conductor-`, and returns
`role: "conductor"`. Workspace overview tabs report that role. A second running
conductor for the store is rejected with status 409 and the existing target.

---

## Scheduled prompts

A project's `schedules.yaml` names an assigned computer, a harness, and one of
five timing forms (interval, daily, weekly, once, cron) that the assigned
computer's Phren Hook evaluates in its local time. Manage them with
`phren schedule list|add|remove|enable|disable|run|history`; `run` and `history`
call the local Hook, the other commands edit the store file directly. See
[Scheduled prompts](schedules.md) for the store format, timing forms and run
history.

---

## Model catalogue

`GET /v1/models?source=<codex|claude|opencode>` on Phren Hook returns the
`/model` menu of the agent that source names, shaped as
`{ "models": [ { "id", "name", "description", "isDefault" } ] }`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The model identifier sent to `POST /v1/model`. The Hook caps Codex ids at 100 characters; OpenCode catalogue ids are not capped. |
| `name` | string | The display name the picker shows, at most 100 characters. |
| `description` | string? | Optional caption under the name, at most 300 characters. |
| `isDefault` | boolean? | Present and `true` on the harness default; the picker marks it with a chip. |
| `defaultReasoningEffort` | string? | Codex's default effort from its app-server catalogue. |
| `supportedReasoningEfforts` | string[]? | Codex's supported effort identifiers. |

Per source: Codex comes from its app-server `model/list` (hidden entries
dropped, at most 32). Claude reads the newest
`<CLAUDE_CONFIG_DIR>/cache/model-catalog/*-cc.json`, defaulting to `~/.claude`.
It preserves the terminal's names, main/overflow order and default, filters
minimum client versions against `claude --version`, and adds a 1M context row
for the default. The built-in menu is used only when no usable cached catalogue
is available. OpenCode comes from `opencode models`
(`provider/model` ids, the Go plan first, the configured default marked, at
most 400). An unknown source returns an empty `models` list, and answers are
cached per source for ten minutes. The phone's chat picker shows a
`model-loading` row until this route answers, never another harness's list,
and falls back to its per-harness built-in names only when the route fails.
The phone keeps at most 64 rows and only ids the model route accepts: up to 100
characters of letters, digits, and `. - _ [ ] : /`, one token with no
whitespace.

`POST /v1/model { target, model, effort? }` switches an established, idle pane.
The reply is `{ ok: true, model, name, effort? }` only after verification.
Codex receives bare `/model`, optionally walks through `All models`, matches
the catalogue's display name, verifies the cursor before Enter, then chooses
the requested or default reasoning effort and verifies the new model in its
status line. An unreadable menu, missing row, or unconfirmed result returns an
error; open menus are escaped without interrupting a working or replacement
session. Claude receives `/model <id-or-alias>` and must show its confirmation.
OpenCode returns 422 with a direction to use its terminal `/models` picker.

A working pane returns 409 before any model command is typed. `/v1/prompt`
also refuses every slash command while working. The phone offers
`Switch after this turn`, holds only the model selection until the pane goes
idle, allows cancellation, and displays a verified switch as a system row.
An uncertain result is never retried automatically.

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
| `type` | enum | no | Filter by document type. One of: `claude`, `findings`, `notes`, `reference`, `skills`, `summary`, `task`, `changelog`, `canonical`, `review-queue`, `skill`, `other`. |
| `tag` | enum | no | Filter findings by type tag: `decision`, `pitfall`, `pattern`, `bug`, `workaround`, `context`. |
| `since` | string | no | Filter findings by creation date. Formats: `7d`, `30d`, `YYYY-MM`, `YYYY-MM-DD`. |
| `status` | enum | no | Filter findings by lifecycle status: `active`, `superseded`, `contradicted`, `stale`, `invalid_citation`, `retracted`. |
| `include_history` | boolean | no | Include historical findings (`superseded`, `retracted`). Defaults to `false`. |
| `synthesize` | boolean | no | Generate a short synthesis paragraph from top hits (requires LLM endpoint/key configuration). |

A findings result carries `symbol` (and `symbols`) when a `symbol:` citation is present, so a client can show which code symbol the finding is about.

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

Each returned finding includes its `citationData` and a top-level `symbol` when it carries a `symbol:` citation.

---

## Daily Notes

Notes are lightweight, user-authored scratch context stored in `<project>/notes/YYYY-MM-DD.md`. They are indexed for explicit search and synchronized with team stores, but are excluded from automatic prompt injection, finding decay/review, and the fragment graph. Promote a note when it becomes durable reusable knowledge.

### `get_notes`

List daily notes newest-first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `date` | string | no | Filter to a `YYYY-MM-DD` date. |
| `limit` | number | no | Maximum results (1-500, default 100). |

### `add_note`

Add Markdown text to a daily note file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `text` | string | yes | Note text; multiple lines and Markdown are supported. |
| `date` | string | no | Target `YYYY-MM-DD`; defaults to today. |

### `edit_note`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `note` | string | yes | Stable `nid:xxxxxxxx` or unambiguous text match. |
| `text` | string | yes | Replacement Markdown text. |

### `remove_note`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `note` | string | yes | Stable `nid:xxxxxxxx` or unambiguous text match. |

### `promote_note`

Copy a note into `FINDINGS.md` and mark the original as promoted without deleting it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `note` | string | yes | Stable `nid:xxxxxxxx` or unambiguous text match. |
| `findingType` | enum | no | `decision`, `pitfall`, `pattern`, or `bug`. |

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

Append one or more tasks to a project's tasks.md file. Adds to the Queue section. Supports batch adds by passing an array.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name (must match a directory in your phren). |
| `item` | string or string[] | yes | The task(s) to add. Pass a single string for one task, or an array of strings for batch add. |
| `scope` | string | no | Optional memory scope label (defaults to `shared`; for example `researcher` or `builder`). |

### `complete_task`

Move one or more tasks to the Done section by matching text. Supports batch completion by passing an array.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string or string[] | yes | The task(s) to complete. Pass a single string for one task, or an array of partial/exact text strings for batch completion. |
| `sessionId` | string | no | Optional session ID from `session_start` for per-session completion metrics. |

When a task is completed, phren clears any checkpoint file associated with that task.

### `remove_task`

Remove a task from a project's `tasks.md` by matching text or task ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Exact/partial task text, or task ID like `A1`, `Q3`, `D2`. |

### `update_task`

Update a task's text, priority, context, section, GitHub metadata, pin status, or promote it. Also supports work_next (pick highest-priority Queue item) and promote (clear speculative flag). When work_next is true, item is not needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | no | Partial text to match against existing task items. Required unless `updates.work_next` is true. |
| `updates` | object | yes | Fields to update (all optional inside the object). |

The `updates` object accepts:

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Replacement text for the task line. |
| `priority` | string | New priority tag: `high`, `medium`, or `low`. |
| `context` | string | Text to append to the Context line below the item. |
| `replace_context` | boolean | Replace the existing `Context:` value instead of appending. |
| `section` | string | Move item to this section: `Queue`, `Active`, or `Done`. |
| `github_issue` | number or string | GitHub issue number (for example `14` or `#14`). |
| `github_url` | string | GitHub issue URL to associate with the item. |
| `unlink_github` | boolean | Remove any linked issue metadata from the item. |
| `pin` | boolean | Pin the task so it floats to the top of its section. |
| `promote` | boolean | Clear the speculative flag on this task (confirm the user wants it). |
| `move_to_active` | boolean | Used with `promote`: also move the task to the Active section. |
| `work_next` | boolean | Pick the highest-priority Queue item and move it to Active. Ignores `item` param. |

### `tidy_done_tasks`

Archive older Done items beyond a keep threshold to keep task lists short.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `keep` | number | no | Number of recent Done items to keep (default 30). |
| `dry_run` | boolean | no | Preview what would change without writing. |

### `pin_task`

Pin or unpin a task. Pinned tasks always appear in hook context regardless of priority, so they stay visible across every prompt.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `item` | string | yes | Partial text or task ID (A1, Q3) to match. |
| `unpin` | boolean | no | If true, unpin instead of pin. |

---

## Finding Capture

### `add_finding`

Record a single insight to a project's FINDINGS.md. Call this the moment you discover a non-obvious pattern, hit a subtle bug, or find a workaround.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding` | string or string[] | yes | The insight, as a single bullet point (or an array of bullet points for batch capture). Be specific enough to act on without extra context. |
| `citation` | object | no | Optional source citation: `{ file?, line?, repo?, commit?, symbol?, task_item? }`. |
| `sessionId` | string | no | Optional session ID from `session_start`. Pass it if you want session metrics to include this write. |
| `findingType` | enum | no | Prefix the finding inline with a type tag. One of: `decision`, `pitfall`, `pattern`, `bug`. |
| `scope` | string | no | Optional memory scope label (defaults to `shared`; for example `researcher` or `builder`). |

The finding is always saved as `active`. `add_finding` never auto-marks a finding as `contradicted`: instead it runs cheap lexical heuristics (no extra LLM/API call) and, when an existing finding looks like a possible duplicate or contradiction, returns it in the response as `potentialDuplicates` / `potentialConflicts` for the calling agent to judge. If a returned candidate is a genuine contradiction, resolve it explicitly with `resolve_contradiction` (or `supersede_finding`); if it is unrelated, ignore it. (Opt-in LLM-confirmed contradiction detection is still available via `PHREN_FEATURE_SEMANTIC_CONFLICT`.)

`citation.symbol` names a code symbol as `Name`, `Type.member` or `name()`. When the project has a code index, the finding text is scanned for a symbol that resolves to exactly one declaration (four or more characters, and not a local variable unless exported) and that symbol is attached automatically; the finding text is never rewritten. An explicit `symbol` is validated against the index and stored either way: an unresolved one is kept with `symbol_unresolved` set, the symbol counterpart of an invalid file citation, and the trust filter treats it as `invalid_citation`.

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

### `edit_finding`

Edit a finding in place while preserving inline metadata such as `fid` and citations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `old_text` | string | yes | Existing finding text to match. |
| `new_text` | string | yes | Replacement finding text. |

### `remove_finding`

Remove a finding from FINDINGS.md by matching text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `finding` | string | yes | Partial text to match against existing findings. |

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

Write a truth into truths.md, a high-confidence entry that never decays. Truths for the detected project are always prepended to hook-prompt context injection with priority second only to findings. Use `get_truths` to read all truths for a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `memory` | string | yes | Truth text. |

### `get_truths`

Read all pinned truths for a project. Returns the full list of truth entries from truths.md.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |

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
Creates or copies `AGENTS.md`, `summary.md`, `FINDINGS.md`, and `tasks.md` under `~/.phren/<project>`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path to import. Pass the current repo path explicitly. |
| `profile` | string | no | Profile to update. Defaults to the active profile. |
| `ownership` | enum | no | Repo-file ownership mode: `phren-managed`, `detached`, or `repo-managed`. |

### `export_project`

Export a project's data (findings, task, summary, AGENTS.md) as portable JSON.

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

Compatibility: graph tools use the established `entity` / `entity_type` parameter
keys for fragments. `manual-links.json` retains `entity` / `entityType`, and the
rebuildable SQLite graph retains `entities`, `entity_links`, and `global_entities`.
These internal names do not introduce additional user-facing concepts. The
`canonical` document type and `search --type canonical` continue to mean
`truths.md`. Keeping these identifiers avoids breaking existing tools and filters.

Get docs linked to a named fragment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Fragment name to look up related documents for. |
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
| `entity` | string | yes | Fragment name to link to (e.g. "Redis", "Docker"). |
| `relation` | string | no | Relationship type (e.g. "mentions", "implements"). |
| `entity_type` | string | no | Fragment type label (for example `library`, `service`, `concept`, `architecture`). Defaults to `fragment`. |

### `cross_project_fragments`

Find fragments that appear in multiple projects. Useful for discovering shared patterns and dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Fragment name to search for (partial match). |
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

### `toggle_skill`

Enable or disable a skill without deleting its file.
Choices are stored in the synced `.config/skill-preferences.json` (schema 1,
`enabledSkills` keys `<source-scope>:<lowercase-name>`). An explicit shared
choice takes precedence over legacy machine-local `disabledSkills`; absent
keys keep that computer's existing preference. Selecting an inherited global
skill changes its global source setting for all projects. It does not create
a project override of the global skill. Updated desktop clients apply phone
changes to existing managed mirrors after pulling; agent reload boundaries
still apply.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Skill name to toggle. |
| `enabled` | boolean | yes | `true` to enable, `false` to disable. |
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

### `health_check`

Return runtime health status (version, profile, project count, index status, MCP/hooks state) and consolidation status for all projects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_consolidation` | boolean | no | Include consolidation status for all projects (default true). |

### `list_hook_errors`

Read recent hook/debug failures from runtime logs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | no | Max rows to return (default 20). |

### `get_review_queue`

Read review queue items for one project or all active-profile projects. The review queue is read-only.

The optional queue is retained for quarantined candidates and deliberate manual
triage (September 2026 decision). Normal agent memory capture does not require
the user to approve each finding. `memory_feedback` adjusts retrieval ranking;
it does not replace the trust boundary around unreviewed candidate content.
There is not sufficient usage evidence to remove the working queue safely.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | no | Optional project filter. |

### `manage_review_item`

Manage a review queue item: approve (**promotes** the queued line into FINDINGS.md through the same path a direct add uses, dedup, fid assignment, citation metadata, and the findings-cap auto-archive all apply; if the finding is already live or already archived to `reference/topics/`, approve just dequeues it), reject (removes from queue AND from FINDINGS.md), or edit (updates text in both).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name. |
| `line` | string | yes | The raw queue line text (as returned by `get_review_queue`). Max 10,000 chars. |
| `action` | enum | yes | Action to perform: `approve`, `reject`, or `edit`. |
| `new_text` | string | no | The new finding text. Required when action is `edit`. Max 10,000 chars. |

### `doctor_fix`

Run doctor self-heal checks and apply fixes (missing files, broken symlinks, stale locks).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `check_data` | boolean | no | Also validate data files (findings, tasks) for structural issues. |

### `store_list`

List all registered phren stores and their sync status. Shows the primary store plus any team or readonly stores from the store registry.

*No parameters. Accepts an empty input.*

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

## Configuration

### `get_config`

Read current governance and policy configuration. Supports all config domains including topic.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | enum | no | Config domain to read: `proactivity`, `taskMode`, `findingSensitivity`, `retention`, `workflow`, `access`, `index`, `topic`, or `all` (default). |
| `project` | string | no | Project name. When provided, returns merged view with project overrides and `_source` annotations. Required for `topic` domain. |

### `set_config`

Update configuration for a specific domain. Unified setter for all config domains.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | enum | yes | Config domain: `proactivity`, `taskMode`, `findingSensitivity`, `retention`, `workflow`, `index`, or `topic`. |
| `settings` | object | yes | Domain-specific settings (see below). |
| `project` | string | no | Project name. When provided, writes to project's `phren.project.yaml` instead of global `.config/`. Required for `topic` domain. |

**Domain-specific settings:**

- **proactivity**: `{ level: "high"|"medium"|"low", scope?: "base"|"findings"|"tasks" }`
- **taskMode**: `{ mode: "off"|"manual"|"suggest"|"auto" }`. In `auto`, the prompt hook files what it picks up on its own into **Queue**; a prompt that asks to be tracked ("add this to task") goes to Active, as does a prompt matching a task already in Active. Task proactivity `high` captures any actionable request, `medium` only prompts with that explicit signal, `low` none. Terminal paste wrappers (`<pasted_content>`) are read through; frames from another agent or the harness (`<agent-message>` hand-backs, `<cross-session-message>`, delivery notices, `[SYSTEM NOTIFICATION]`, `<task-notification>`, `<system-reminder>`), questions, and replies that ask for nothing are never filed and never touch an existing task. The hook never completes a task: a saved turn leaves the task where it is, and completion is explicit.
- **findingSensitivity**: `{ level: "minimal"|"conservative"|"balanced"|"aggressive" }`
- **retention**: `{ ttlDays?, retentionDays?, autoAcceptThreshold?, minInjectConfidence?, decay?: { d30?, d60?, d90?, d120? } }`
- **workflow**: `{ lowConfidenceThreshold?, riskySections?, taskMode?, findingSensitivity? }`
- **index**: `{ includeGlobs?, excludeGlobs?, includeHidden? }`
- **topic**: `{ topics: [{ slug, label, description?, keywords? }], domain? }`

---

## Runtime Notes

### Governance identity and RBAC

- Actor identity is resolved from `PHREN_ACTOR` (in trusted/test contexts) or OS user identity.
- Access policy comes from `.config/access-control.json` with local augmentation from `.runtime/access-control.local.json`.
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

Maintenance tools (govern, prune, consolidate, extract) are CLI-only. See `phren config` and `phren maintain`.

---

## Topic Summaries

Summaries written by the agent itself, with the model it is already running as; no API key and no local model. Driven by the `/phren-summarize` skill. In the core profile both are reached through `phren_admin`.

### `get_topic_summaries`

Every `reference/topics` file of a project with its bullet count, its current `## Now` text and whether that text is structural or prose. Pass `topic` to also get that topic's newest bullets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `topic` | string | no | A topic slug from the list; returns its newest bullets. |
| `bullets` | number | no | How many of the newest bullets to return for `topic` (5–200, default 60). |

---

### `set_topic_summary`

Store the paragraph you wrote as the topic's `## Now` block and refresh the project's `What phren knows` block. Refused, with the offending names returned, if the paragraph names anything the topic's bullets do not.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `topic` | string | yes | Topic slug, as listed by `get_topic_summaries`. |
| `text` | string | yes | Four to six plain sentences; only facts the bullets state, names spelled as the bullets spell them. |

---

## Code Index

Read tools over the local symbol index the `code` module keeps per project under `<store>/.runtime/code/<project>.sqlite`. The module is off by default; enable it with `phren modules enable code`, then build the index with `phren code index <project>` (`--repo <path>` for a checkout the project does not register). Results are compact text, one line per hit, not JSON. The `/code` skill drives them.

### `code_search`

Ranked symbol search over names, signatures and doc comments. Use it instead of grep when you want a symbol rather than raw text. Ranking is exact name, then prefix, then FTS5 relevance, then usage count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `query` | string | yes | Symbol name, or words from its signature or doc comment. |
| `kind` | enum | no | `function`, `method`, `class`, `struct`, `enum`, `interface`, `type` or `variable`. |
| `limit` | number | no | Maximum hits (1-100, default 20). |

### `code_definition`

Go to a symbol's definition. Accepts `Foo`, `Foo.bar` and `bar()`; returns the file and lines, signature, doc, the last change (blame hash and date, never a name) and a source snippet of at most 40 lines. When a common name matches several symbols it prefers an exported, non-variable declaration and reports the candidate count. After the snippet it adds a `Findings` block, one line per finding that cites the symbol (its id and first 160 characters), read from the project's FINDINGS.md and archived topic files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `symbol` | string | yes | A symbol name: `Foo`, `Foo.bar` or `bar()`. |

### `code_references`

Every resolved reference to a symbol, grouped by file, with a total and a candidate count when the name is ambiguous. Accepts the same name forms as `code_definition`. Only references the index could resolve to exactly one definition are counted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `symbol` | string | yes | A symbol name: `Foo`, `Foo.bar` or `bar()`. |
| `limit` | number | no | Maximum reference lines (1-500, default 200). |

### `code_outline`

A file's symbols in source order, nested under their parent class or container, with line, signature and doc. Use it before reading a large file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `path` | string | yes | Project-relative file path, as stored in the index. |

### `code_usage`

The hottest and coldest symbols by resolved-reference count, so cold code is visible too. Local variables are excluded from the hot list so a busy local or a one-letter loop name cannot dominate it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name, optionally store-qualified. |
| `top` | number | no | How many hot and how many cold symbols (1-100, default 10). |

CLI equivalents: `phren code search <project> <query> [--kind k] [--limit n]`, `phren code def <project> <symbol>`, `phren code refs <project> <symbol>`, `phren code outline <project> <path>`, `phren code usage <project> [--top n]`.

### Hook routes

The `code` module exposes these routes through Hook's private HTTP pipe. All
require `project`; GET routes accept optional `store` in the query, and POST
routes accept it in the JSON body. The selector must resolve uniquely to an
available registered store by ID, name or GitHub repository name. Omitting it
uses the Hook's base store. A selected read-only store rejects note and reindex
writes. A missing index returns 404 with the `phren code index` command.

| Method and path | Other inputs | Result |
| --- | --- | --- |
| `GET /v1/code/status` | None | File, symbol and reference counts, languages, kinds, last index time and top symbols. |
| `GET /v1/code/tree` | `directory`, optional relative directory | `{project, directory, entries}`; immediate indexed children with `path`, `directory`, descendant `files`, `symbols` and `languages`. |
| `GET /v1/code/search` | `q`, optional `kind`, `directory`, `limit` (1-500, default 20) | `{project, query, symbols}` ranked by exact name, prefix, full-text relevance and usage. |
| `GET /v1/code/outline` | `path`, relative file path | `{project, path, entries}` in source order with nested members. |
| `GET /v1/code/outline-summary` | `paths`, a JSON array of 1-200 relative paths | `{project, entries}` with symbol totals and up to three leading kinds per file or directory, including descendants. Duplicate paths are collapsed. |
| `GET /v1/code/definition` | `symbol` | `{project, definition}` with declaration, snippet, last Git change and `findings` citing the symbol. |
| `GET /v1/code/references` | `symbol`, optional `limit` (1-500, default 200) | `{project, references}` with resolved references grouped by file. |
| `GET /v1/code/usage` | `top` (1-100, default 10) | `{project, usage: {hot, cold}}`, the older compact ranking. |
| `GET /v1/code/usage-page` | Optional `kind`, `file`, `directory`, `offset` (default 0), `limit` (1-100, default 50), `end=0\|1` | `{project, entries, total, offset, limit, maxUses}` across all symbols, including variables and zero uses. `end=1` selects the last page. |
| `GET /v1/code/recent` | Optional `directory` | `{project, entries}` for the 30 most recently changed symbols; `indexedAt` is the millisecond time the index observed the change. |
| `POST /v1/code/reindex` | None beyond `project` and optional `store` | Runs an incremental scan and returns status. |
| `POST /v1/code/note` | `symbol`, `file`, `line`, `text`, optional `target` | Saves a symbol-cited finding, then optionally delivers it to an agent. See below. |

Hook `kind` accepts the individual symbol kinds above plus `types`, the family
of class, struct, enum, interface and type declarations. Directory scopes match
descendants by literal path boundary. Definition and reference queries accept
`Name`, `Type.member`, `name()` and `file::Type.member` to stay in one file.
Usage pages sort by descending reference count, then name, file, line and ID;
`maxUses` covers the filtered distribution, not only the current page.

#### Code notes

`POST /v1/code/note` takes this JSON shape:

```json
{
  "store": "personal",
  "project": "demo",
  "symbol": "src/parser.ts::Parser.parse",
  "file": "src/parser.ts",
  "line": 42,
  "text": "Keep this empty-input case in the regression tests.",
  "target": { "session": "<session-id>" }
}
```

Omit `target` to save only, or use `{ "harness": "codex" }` to dispatch a new
worker (`codex`, `claude`, `opencode`). A session target hands off locally;
a new worker uses conductor placement with `computer: "anywhere"`. Sending
requires the conductor module. The selected line must still belong to the
indexed symbol and its returned snippet; otherwise the route returns 409 and
asks the caller to refresh. Text is trimmed, nonempty and at most 4500 characters.

The result is `{ok: true, saved: true, findings, delivery?}`. Save happens before
delivery. A delivery error is returned inside `delivery` without undoing the
finding; callers must not treat `saved: true` as proof of delivery or retry an
uncertain send automatically. Session Code entry points keep their explicit
recipient instead of presenting another chooser.

See [Code index](code-index.md), [Phren Hook](phren-hook.md) and the
[connection contract](../packages/cli/src/bridge/AGENT_CONNECTIONS.md).

### Repository files and tree

`GET /v1/projects/files?project=&directory=&path=` browses a checkout discovered
by Hook. Optional `directory` must exactly match a discovered checkout; omitted,
the first candidate is used. `path` is relative and defaults to its root.
Directories return `{path, kind: "directory", truncated, entries}` with at most
500 entries, directories first. Files return `{path, kind: "file", size, data}`
with up to 2 MiB of file content encoded as base64. Symlinks, `.git`, traversal and paths
outside the selected checkout are refused. This route is read-only.

`POST /v1/git/tree` takes the session's full target, optional `child` and relative
`path`. It returns one directory with descendant file counts and a snapshot
version. The bounded repository cache is keyed by HEAD and a file/status hash;
it expires after two seconds and is invalidated by status refresh and mutations.
Opening a directory does not collect diff statistics or upstream history.

### Live transcript previews

The transcript WebSocket includes `preview: {turnStartedAt, text}` or
`preview: null` on backlog/append frames, or sends a standalone `type: "preview"`
frame with the same conversation identity. Claude previews come from pane text anchored to the current
prompt; Codex and OpenCode use their delta text. Updates arrive at most twice
a second. Preview text stays out of history and never advances the transcript
cursor. A completed entry clears the preview without the throttle delay. The
phone replaces it in place and keeps the reveal progress, avoiding duplicate
text. Reconnect history retains existing rows unless Hook explicitly resets
the conversation.

### `GET /v1/usage`

Account limits and spend for the phone's Account usage screen: `{accounts: [...]}`, each account carrying `source` (`codex`, `claude`, `opencode`, `opencode-go`, `openrouter`), `windows`, optional `updatedAt`, `message`, `spend`, `accountName`, `accountId` and, for Claude, `origin`. The optional `?sources=` comma list names the sources the phone understands; an older phone that sends none gets the original four so it never meets a source it cannot read.

Each Claude number has one documented source:

- `five_hour` ("5-hour limit") and `seven_day` ("7-day, all models") come from Claude Code's documented status-line `rate_limits` payload, reported as `origin: "status-line"`, or from the OAuth usage endpoint when the computer's sign-in token is readable, reported as `origin: "oauth"`. The phone captions the card with that origin and the report's age ("from Claude Code status line, updated 6 s ago").
- A per-model weekly window such as `seven_day_fable` ("7-day, Fable") comes from Claude Code's own usage snapshot in `~/.claude.json` (`cachedUsageUtilization`, `kind: weekly_scoped`) when the status line does not carry it, and then carries its own `asOf` so the phone can show how old it is; the live endpoint reports the same window without `asOf`.

Every window carries its own `resetsAt`. A per-model window is its own allowance with its own denominator, not a subset of `seven_day`, so it can show a higher percentage than the all-models window without contradicting it; the phone labels it "only" (for example "7-day, Fable only") and shows its own reset time. The Live sessions header ring binds to `five_hour`, the window the Account usage page shows first, never a higher window.
