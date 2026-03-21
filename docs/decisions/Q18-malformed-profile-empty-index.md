# Q18: Malformed profile returns empty index, never widens to all projects

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/shared.test.ts`

## Context

When a user sets a profile but the profile YAML is malformed (e.g. truncated or invalid syntax), `getProjectDirs` must decide what to return. Two options exist: fall back to indexing all projects (maximizing availability), or return an empty list (maximizing access control safety).

## Decision

When a profile is set but its file is malformed, `getProjectDirs` returns an empty array. This causes `buildIndex` to produce an empty but valid FTS database with zero documents indexed. The system never widens to all projects as a fallback.

## Consequences

- Profile-based access control is preserved even when configuration is broken. A user with a restricted profile cannot accidentally gain access to all projects through a parse error.
- Search returns no results rather than incorrect results when the profile is corrupted.
- The user sees empty search output, which signals a configuration problem rather than silently leaking data from other projects.
