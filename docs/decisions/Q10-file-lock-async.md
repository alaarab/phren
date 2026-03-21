# Q10: withFileLock accepts both sync and async callbacks

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/governance-locks.ts`

## Context

The file-locking primitive `withFileLock` originally only supported synchronous callbacks. Several callers needed to perform async I/O (e.g. network requests, database operations) while holding a lock, which meant the lock would be released before the async work completed, leaving a window for concurrent processes to see partial state.

## Decision

`withFileLock` was extended to detect when the callback returns a Promise. When an async callback is provided, the lock file is held until the Promise settles (resolves or rejects). The function signature uses a conditional return type (`T extends Promise<infer U> ? Promise<U> : T`) so callers get the correct type whether using sync or async callbacks.

## Consequences

- Sync callers are unaffected; the lock is acquired and released around the callback as before.
- Async callers can safely perform I/O knowing no concurrent process will acquire the same lock until their work completes.
- The lock file is always cleaned up in both resolve and reject paths, preventing stale locks from async failures.
- Callers must be careful not to hold async locks for extended periods, as other processes will spin-wait up to `PHREN_FILE_LOCK_MAX_WAIT_MS`.
