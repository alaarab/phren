# Q19: Global entities sync with entity_links on updates and deletes

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/shared-index.ts`

## Context

The fragment graph maintains three tables: `entities`, `entity_links`, and `global_entities`. The `global_entities` table powers the `cross_project_fragments()` tool. When a document is updated or deleted, its `entity_links` rows are removed, but the corresponding `global_entities` rows could become stale, causing `cross_project_entities` to return references to deleted or outdated documents.

## Decision

Every code path that deletes `entity_links` rows for a document also deletes the corresponding `global_entities` rows keyed by `doc_key`. This applies in three places: single-file deletion (`deleteEntityLinksForDocPath`), incremental index updates, and the cached-graph rebuild path (which restores `global_entities` from the cache while filtering out docs that no longer exist).

## Consequences

- `cross_project_fragments()` never returns stale or deleted document references.
- The three deletion sites must be kept in sync; adding a new deletion path requires remembering to clean both tables.
- The cached-graph rebuild path validates `global_entities` against the current file set, so even stale caches are corrected on load.
- A `try/catch` guards the `global_entities` delete in case older cached databases lack the table.
