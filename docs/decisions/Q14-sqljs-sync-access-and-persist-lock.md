# Q14: SQL.js synchronous access pattern and persistDb file lock merge

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/embedding.ts`

## Context

The embedding cache uses SQL.js (an in-memory SQLite compiled to WebAssembly). Two problems existed:

1. The SQL.js loader is async, but after initialization, all database operations are synchronous. Code paths that needed embeddings had to await initialization every time, even when the module was already loaded.
2. When persisting the in-memory database to disk, concurrent processes (e.g., parallel hook invocations) could each read the file, insert their entries, and write back, causing one process to overwrite the other's additions.

## Decision

A `sqlResolved` variable caches the SQL.js static module after the first successful initialization, allowing synchronous access on subsequent calls. For persistence, `persistDb` acquires a file lock and merges its in-memory state with the current on-disk snapshot before writing, so concurrent callers' entries are preserved rather than overwritten.

## Consequences

- After first initialization, embedding operations avoid unnecessary async overhead.
- Concurrent embedding callers (common during parallel hook execution) no longer lose each other's cache entries.
- The merge-on-persist adds a small overhead (re-reading the file under lock), but embedding operations are already I/O-bound so this is negligible.
