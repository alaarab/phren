# Q20: Cross-project fragment index table

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/shared-index.ts`

## Context

The fragment graph tracks entities and their relationships within individual projects. To support the `cross_project_fragments()` tool, which finds fragments referenced across multiple projects, the system needed a way to query entity presence across project boundaries without scanning every project's entity_links table.

## Decision

A dedicated `global_entities` table is created in the FTS index database (via `ensureGlobalEntitiesTable`). Each row maps an entity name to a project and document key. This table is populated during indexing and kept in sync with entity_links (see Q19).

## Consequences

- `cross_project_fragments()` can efficiently query for entities appearing in 2+ projects with a simple GROUP BY query.
- The table adds storage overhead proportional to the number of cross-project entities.
- The table must be kept in sync with entity_links across all mutation paths (handled by Q19).
- Older cached databases may lack this table, so creation uses `IF NOT EXISTS` and deletions are wrapped in try/catch.
