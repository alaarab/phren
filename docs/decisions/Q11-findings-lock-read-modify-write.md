# Q11: Hold per-file lock on FINDINGS.md for entire read-modify-write cycle

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/content-archive.ts`

## Context

The content archival process reads FINDINGS.md, decides which entries to archive, then rewrites the file with archived entries moved to reference files. Without synchronization, concurrent finding writers (e.g. MCP tools, hooks) could write between the read and the write, causing their additions to be silently lost.

## Decision

The entire read-modify-write cycle in the archive pass is wrapped in a `withFileLock` call on the FINDINGS.md path. This ensures that finding writers and the archive pass always see a consistent file and never race on the same content.

## Consequences

- Archival is safe against concurrent `add_finding` calls from MCP tools or hook processes.
- The lock is held for the full duration of archival (reading, parsing, writing reference files, rewriting FINDINGS.md), which may briefly block finding writers.
- This pairs with Q23's lock usage in consolidation to form a consistent concurrency strategy for FINDINGS.md modifications.
