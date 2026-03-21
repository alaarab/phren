# Q23: Wrap read-modify-write in per-file lock for concurrent finding writers

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/governance-policy.ts`

## Context

Multiple processes can write to FINDINGS.md concurrently: MCP tool calls from different agent sessions, hook-triggered consolidation, and pruning operations. Each performs a read-modify-write cycle. Without synchronization, two processes could read the same file state, make independent modifications, and the last writer would silently discard the other's changes.

## Decision

Both `pruneDeadMemories` and `consolidateProjectFindings` wrap their entire read-modify-write cycle in a `withFileLock` call on the FINDINGS.md file. This serializes concurrent writers so each sees the result of the previous write before making its own modifications.

## Consequences

- Finding writes, consolidation, and pruning are serialized per-file, eliminating lost-update races.
- Throughput is reduced under high concurrency, but FINDINGS.md writes are infrequent enough that this is not a bottleneck.
- All code paths that modify FINDINGS.md must use the same lock file convention (file path + ".lock") to ensure mutual exclusion.
- This pattern is consistent with Q11's approach in the archive pass.
