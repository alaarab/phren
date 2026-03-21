# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) extracted from inline `// Q<N>` design comments in the codebase.

| ADR | Title | Files |
|-----|-------|-------|
| [Q10](Q10-file-lock-async.md) | withFileLock accepts both sync and async callbacks | `governance-locks.ts` |
| [Q11](Q11-findings-lock-read-modify-write.md) | Hold per-file lock on FINDINGS.md for entire read-modify-write cycle | `content-archive.ts` |
| [Q12](Q12-active-vs-archive-separation.md) | Separate active lines from archive/details blocks during consolidation | `governance-policy.ts` |
| [Q14](Q14-sqljs-sync-access-and-persist-lock.md) | SQL.js synchronous access pattern + persistDb file lock merge | `embedding.ts` |
| [Q18](Q18-malformed-profile-empty-index.md) | Malformed profile returns empty index, never widens to all projects | `shared.test.ts` |
| [Q19](Q19-global-entities-sync.md) | Global entities sync with entity_links on updates/deletes | `shared-index.ts` |
| [Q20](Q20-cross-project-fragment-index.md) | Cross-project fragment index table | `shared-index.ts` |
| [Q23](Q23-per-file-lock-concurrent-writers.md) | Wrap read-modify-write in per-file lock for concurrent finding writers | `governance-policy.ts` |
| [Q24](Q24-journal-timestamp-recency-boost.md) | Journal timestamp persistence for recency boost | `governance-scores.ts` |
| [Q25](Q25-descending-lineindex-archive.md) | Descending lineIndex sort for archival correctness | `content-archive.ts` |
| [Q69](Q69-skill-directory-symlink.md) | Skill directory symlinked as whole directory, not flattened | `link.test.ts` |
| [Q82](Q82-audit-log-inline-lock.md) | Inline lock for audit log append + conditional rotation | `shared.ts` |
| [Q83](Q83-fts5-asterisk-validation.md) | FTS5 asterisk validation (bare * produces invalid syntax) | `utils.ts` |
