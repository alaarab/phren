# Shared Context

Files in this directory contain knowledge that applies to multiple projects. Instead of duplicating the same information in each project's CLAUDE.md, put it here and `@import` it.

## How to use

Reference a shared file from your project's CLAUDE.md:

```markdown
@import shared/my-library-conventions.md
```

Claude will load the shared file alongside your project config, giving it the cross-project context without you maintaining it in two places.

## What goes here

- Library conventions used by multiple consumer projects (like `my-library-conventions.md`)
- Shared API patterns or integration contracts
- Cross-project type definitions or interface shapes

## What does NOT go here

- Project-specific config (that stays in `<project>/CLAUDE.md`)
- Learnings (those go in LEARNINGS.md files and get consolidated by `/cortex-consolidate`)
- Skills (those go in `global/skills/`)
