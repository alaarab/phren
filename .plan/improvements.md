# Phren Improvement Plan

## 1. Tool Surface Area (72 tools → smarter exposure)

### Option A: Progressive tool registration
- Register a core set (~20 tools) by default: search, add_finding, get_tasks, add_task, complete_task, session_start/end, push_changes
- Expose an `unlock_tools(domain)` meta-tool that registers additional tool groups on demand
- Domains: governance, fragments, hooks, skills, config, bulk-ops
- LLM only sees what it needs; can request more when the task requires it

### Option B: Tool namespacing with routing
- Single `phren(action, params)` dispatcher tool that routes internally
- LLM calls `phren("add_finding", { project, finding })` instead of `add_finding(...)`
- Reduces MCP registration to 1 tool, but puts routing burden on the LLM's string matching
- Hybrid: 5-6 namespace tools (`phren_search`, `phren_tasks`, `phren_findings`, `phren_session`, `phren_admin`) each accepting an `action` param

### Option C: Merge singular/plural tools
- `add_finding` accepts `finding: string | string[]`, returns single result or batch result accordingly
- Same for remove_finding, add_task, complete_task, remove_task
- Cuts 5 tools immediately
- Fix `remove_findings` locking while at it (currently N locks instead of 1)

### Recommendation
Do C first (quick win, -5 tools), then A for longer term. B is clever but LLMs are better at selecting named tools than routing through a dispatcher.

---

## 2. In-Memory FTS5 Index Scaling

### Problem
`buildIndex()` scans all markdown, parses, and loads into sql.js on every process start. Fine for 5-10K findings, breaks at 100K+.

### Option A: Persistent SQLite file
- Write FTS5 index to `~/.phren/.runtime/index.db` on disk
- On startup: check file mtimes of all indexed docs vs last index build timestamp
- Only re-index changed files (incremental rebuild)
- Fallback: full rebuild if index.db missing or corrupt
- Trade-off: sql.js-fts5 is in-memory only; would need to switch to better-sqlite3-fts5 or similar

### Option B: Incremental index with journal
- Keep in-memory sql.js but persist a journal of indexed file hashes
- On startup: load journal, diff against current files, only index changed/new/deleted
- Cheaper than full persistence, keeps current sql.js dep
- Store journal as JSON in `.runtime/index-journal.json`

### Option C: Lazy indexing
- Don't build full index on startup
- Index on first search query, then cache
- Background re-index on file changes (watch mode or hook-triggered)
- Startup becomes instant; first search pays the cost

### Recommendation
B is the best near-term fix (no dep changes). C layered on top for startup speed. A is the endgame if the knowledge base truly scales to 100K+.

---

## 3. Silent Failure Logging

### Problem
Errors gated behind `PHREN_DEBUG` mean real issues go unnoticed.

### Fix
- Introduce log levels: `error`, `warn`, `info`, `debug`
- `error` and `warn` always write to `.runtime/phren.log` (no flag needed)
- `info` writes when `PHREN_LOG_LEVEL=info` or higher
- `debug` writes when `PHREN_DEBUG=1` (current behavior)
- Add `debugLog` overloads: `debugLog.error(...)`, `debugLog.warn(...)` etc.
- Existing `debugLog(...)` calls become `debugLog.debug(...)` (backward compat: keep plain `debugLog` as alias for debug level)
- `phren doctor` checks `.runtime/phren.log` for recent errors and surfaces them

### Scope
- Audit all try-catch blocks that only log on PHREN_DEBUG
- Promote genuine error conditions to `error` level
- Keep noisy/expected conditions (lock contention, empty search) at `debug`

---

## 4. Package Size (3.5MB unpacked)

### Quick wins
- Move `esbuild` from dependencies to devDependencies (it's only used at build time)
- Check if `graphology`, `graphology-layout-forceatlas2`, and `sigma` can move to optionalDependencies or be lazy-required only when `phren web-ui` runs

### Larger effort: Split the web UI
- Extract `memory-ui-graph.runtime.js` (652KB) and related assets into a separate `@phren/web-ui` package
- `phren web-ui` does a one-time `npx @phren/web-ui` or checks for local install
- Core CLI package drops to ~800KB unpacked

### Alternative: Lazy bundle loading
- Keep assets in package but don't ship the graph visualization bundle in the main dist
- Download on first `phren web-ui` invocation, cache in `.runtime/`
- No extra npm package needed

---

## 5. Large Files

### init.ts (96K lines)
Split into focused modules:
- `init-detect.ts` — agent/tool detection logic
- `init-mcp.ts` — MCP config generation for each agent
- `init-hooks.ts` — hook installation per tool
- `init-walkthrough.ts` — interactive setup flow
- `init-template.ts` — starter template copying
- `init.ts` becomes a thin orchestrator (~200 lines) that calls these

### cli-hooks-session.ts (1.5K lines)
Split by hook event:
- `hook-prompt.ts` — UserPromptSubmit handler (keyword extraction, search, injection)
- `hook-stop.ts` — Stop handler (git commit/push)
- `hook-session.ts` — SessionStart/End handlers
- `hook-context.ts` — context injection logic

---

## 6. Design Question Comments (// Q<n>)

### Current state
19 `// Q<n>` comments scattered across the codebase documenting design decisions inline.

### Fix
- Create `docs/decisions/` directory
- One markdown file per decision: `docs/decisions/Q10-file-lock-async.md`
- Format: Context → Decision → Consequences (lightweight ADR)
- Replace inline `// Q10:` comments with `// See docs/decisions/Q10-file-lock-async.md`
- Add a `docs/decisions/README.md` index

---

## 7. Performance Documentation

### Create `docs/performance.md`
Cover:
- Default tuning parameters and what they control
- Recommended settings for small (<1K findings), medium (1-10K), large (10K+) knowledge bases
- How consolidation affects index size and search speed
- `PHREN_FINDINGS_CAP`, `PHREN_CONSOLIDATION_CAP` tuning guidance
- `PHREN_CONTEXT_TOKEN_BUDGET` impact on hook latency
- `PHREN_FILE_LOCK_*` settings for concurrent agent scenarios
- Monitoring: what to watch in `.runtime/` for performance issues

---

## Priority Order

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 1 | Merge singular/plural tools (-5 tools) | Small | Medium |
| 2 | Silent failure → log levels | Small | High |
| 3 | Move esbuild to devDeps | Trivial | Small |
| 4 | Incremental index journal (Option B) | Medium | High |
| 5 | Split init.ts and cli-hooks-session.ts | Medium | Medium |
| 6 | Progressive tool registration | Medium | High |
| 7 | Graduate Q comments to ADRs | Small | Small |
| 8 | Performance docs | Small | Medium |
| 9 | Split web UI package | Medium | Small |
