<!-- tokens: ~1400 -->
# cortex

Open-source framework that gives Claude persistent memory across sessions and machines. Published as `@alaarab/cortex` on npm.

## Project Location

Source lives at `~/cortex`. Published to npm. Starter templates are bundled in the package.

## Key Files

| File | Purpose |
|------|---------|
| `mcp/src/index.ts` | Entry point: CLI routing + MCP server with 29 tools |
| `mcp/src/shared.ts` | Shared infrastructure: findCortexPath, getProjectDirs, runtimeFile, sessionMarker |
| `mcp/src/shared-content.ts` | Content operations: finding CRUD, trust filtering, consolidation, canonical locks |
| `mcp/src/shared-governance.ts` | Governance: policy/access/workflow config, memory queue, audit log |
| `mcp/src/shared-index.ts` | FTS5 indexer: buildIndex, queryRows, @import resolution, file classification |
| `mcp/src/cli.ts` | CLI subcommands: search, shell, hooks, doctor, memory-ui, governance commands |
| `mcp/src/utils.ts` | Utilities: FTS5 sanitization, synonym expansion, keyword extraction |
| `mcp/src/init.ts` | `npx @alaarab/cortex init`: configures MCP + hooks for all detected agents |
| `mcp/src/link.ts` | `npx @alaarab/cortex link`: sync profile, symlinks, hooks, context |
| `mcp/src/data-access.ts` | Data layer: backlog CRUD, machine/profile listing, finding management |
| `mcp/src/telemetry.ts` | Opt-in usage telemetry: tool call and CLI command tracking |
| `mcp/src/status.ts` | `cortex status`: health, project, stats overview |
| `skills/` | Cortex slash commands: sync, init, discover, consolidate |
| `starter/` | Bundled starter templates (4 project types, copied to ~/.cortex on init) |
| `starter/templates/` | Project templates: python-project, monorepo, library, frontend |
| `docs/index.html` | GitHub Pages site |
| `global/CLAUDE.md` | User-level instructions shipped with the package |

## Commands

```bash
cd ~/cortex
npm run build      # compile TypeScript
npm test           # run vitest tests (1185 tests)
npm publish        # publish to npm (needs OTP)
```

## Current Version

v1.15.5

## MCP Tools (29)

All tools return structured JSON: `{ ok, message, data?, error? }`.

**Search and browse:**
- `search_knowledge(query, type?, limit?, project?)` : FTS5 search with synonym expansion (renamed from search_cortex)
- `get_memory_detail(id)` : fetch full content of a memory by id (e.g. `mem:project/filename`); Layer 3 of progressive disclosure
- `get_project_summary(name)` : project summary + file list
- `list_projects()` : all projects in active profile
- `get_findings(project, limit?)` : read recent findings without a search query

**Backlog management:**
- `get_backlog(project?, id?, item?)` : read backlogs, or fetch a single item by ID or text
- `add_backlog_item(project, item)` : add task to queue
- `add_backlog_items(project, items[])` : bulk add multiple tasks in one call
- `complete_backlog_item(project, item)` : move task to done by text match
- `complete_backlog_items(project, items[])` : bulk complete multiple items in one call
- `update_backlog_item(project, item, updates)` : update priority, context, or section

**Finding capture:**
- `add_finding(project, finding, citation?: { file?, line?, repo?, commit? })` : append finding with optional citation
- `add_findings(project, findings[])` : bulk add multiple findings in one call
- `remove_finding(project, text)` : remove a finding by match
- `remove_findings(project, findings[])` : bulk remove multiple findings in one call
- `push_changes(message?)` : commit and push cortex changes

**Memory quality:**
- `pin_memory(project, memory)` : write canonical/pinned memory entries
- `memory_feedback(key, feedback)` : record helpful/reprompt/regression outcomes

**Data management:**
- `export_project(project)` : export project data as portable JSON
- `import_project(data)` : import project from exported JSON
- `manage_project(project, action: "archive"|"unarchive")` : archive or restore a project

**Entity graph:**
- `search_entities(name)` : find entities and related docs by name
- `get_related_docs(entity)` : get docs linked to a named entity
- `read_graph(project?)` : read the entity graph for a project or all projects
- `link_findings(project, finding_text, entity, relation?)` : manually link a finding to an entity
- `cross_project_entities()` : find entities shared across multiple projects

**Session management:**
- `session_start(project?)` : mark session start, returns prior summary + recent findings + active backlog
- `session_end(summary?)` : mark session end, save summary for next session
- `session_context()` : get current session state: project, duration, findings added so far

Governance, policy, and maintenance tools are CLI-only (see `cortex config` and `cortex maintain`).

## CLI Commands

