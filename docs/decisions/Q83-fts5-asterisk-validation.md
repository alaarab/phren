# Q83: FTS5 asterisk validation (bare * produces invalid syntax)

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/utils.ts`

## Context

FTS5 uses `*` as a prefix operator that must be attached to a token (e.g., `foo*` matches "foobar"). A bare `*` or a space-separated trailing `*` (e.g., `foo *`) produces invalid FTS5 syntax that causes SQLite to throw a parse error. User search queries can contain arbitrary input, so the sanitizer must handle these cases.

## Decision

The `sanitizeFts5Query` function strips any `*` that is not immediately preceded by a word character (using a negative lookbehind `(?<!\w)\*`). It also strips a trailing `*` separated by whitespace from the preceding token. This ensures only valid prefix operators like `foo*` survive sanitization.

## Consequences

- User queries containing bare asterisks no longer cause FTS5 parse errors.
- Valid prefix searches like `foo*` continue to work as expected.
- The regex-based approach is simple and handles edge cases (multiple bare asterisks, asterisk-only queries) without complex parsing.
