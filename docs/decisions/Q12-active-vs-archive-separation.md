# Q12: Separate active lines from archive/details blocks during consolidation

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/governance-policy.ts`

## Context

FINDINGS.md files contain both active findings (bullet points under date headers) and archived content wrapped in `<details>` blocks or `<!-- phren:archive:start/end -->` markers. During consolidation, only active findings should be deduplicated, merged, or pruned. If archive blocks were processed as regular content, already-consolidated entries could be corrupted or duplicated.

## Decision

The consolidation pass splits the file into two streams: "active" lines (everything outside archive markers) and verbatim archive blocks. Active lines are processed through deduplication and merging logic. Archive blocks are collected as-is and appended unchanged after the consolidated active section.

## Consequences

- Archived entries are never reprocessed, preventing double-consolidation or corruption of historical data.
- The file format is preserved: archive blocks remain in their original structure at the end of the file.
- New consolidation logic only needs to reason about active entries, simplifying the algorithm.
