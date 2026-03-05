# Changelog

## [1.6.2] - 2026-03-04

### Fixed
- configure_mcp smoke-tests the server with `--health` before writing any config, instead of trusting the entry exists
- configure_mcp also patches `~/.claude.json` (project-scoped, used by Claude CLI) alongside `settings.json` (global)

### Added
- `--health` flag on MCP server: exits 0 immediately, used by link.sh to verify the server starts correctly

## [1.6.1] - 2026-03-04

### Changed
- Humanized all user-facing text across skills, docs, and starter templates
- Creative polish pass on landing page copy

## [1.6.0] - 2026-03-04

### Changed
- Starter is now bundled in the npm package (no more git clone from cortex-starter repo)
- Init copies from bundled starter directory, works offline and without git
- Synced all starter templates to match 1.5.0 conventions (bold labels, project skills, key patterns, full global CLAUDE.md)
- Init output says "Created cortex v1.6.0" instead of "Cloned cortex-starter"

### Removed
- Git clone dependency during init (cortex-starter repo is now a mirror, not the source of truth)

## [1.5.0] - 2026-03-04

### Fixed
- FTS5 query sanitizer no longer strips URLs (only targets actual column prefixes)
- Broken CLAUDE.md and LEARNINGS.md symlinks replaced with real files
- Init fallback no longer overwrites existing user files
- Atomic writes for machines.yaml registration (no more race conditions)
- Context file overwrites now preserve user content outside managed markers

### Added
- Automated tests: 28 vitest cases for FTS5 injection, path traversal, project name validation
- Conflict resolution guide in cortex-sync skill
- yq support for YAML parsing in link.sh (falls back to grep/sed)
- Clear manual instructions when jq is missing (instead of fragile sed patching)

### Changed
- Upgraded glob from ^11.1.0 to ^12.0.0 (removes deprecation warning)
- Improved snippet extraction with heading proximity and section scoring
- Extracted utility functions to utils.ts for testability
- Init setup instructions now show actual git commands

## [1.3.0] - 2026-03-04

### Changed
- Merged `/cortex-learn` into `/cortex-update`: one skill for saving session learnings, works standalone or with full cortex setup
- Simplified from 6 skills to 5: update, sync, init, discover, consolidate
- MCP tool descriptions now tell Claude when to call them proactively
- global CLAUDE.md instructs Claude to use MCP tools and backlog without being asked
- Landing page: replaced misleading token savings card with honest "search not load" framing
- Skill names consistent everywhere with dashes (not colons)
- Framework boilerplate no longer lists personal workflow skills

### Fixed
- cortex-sync path references used `~/cortex` instead of `~/.cortex`
- VS Code manual config missing `~/.cortex` path argument

## [1.2.0] - 2026-03-04

### Added
- `npx @alaarab/cortex init`: one-command setup that clones cortex-starter to `~/.cortex`, sets hostname in `machines.yaml`, and configures Claude Code + VS Code MCP automatically
- link.sh symlinks `CLAUDE-*.md` split files alongside `CLAUDE.md` for `@import` support

## [1.1.4] - 2026-03-04

### Added
- MCP tools for backlog management: `get_backlog`, `add_backlog_item`, `complete_backlog_item`
- Conventional Commits format added to `/humanize` as an AI tell
- README documents all six MCP tools

## [1.1.0] - 2026-03-04

### Added
- GitHub Pages landing site (`docs/`)
- Auto-creates `~/.cortex` with starter README on first run (no error on fresh install)
- CLI path argument: `claude mcp add cortex -- npx @alaarab/cortex ~/custom/path`
- Plugin marketplace support: `.claude-plugin/marketplace.json`
- Skills installable via `/plugin marketplace add alaarab/cortex` + `/plugin install cortex@cortex`
- LICENSE file

### Changed
- Default cortex directory is now `~/.cortex` (consistent with `~/.claude`)
- Skill names use plugin namespace format: `/cortex:sync`, `/cortex:learn`, etc.
- Removed `my-cortex` from default path fallbacks

### Fixed
- npm bin path stripped of leading `./` to resolve publish warning

## [1.0.0] - 2026-03-03

Initial release.

- MCP server with SQLite FTS5 full-text search
- Tools: `search_cortex`, `get_project_summary`, `list_projects`
- Profile-aware project indexing via `profiles/*.yaml`
- 11 skills: sync, learn, init, discover, consolidate, humanize, swarm, backlog, pipeline, release, creative
- `@alaarab/cortex` on npm
