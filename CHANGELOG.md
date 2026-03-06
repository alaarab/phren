# Changelog

## [Unreleased]

### Added
- `1.8.0` Memory trust layer:
  - `add_learning` supports citation fields (`citation_file`, `citation_line`, `citation_repo`, `citation_commit`) and stores citation metadata for saved learnings.
  - Trust filter re-validates citations before injection, skips stale entries, and applies policy-based confidence decay (30/60/90/120 day buckets).
- `1.8.1` Automatic candidate extraction:
  - New CLI command `extract-memories [project]` mines git history and GitHub PR/review/CI/issue signals when `gh` is available.
  - High-confidence candidates are auto-written to `LEARNINGS.md`; lower-confidence items are queued in `MEMORY_QUEUE.md` for review.
- `1.8.2` Self-healing setup:
  - New `doctor [--fix]` command with health checks for machine/profile linkage and optional full relink repair.
  - Session-start hooks run `doctor --fix` after pull for continuous setup drift repair.
- `1.8.3` Branch-aware retrieval:
  - `hook-prompt` uses task intent, branch tokens, changed files, and local-project preference to rerank/filter injected memory.
  - Injection output now includes a short reason trace (`intent`, file hits, branch hits, branch, changed file count).
- `1.8.4` Governance and quality controls:
  - Canonical/pinned memory support via `CANONICAL_MEMORIES.md` and `pin_memory` (MCP) / `pin-memory` (CLI).
  - Governance queue + audit trail via `MEMORY_QUEUE.md` and `.cortex-audit.log`.
  - Governance/policy/admin APIs:
    - MCP: `govern_memories`, `memory_policy`, `memory_access`, `prune_memories`, `consolidate_memories`, `memory_feedback`
    - CLI: `govern-memories`, `memory-policy`, `memory-access`, `prune-memories`, `consolidate-memories`, `quality-feedback`
  - Quality feedback loop with usage scoring, reprompt/regression penalties, helpful signal capture, and daily maintenance hooks.
  - Canonical drift locks with auto-restore and conflict queueing.
- Lightweight review UI (`memory-ui`) with accepted/stale/conflicting/recently-used views and one-click approve/reject/edit actions backed by markdown files.
- Role-based memory permissions and policy defaults auto-created at init/link:
  - `.governance/access-control.json`
  - `.governance/memory-policy.json`
- MCP mode controls:
  - `init`/`link` accept `--mcp on|off` to choose MCP tools vs hooks-only fallback during one-shot setup.
  - New `mcp-mode on|off|status` command toggles MCP integration later without reinstalling.
  - MCP preference is persisted in `.governance/install-preferences.json`.
- Expanded MCP auto-configuration beyond Claude/VS Code:
  - New best-effort MCP config writers for Cursor, GitHub Copilot CLI, and Codex.
  - `init`, `link`, and `mcp-mode` now apply MCP mode across all detected tool targets.
  - `uninstall` now removes cortex MCP entries from all known tool config paths.
- Memory workflow policy and approval gates:
  - New workflow policy file: `.governance/memory-workflow-policy.json`.
  - New CLI command: `memory-workflow [get|set ...]`.
  - New MCP tool: `memory_workflow`.
  - `memory-ui` now enforces maintainer/admin approval for risky queue items (by section or low confidence).
- Retrieval pipeline upgrades:
  - Added hybrid overlap-based fallback when strict FTS misses paraphrased prompts.
  - Added context token budgeting and snippet compaction to cap prompt injection size.
  - Added token usage trace in hook output.

### Fixed
- `remove_learning` now removes an immediately attached `cortex:cite` comment, preventing orphan citation metadata lines in `LEARNINGS.md`.
- GitHub data mining now executes `gh` using argument-safe process execution (no shell-string concatenation in `runGhJson`).
- `hook-prompt` daily quality maintenance moved to detached background execution (`background-maintenance`) so prompt hooks stay low-latency.
- CLI `link` path resolution now uses ESM-safe `os.homedir()` import (removes Node `ERR_AMBIGUOUS_MODULE_SYNTAX` runtime failure).
- VS Code auto-detection now includes WSL + Windows user-install paths (`USERPROFILE/AppData/Roaming/Code/User`), including Windows-style `C:\...` path normalization.
- Conflict auto-merge git operations now use argument-safe `execFileSync("git", [...])` calls instead of shell command strings.
- Version/docs consistency updates:
  - package version aligned to `1.8.4`
  - MCP server version aligned to `1.8.4`
  - README MCP tool and CLI command docs updated to match current implementation

### TODO
- Add integration tests for `memory-ui` approve/reject/edit flows and markdown mutation edge cases.
- Add CLI-level feature flags for gradual rollout of auto-extraction and daily maintenance jobs.
- Harden GitHub mining for large repos and API failures (pagination, timeouts, rate-limit backoff).
- Expand docs/README with governance model, role setup, policy tuning examples, and operator runbook.

## [1.7.4] - 2026-03-04

### Changed
- MCP tool titles now use `◆ cortex ·` prefix for consistent branding in Claude Code's UI (e.g., "◆ cortex · search", "◆ cortex · save learning", "◆ cortex · push")
- Hook output now includes a status line before injected context: `◆ cortex · {project} · {n} results`
- Consolidation notice prefixed with `◈ cortex · consolidation ready` for visibility
- hook-context output labeled with `◆ cortex · {project} · context`

## [1.7.3] - 2026-03-04

### Added
- Consolidation detection: `hook-prompt` now scans LEARNINGS.md files for entries since the last `<!-- consolidated: -->` marker and injects a `<cortex-notice>` when a project has 25+ new entries or 60+ days without consolidation — once per session, not every prompt
- `<details>` stripping in FTS5 indexer: archived entries in consolidation blocks are excluded from search so old superseded learnings don't pollute results
- Updated `/cortex-consolidate` skill: marker-aware consolidation, archive to `<details>` block, global promotion rules, chain of `prev:` dates for history

## [1.7.2] - 2026-03-04

### Added
- `list_machines()` MCP tool: reads machines.yaml and returns registered machines with their profiles
- `list_profiles()` MCP tool: reads profiles directory and returns each profile's project list
- SessionStart hook: auto-pulls cortex on session start (uses `--rebase` to handle diverged histories cleanly)

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
