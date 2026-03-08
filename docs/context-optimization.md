# MCP Context Optimization

How to use cortex MCP tools without flooding your agent's context window.

## The problem

A full backlog fetch (`get_backlog(project:"my-app")`) can return 10k+ tokens. At a 200k context window, that is 5% of context spent on a single tool call. For agents running multi-step workflows with many tool calls, this adds up fast.

The same applies to search results, findings, and any tool that returns variable-length content. The pattern is always the same: fetch the minimum you need for the current step, then drill down.

## Progressive disclosure for backlogs

The `get_backlog` tool supports three tiers of detail. Use the lightest tier that gives you what you need.

### Tier 1: Summary (planning)

```
get_backlog(project: "my-app", summary: true)
```

Returns counts and titles only. About 200 tokens for a typical project. Use this when you need to understand what work exists, pick what to do next, or report status.

Response shape:

```json
{
  "ok": true,
  "message": "Active (3): Fix login bug, Update deps, Add tests\nQueue (7): ...",
  "data": { "project": "my-app", "totalItems": 12, "summary": true }
}
```

### Tier 2: Paginated content (reviewing details)

```
get_backlog(project: "my-app", limit: 10, offset: 0)
```

Returns full item content with pagination. Use this when you need to read item descriptions, context lines, or priority tags. Page through large backlogs with offset.

```
get_backlog(project: "my-app", limit: 10, offset: 10)  # page 2
```

### Tier 3: Single item by stable ID (execution)

```
get_backlog(project: "my-app", id: "bid:a3f9c2e1")
```

Returns one item by its content-addressed hash. Use this during execution when you know exactly which item you are working on.

## Stable bid hashes

Every backlog item gets an 8-character hex hash embedded as an HTML comment: `<!-- bid:a3f9c2e1 -->`. These hashes are content-addressed and stable across sessions. They survive reordering, completions, and edits to other items.

**Why this matters:** Positional IDs like A1, Q3, D2 shift when items complete or move between sections. If you store "work on Q3" in a task description, Q3 might be a different item by the time the agent reads it. Stable bid hashes do not have this problem.

**Use bid hashes for:**
- Cross-session references (agent memory, task descriptions, coordination messages)
- Multi-agent workflows where one agent assigns work to another
- Any reference that will be read later, not immediately

**How to get them:**
- Tier 2 and Tier 3 responses include bid hashes in the item content
- The summary tier (Tier 1) shows titles but not full bid hashes
- Use Tier 2 once to discover bid hashes, then use Tier 3 for subsequent fetches

**In agent task descriptions:**

```
Work on backlog item bid:a3f9c2e1 from the my-app project.
Fetch it with: get_backlog(project:"my-app", id:"bid:a3f9c2e1")
```

This gives the agent a direct path to the exact item without fetching the full backlog.

## Token budget guidance

| Operation | Typical tokens | When to use |
|-----------|---------------|-------------|
| `get_backlog(summary:true)` | ~200 | Planning, status checks, picking work |
| `get_backlog(limit:10)` | ~1,000 | Reviewing item details, discovering bid hashes |
| `get_backlog()` (full) | ~10,000 | Rarely. Only when you need everything at once. |
| `get_backlog(id:"bid:xxx")` | ~100 | Execution. Fetching the one item you are working on. |

For agents coordinating work across a team:
1. Start with `summary:true` to see what exists
2. Use `limit`/`offset` to page through items you care about
3. Pass `bid:` hashes in task descriptions so downstream agents can fetch directly

## Context injection hooks

The `UserPromptSubmit` hook already does progressive disclosure for search results. When `CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE=1` is set:

**1-2 search results:** Full snippets are injected directly into context. Small enough that the overhead is negligible.

**3+ search results:** The hook injects a compact memory index instead of full snippets. Each entry shows a `mem:project/filename` ID and a one-line summary (truncated at 80 chars). The agent can then call `get_memory_detail(id)` to expand any entry it needs.

This keeps the automatic injection path small and predictable while still surfacing all relevant matches. The agent decides which memories to expand rather than having all of them injected upfront.

### How it works

1. `UserPromptSubmit` extracts keywords from the user's prompt
2. FTS5 search runs with synonym expansion
3. Trust filter scores and ranks results
4. If 3+ results match and progressive disclosure is enabled, the hook emits a compact index instead of full content
5. The agent reads the index and calls `get_memory_detail(id)` for entries it wants to expand

The token budget for automatic injection is controlled by `CORTEX_CONTEXT_TOKEN_BUDGET` (default: 550). Progressive disclosure makes this budget go further by fitting more result summaries into the same token space.

## Applying this pattern to other tools

The same principle applies to any MCP tool that returns variable-length content:

- `get_findings(project, limit:5)` instead of fetching all findings
- `search_knowledge(query, limit:3)` for targeted searches
- `list_projects()` is already lightweight by design

When building agent workflows, default to the smallest fetch that answers the current question. Expand only when the agent needs more detail to proceed.
