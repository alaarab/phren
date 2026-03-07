# Shared context

Files in this directory contain reference material that applies to multiple projects. Instead of duplicating the same information in each project's CLAUDE.md, put it here and reference it.

## How to use

Add an `@import` line in any indexed markdown file to pull in shared content:

```markdown
@import shared/my-library-conventions.md
```

The import path is relative to `~/.cortex/global/`. Imports are resolved recursively (up to 5 levels deep) during FTS indexing. Circular imports are detected and skipped.

## What goes here

- Library conventions used by multiple consumer projects (like `my-library-conventions.md`)
- Shared API patterns or integration contracts
- Cross-project type definitions or interface shapes

## What doesn't go here

- Project-specific config (that stays in `<project>/CLAUDE.md`)
- Findings (those go in FINDINGS.md files and get consolidated by `/cortex-consolidate`)
- Skills (those go in `global/skills/`)
