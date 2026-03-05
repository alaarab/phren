# Changelog

## [1.7.1] - 2026-03-04

### Removed
- `/cortex-update` and `/cortex-learn` skills: redundant now that hooks auto-commit and CLAUDE.md instructions tell Claude to call `add_learning()` during sessions

### Changed
- Skills count: 5 to 4 (sync, init, discover, consolidate)
- Updated all cross-references in skills, starter templates, docs site, and llms-install.md

## [1.7.0] - 2026-03-04

### Added
- **Auto-inject context**: UserPromptSubmit hook automatically injects relevant cortex context into every prompt. Claude gets project context without needing to call MCP tools first.
- **Post-compaction context**: hook-context CLI subcommand re-injects project summary, learnings, and backlog after context compaction so Claude stays oriented.
- **Synonym search**: FTS5 queries now expand synonyms automatically. Searching "throttling" also finds "rate limit", "429", and related terms. Works in both MCP tools and CLI.
- **CLI subcommands**: `cortex search`, `cortex hook-prompt`, `cortex hook-context`, `cortex add-learning` for use by hooks and scripts.
- `npx @alaarab/cortex init` now registers UserPromptSubmit and Stop hooks in `~/.claude/settings.json` alongside the MCP server.
- New shared module (`shared.ts`) extracts reusable infrastructure (buildIndex, queryRows, extractSnippet, addLearningToFile) for both MCP and CLI use.

### Changed
- MCP server version bumped to 1.7.0
- `search_cortex` MCP tool now expands synonyms before searching
- Refactored index.ts: shared logic moved to shared.ts, CLI commands to cli.ts
- `findCortexPath` split into two variants: one for CLI (env/default) and one for MCP (accepts arg)

## [1.6.4] - 2026-03-04

### Added
- `add_learning(project, insight)` MCP tool: record a learning to LEARNINGS.md the moment you discover it, grouped by date
- `remove_learning(project, text)` MCP tool: remove a learning that turned out to be wrong or outdated
- `save_learnings(message?)` MCP tool: commit and push all cortex changes (git add, commit, push)
- Global CLAUDE.md now instructs Claude to use learning tools proactively during the session, not just at the end

### Changed
- MCP tool count: 7 -> 10 (added add_learning, remove_learning, save_learnings)
- Global CLAUDE.md: split MCP instructions into Reading and Writing sections with clear triggers for each

## [1.6.3] - 2026-03-04

### Fixed
- README: removed duplicate JSON config blocks, fixed skill count (5 not 6), updated `/cortex:learn` references to `/cortex-update`
- README: added `update_backlog_item` tool and `search_cortex` type filter to MCP docs
- README: replaced outdated `cd mcp && npm run build` instructions with `npx @alaarab/cortex init`
- Site: fixed `MEMORY.md` reference to `CLAUDE.md` in bento card, `/cortex-learn` to `/cortex-update`
- Site: updated "Clones the starter" to "Creates" (bundled since v1.6.0)
- llms-install.md: fixed tool parameter signatures to match actual MCP server, added `-y` to npx commands

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