```bash
cortex                                 Interactive shell
cortex search <query> [--project <n>]  Search knowledge base
cortex search --history                Show recent searches
cortex search --from-history <n>       Re-run search #n from history
cortex add-finding <project> "..."     Save an insight
cortex pin <project> "..."             Pin canonical memory
cortex backlog                         Cross-project backlog view
cortex skill-list                      List installed skills (alias for skills list)
cortex doctor [--fix]                  Health check and self-heal
cortex review-ui [--port=3499]         Memory review web UI
cortex status                          Health, project, stats
cortex verify                          Post-init verification checks
cortex uninstall                       Remove cortex config and hooks
cortex update                          Update to latest version

cortex link [--machine <n>] [--profile <n>]  Sync profile, symlinks, hooks
cortex mcp-mode [on|off|status]        Toggle MCP integration
cortex hooks-mode [on|off|status]      Toggle hook execution

cortex skills list                     List all installed skills
cortex skills add <project> <path>     Add a skill to a project
cortex skills remove <project> <name>  Remove a skill from a project

cortex hooks list                      Show hook enable/disable status per tool
cortex hooks enable <tool>             Enable hooks for tool (claude/copilot/cursor/codex)
cortex hooks disable <tool>            Disable hooks for tool

cortex config policy [get|set ...]     Retention, TTL, confidence, decay
cortex config workflow [get|set ...]   Approval gates, risky thresholds
cortex config access [get|set ...]     Role-based permissions
cortex config index [get|set ...]      Indexer include/exclude globs
cortex config telemetry [on|off]       Opt-in usage telemetry
cortex config machines                 Registered machines
cortex config profiles                 Profiles and projects

cortex maintain govern [project]       Queue stale memories for review
cortex maintain prune [project]        Delete expired entries
cortex maintain consolidate [project]  Deduplicate FINDINGS.md
cortex maintain migrate <project>      Promote legacy findings
cortex maintain extract [project]      Mine git/GitHub signals
```

## Hooks (registered by init, live in ~/.claude/settings.json)

| Hook | What it does |
|------|-------------|
| `UserPromptSubmit` | Runs hook-prompt: extracts keywords, searches cortex, injects context. Also checks consolidation threshold and injects cortex-notice once per session. |
| `Stop` | Auto-commits and pushes ~/.cortex changes after every response |
| `SessionStart` | git pull on ~/.cortex at session start, runs hook-context for project context |

## Consolidation System

- Detection in hook-prompt: counts entries after last `<!-- consolidated: YYYY-MM-DD -->` marker
- Threshold: 25 entries since last consolidation, OR 60 days + 10 entries
- Notice fires once per session via ~/.cortex/.noticed-{session_id} files
- details blocks in FINDINGS.md are stripped before FTS5 indexing so archived entries don't pollute search
- /cortex-consolidate skill: archives old entries in details block, writes marker, promotes cross-project patterns to global at 3+ projects

## Architecture

Full data flow documentation lives at `~/cortex/docs/architecture.md`. Key diagram:

```
User Prompt -> SessionStart (git pull) -> UserPromptSubmit (FTS5 search, inject context)
     |                                            |
     v                                            v
 MCP Tools (add_finding, backlog, etc.)    Governance (trust filter, confidence decay)
     |                                            |
     v                                            v
 ~/.cortex/<project>/ files              Stop hook (git add, commit, push)
```

Three paths on every prompt cycle:
1. **Retrieval**: keyword extraction, synonym expansion, FTS5 search, snippet injection
2. **Governance**: citation validity, confidence decay, policy thresholds
3. **Persistence**: MCP writes + Stop hook git commit/push

## Directory Structure

Ephemeral files live in subdirectories to keep the cortex root clean:

| Directory | Contents |
|-----------|----------|
| `.runtime/` | audit.log, debug.log, telemetry.json, search-history.jsonl, quality markers, lock files |
| `.sessions/` | noticed-{session}, extracted-{session} markers |
| `.governance/` | policy JSON, access control, runtime health |
| `<project>/reference/` | Deep reference docs indexed as `reference` type |

Use `runtimeFile(cortexPath, name)` and `sessionMarker(cortexPath, name)` helpers from shared.ts.
Legacy files at the root are auto-migrated on first access.

## Key Patterns

- Starter bundled in npm package, not separate repo
- FTS5 sanitizer only strips known column prefixes (preserves URLs)
- Path traversal prevention via isValidProjectName + safeProjectPath
- Init is idempotent: re-running updates MCP + hooks without clobbering data
- node resolved-path in hooks, not npx, avoids cold-start timeout
- Hook detection uses path segments not substring to avoid false positives
- Stop hook fires after every response including subagents, so consolidation never runs from Stop
- `@import shared/file.md` in indexed docs resolves to global/ dir, with cycle detection and depth cap
- `reference/` subdirectories in projects are classified as reference type in FTS index (legacy `knowledge/` also accepted)
- Backlog done sections stripped from FTS index to reduce noise
- Init supports `--template` (python-project, monorepo, library, frontend) and `--from-existing <path>`

## Finding Quality Rules

Only store: non-obvious patterns, findings, decisions with a why, things that save time next session.
Never store: secrets/API keys, PII, one-off facts, narration of what happened, obvious stuff.
