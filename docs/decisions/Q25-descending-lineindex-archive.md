# Q25: Descending lineIndex sort for archival correctness

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/content-archive.ts`

## Context

When archiving old findings, entries are parsed from FINDINGS.md with their line indices and date headers. The archive pass selects the N oldest entries to move to reference files. New findings are prepended at the top of each date section, so within the same date, a higher line index means the entry is older (further down in the file). An ascending sort by line index would incorrectly archive the newest entries for a given date instead of the oldest.

## Decision

Within the same date group, entries are sorted by descending `lineIndex` so that entries with the largest line index (lowest in the file, therefore oldest) appear first in the sorted array. When `entries.slice(0, N)` selects entries to archive, it correctly picks the oldest entries per date.

## Consequences

- Archival correctly removes the oldest findings first, preserving recent work.
- The sort is stable across dates (ascending date comparison) and within dates (descending line index).
- This ordering assumption must be maintained if the file format changes (e.g., if findings were appended instead of prepended).
