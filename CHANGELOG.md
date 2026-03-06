# Changelog

## [Unreleased]

### Added
- Wave 1 backlog delivery:
  - #77: Added CI hardening gates for lint/test/package and docs validation.
  - #251: Added structured shell/API error codes for more predictable automation handling.
  - #223: Added schema/versioning guardrails for safer config and metadata evolution.
  - #252: Added dry-run coverage for destructive lifecycle/governance operations.
  - #225: Added OSS contributor docs (`CONTRIBUTING.md`, `SECURITY.md`, API references).
  - #222: Added docs refresh across README, site, and whitepaper v2 artifacts.
  - #264: Rewrote starter template with guided tour, day-to-day workflow, and P0/P1/P2 backlog examples.
  - #265: Init success output now mentions agent restart and points to README for a guided tour.
  - #166: Added test coverage for shell backlog subsection headers (P0, P1, P2 display).
  - #176/#177: Verified Copilot and Cursor hook schema validation (already implemented).
  - #276/#277/#279: Updated whitepaper architecture sections, fixed MCP tool count, regenerated PDF.
  - #195: Added Keep a Changelog comparison links for all versions.

## [1.10.2] - 2026-03-06

### Added
- Release gating and verification upgrades:
  - New GitHub Actions CI workflow (`.github/workflows/ci.yml`) for build/test/package smoke checks.
  - Added strict TypeScript unused-symbol gate in CI (`--noUnusedLocals --noUnusedParameters`).
  - Added `memory-ui` integration tests for approve/reject/edit flows and error handling.
  - Added explicit hooks-mode test coverage in `init.test.ts` and release-gate checks.
- CLI rollout controls via environment flags:
  - `CORTEX_FEATURE_AUTO_EXTRACT` (toggle automatic extraction in hook-prompt).
  - `CORTEX_FEATURE_DAILY_MAINTENANCE` (toggle detached daily maintenance jobs).
  - GitHub mining safety knobs: `CORTEX_GH_TIMEOUT_MS`, `CORTEX_GH_RETRIES`, `CORTEX_GH_PR_LIMIT`, `CORTEX_GH_RUN_LIMIT`, `CORTEX_GH_ISSUE_LIMIT`.

### Changed
- Command execution hardening:
  - Replaced shell-string command execution in key lifecycle/save paths with arg-safe `execFileSync` calls.
  - Standardized binary detection on `which`-based checks for safer command probing.
- Docs/site alignment:
  - Restored the previous docs-site landing design and kept whitepaper references in nav/CTA/footer.
  - Updated shell release hardening checklist to reflect completed gates.

### Fixed
- Queue approval policy enforcement:
  - Memory queue approve/reject/edit flows now consistently enforce role permissions.
  - Risky queue approvals now require maintainer/admin role consistently across shell and memory UI.
- Input validation:
  - Memory queue edit flow now rejects empty replacement text.

## [1.10.0] - 2026-03-06

### Changed
- Minor version bump to `1.10.0` for ongoing shell and memory workflow updates (no 2.0 breaking changes).
- MCP server metadata version aligned to `1.10.0`.

### Fixed
- Publish/install CLI executable reliability:
  - Build now explicitly applies executable mode to `mcp/dist/index.js`.
  - Fresh global installs now consistently expose a runnable `cortex` binary in new shells.

## [1.9.0] - 2026-03-06

### Added
- Release hardening gates:
  - Added `mcp/src/release.test.ts` to enforce package/MCP version consistency.
  - Added lifecycle integration coverage for Copilot/Cursor/Codex hook and wrapper parity.
  - Added upgrade-path coverage that converts legacy Claude lifecycle hooks to `hook-session-start` / `hook-stop`.
- New migration tooling for legacy findings:
  - `migrateLegacyFindings` core migration flow in shared layer.
  - New CLI: `cortex migrate-findings <project> [--pin] [--dry-run]`.
  - New MCP tool: `migrate_legacy_findings`.
- New indexer completeness controls:
  - Explicit include/exclude and hidden-doc indexing policy via `.governance/index-policy.json`.
  - New CLI: `cortex index-policy get|set ...`.
  - New MCP tool: `index_policy`.
- Runtime lifecycle health tracking in `.governance/runtime-health.json`:
  - Session start, prompt, stop, auto-save, and maintenance status timestamps.

### Changed
- Cross-tool lifecycle parity:
  - Claude/Copilot/Cursor/Codex lifecycle hooks now route through consistent commands:
    - `hook-session-start`
    - `hook-prompt`
    - `hook-stop`
  - Session wrappers now orchestrate the same lifecycle commands for consistent behavior.
- `cortex doctor` now validates runtime execution health:
  - lifecycle hook presence
  - wrapper activation in PATH
  - last prompt hook run
  - last auto-save status/result
- Search UX hardening:
  - Added FTS query builder that quotes terms and neutralizes syntax surprises.
  - Search paths now use safe query construction by default.
- `get_backlog` MCP now reads backlog files directly from disk at call time (no stale startup snapshot behavior).
- `complete_backlog_item` now marks moved entries as checked (`[x]`) in `## Done`.
- `init`/`link` now detect newer package versions and offer starter template refresh (`--apply-starter-update`).

