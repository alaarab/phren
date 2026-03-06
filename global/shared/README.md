# Shared context

Files in this directory contain knowledge that applies to multiple projects. Instead of duplicating the same information in each project's CLAUDE.md, put it here and reference it.

## How to use

> **Note:** `@import` syntax is a planned feature that is not yet implemented. For now, reference shared files manually by reading them when needed, or copy the relevant sections into your project's CLAUDE.md.

The intended syntax (once implemented):

```markdown
@import shared/my-library-conventions.md
```

This would load the shared file alongside your project config, giving it the cross-project context without you maintaining it in two places.

## What goes here

- Library conventions used by multiple consumer projects (like `my-library-conventions.md`)
- Shared API patterns or integration contracts
- Cross-project type definitions or interface shapes

## What doesn't go here

- Project-specific config (that stays in `<project>/CLAUDE.md`)
- Learnings (those go in LEARNINGS.md files and get consolidated by `/cortex-consolidate`)
- Skills (those go in `global/skills/`)
