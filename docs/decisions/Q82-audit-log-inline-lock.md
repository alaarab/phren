# Q82: Inline lock for audit log append with conditional rotation

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/shared.ts`

## Context

The audit log is appended to by many concurrent processes (MCP tools, hooks, governance checks). The append operation also includes conditional rotation: when the log exceeds a size threshold, it is truncated. Without synchronization, two processes could both read the log size, both decide to rotate, and one would truncate the other's just-appended entries. Using the shared `withFileLock` was considered but would create a circular dependency since `shared.ts` is a foundational module.

## Decision

`appendAuditLog` implements its own inline file lock using the same protocol as `withFileLock` (atomic `wx` file creation, PID-based stale detection, polling with backoff) but without importing from `governance-locks.ts`. This keeps the dependency graph clean while providing the same concurrency guarantees.

## Consequences

- Audit log appends and rotations are atomic with respect to concurrent processes.
- The lock protocol is duplicated rather than shared, creating a maintenance burden if the locking algorithm changes. This is accepted because the audit log lock is self-contained and unlikely to change independently.
- The inline implementation avoids circular imports between `shared.ts` and `governance-locks.ts`.
