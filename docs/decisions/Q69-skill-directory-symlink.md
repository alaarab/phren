# Q69: Skill directory symlinked as whole directory, not flattened

**Status:** Accepted
**Date:** Historical
**Files:** `mcp/src/link.test.ts`

## Context

When phren links skills into a project's `.claude/skills/` directory, each skill may be a directory containing multiple files (e.g. `SKILL.md` plus supporting assets). An earlier approach flattened skill directories by copying only `SKILL.md` as a single `.md` file, which lost any additional files in the skill directory.

## Decision

The link process symlinks the entire skill directory into the target location rather than extracting and flattening individual files. For example, `~/.phren/project/skills/my-skill/` is symlinked as `.claude/skills/my-skill` pointing to the source directory.

## Consequences

- Multi-file skills (those with supporting templates, configs, or examples) work correctly.
- Changes to the source skill directory are immediately reflected through the symlink.
- The symlink approach requires the source directory to remain at its original path; moving it breaks the link.
- Existing regular files at the destination are preserved and not overwritten by the symlink.
