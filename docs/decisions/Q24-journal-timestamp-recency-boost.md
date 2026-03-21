# Q24: Journal timestamp persistence for recency boost

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/governance-scores.ts`

## Context

Memory entries receive a recency boost in search ranking based on `lastUsedAt`. Usage events are first written to a journal file (append-only for performance), then periodically flushed into the aggregated scores file. During flush, journal entries are aggregated by key, but the timestamp was being lost -- `lastUsedAt` in the scores file would remain at its initial epoch value, causing the recency boost to never advance.

## Decision

During journal aggregation, the maximum timestamp (`at` field) across all journal entries for a given key is carried forward. During flush, if the journal's max timestamp is newer than the existing `lastUsedAt` in scores, the scores entry is updated. This ensures that `lastUsedAt` correctly reflects the most recent usage event.

## Consequences

- The recency boost in search ranking now accurately reflects when a memory was last surfaced or rated.
- Memories that are frequently used stay highly ranked; unused memories naturally decay.
- The max-timestamp approach is simple and idempotent -- replaying journal entries produces the same result.
