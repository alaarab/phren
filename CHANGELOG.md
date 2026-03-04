# Changelog

## [1.3.0] - 2026-03-04

### Changed
- Merged `/cortex-learn` into `/cortex-update` — one skill for saving session learnings, works standalone or with full cortex setup
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
- `npx @alaarab/cortex init` — one-command setup that clones cortex-starter to `~/.cortex`, sets hostname in `machines.yaml`, and configures Claude Code + VS Code MCP automatically
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