### Fixed
- MCP backlog completion now correctly marks moved tasks as complete (`[x]`) instead of leaving unchecked entries in `## Done`.
- `get_backlog` results now stay consistent immediately after updates because they no longer rely on stale startup index snapshots.

## [1.8.6] - 2026-03-06

### Changed
- Docs site command coverage expanded:
  - Added a dedicated Commands section with day-to-day CLI flows (`init`, `doctor`, memory capture, governance, policy tuning).
  - Added direct nav link to the new Commands section.
- Docs install snippets now use `@latest` for manual MCP JSON examples to reduce stale copy/paste config.

### Fixed
- MCP server metadata version now matches package release (`1.8.6`), removing version drift in tool metadata.

## [1.8.4] - 2026-03-05

### Added
- Governance and quality controls:
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
- MCP runtime in packaged/npx installs now resolves `sql.js-fts5` WASM reliably (fixes server boot failures from invalid local WASM URL resolution).
- CLI `link` path resolution now uses ESM-safe `os.homedir()` import (removes Node `ERR_AMBIGUOUS_MODULE_SYNTAX` runtime failure).
- VS Code auto-detection now includes WSL + Windows user-install paths (`USERPROFILE/AppData/Roaming/Code/User`), including Windows-style `C:\...` path normalization.
- Conflict auto-merge git operations now use argument-safe `execFileSync("git", [...])` calls instead of shell command strings.
- Package version and MCP server version aligned to `1.8.4`.
- README MCP tool and CLI command docs updated to match current implementation.

## [1.8.3] - 2026-03-05

### Added
- Branch-aware retrieval:
  - `hook-prompt` uses task intent, branch tokens, changed files, and local-project preference to rerank/filter injected memory.
  - Injection output now includes a short reason trace (`intent`, file hits, branch hits, branch, changed file count).

## [1.8.2] - 2026-03-05

### Added
- Self-healing setup:
  - New `doctor [--fix]` command with health checks for machine/profile linkage and optional full relink repair.
  - Session-start hooks run `doctor --fix` after pull for continuous setup drift repair.

## [1.8.1] - 2026-03-05

### Added
- Automatic candidate extraction:
  - New CLI command `extract-memories [project]` mines git history and GitHub PR/review/CI/issue signals when `gh` is available.
  - High-confidence candidates are auto-written to `LEARNINGS.md`; lower-confidence items are queued in `MEMORY_QUEUE.md` for review.

## [1.8.0] - 2026-03-05

### Added
- Memory trust layer:
  - `add_learning` supports citation fields (`citation_file`, `citation_line`, `citation_repo`, `citation_commit`) and stores citation metadata for saved learnings.
  - Trust filter re-validates citations before injection, skips stale entries, and applies policy-based confidence decay (30/60/90/120 day buckets).

## [1.7.4] - 2026-03-04

### Changed
- MCP tool titles now use `◆ cortex ·` prefix for consistent branding in Claude Code's UI (e.g., "◆ cortex · search", "◆ cortex · save learning", "◆ cortex · push")
- Hook output now includes a status line before injected context: `◆ cortex · {project} · {n} results`
- Consolidation notice prefixed with `◈ cortex · consolidation ready` for visibility
- hook-context output labeled with `◆ cortex · {project} · context`

## [1.7.3] - 2026-03-04

### Added
- Consolidation detection: `hook-prompt` now scans LEARNINGS.md files for entries since the last `<!-- consolidated: -->` marker and injects a `<cortex-notice>` when a project has 25+ new entries or 60+ days without consolidation (once per session, not every prompt)
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

[Unreleased]: https://github.com/alaarab/cortex/compare/v1.10.2...HEAD
[1.10.2]: https://github.com/alaarab/cortex/compare/v1.10.0...v1.10.2
[1.10.0]: https://github.com/alaarab/cortex/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/alaarab/cortex/compare/v1.8.6...v1.9.0
[1.8.6]: https://github.com/alaarab/cortex/compare/v1.8.4...v1.8.6
[1.8.4]: https://github.com/alaarab/cortex/compare/v1.8.3...v1.8.4
[1.8.3]: https://github.com/alaarab/cortex/compare/v1.8.2...v1.8.3
[1.8.2]: https://github.com/alaarab/cortex/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/alaarab/cortex/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/alaarab/cortex/compare/v1.7.4...v1.8.0
[1.7.4]: https://github.com/alaarab/cortex/compare/v1.7.3...v1.7.4
[1.7.3]: https://github.com/alaarab/cortex/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/alaarab/cortex/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/alaarab/cortex/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/alaarab/cortex/compare/v1.6.4...v1.7.0
[1.6.4]: https://github.com/alaarab/cortex/compare/v1.6.3...v1.6.4
[1.6.3]: https://github.com/alaarab/cortex/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/alaarab/cortex/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/alaarab/cortex/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/alaarab/cortex/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/alaarab/cortex/compare/v1.3.0...v1.5.0
[1.3.0]: https://github.com/alaarab/cortex/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/alaarab/cortex/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/alaarab/cortex/compare/v1.1.0...v1.1.4
[1.1.0]: https://github.com/alaarab/cortex/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/alaarab/cortex/releases/tag/v1.0.0
