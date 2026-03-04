# Changelog

## [1.1.4] - 2026-03-04

### Added
- MCP tools for backlog management: `get_backlog`, `add_backlog_item`, `complete_backlog_item`
- Conventional Commits format added to `/humanize` as an AI tell
- README documents all six MCP tools

## [1.1.0] - 2026-03-04

### Added
- GitHub Pages landing site (`docs/`)
- Auto-creates `~/.cortex` with starter README on first run — no error on fresh install
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
