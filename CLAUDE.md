<!-- tokens: ~1400 -->
# cortex

Open-source framework that gives Claude persistent memory across sessions and machines. Published as `cortex` on npm.

## Project Location

Source lives at `~cortex`. Published to npm. Starter templates are bundled in the package.

## Key Files

| File | Purpose |
|------|---------|
| `mcp/src/index.ts` | Entry point: CLI routing + MCP server with 50 tools |
| `mcp/src/shared.ts` | Shared infrastructure: findCortexPath, getProjectDirs, runtimeFile, sessionMarker |
| `mcp/src/shared-content.ts` | Content operations: finding CRUD, trust filtering, consolidation, canonical locks |
| `mcp/src/shared-governance.ts` | Governance: policy/access/workflow config, memory queue, audit log |
| `mcp/src/shared-index.ts` | FTS5 indexer: buildIndex, queryRows, @import resolution, file classification |
| `mcp/src/cli.ts` | CLI subcommands: search, shell, hooks, doctor, memory-ui, governance commands |
| `mcp/src/utils.ts` | Utilities: FTS5 sanitization, synonym expansion, keyword extraction |
| `mcp/src/init.ts` | `npx cortex init`: configures MCP + hooks for all detected agents |
| `mcp/src/link.ts` | Reconciles an existing install's machine/profile wiring, hooks, and local context |
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
cd ~cortex
npm run build      # compile TypeScript
npm test           # run the vitest suite
npm publish        # publish to npm (needs OTP)
```

## Current Version

v1.23.0

## MCP Tools (50)

All tools return structured JSON: `{ ok, message, data?, error? }`.

**Search and browse:**
- `search_knowledge(query, type?, limit?, project?)` : FTS5 search with synonym expansion
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
- `update_backlog_item(project, item, updates)` : update priority, context, section, or linked GitHub issue
- `link_backlog_item_issue(project, item, issue_number?, issue_url?, unlink?)` : link or unlink an existing GitHub issue on a backlog item
- `promote_backlog_item_to_issue(project, item, repo?, title?, body?, mark_done?)` : create a GitHub issue from a backlog item and link it back

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

**Skills management:**
- `list_skills(project?)` : list all installed skills with metadata
- `read_skill(name, project?)` : read full skill file content and parsed frontmatter
- `write_skill(name, content, scope)` : create or update a skill (scope: 'global' or project name)
- `remove_skill(name, project?)` : delete a skill file

**Hooks management:**
- `list_hooks(project?)` : show hook status for all tools (claude/copilot/cursor/codex) + custom hooks + config paths, optionally including per-project overrides
- `toggle_hooks(enabled, tool?, project?, event?)` : enable/disable hooks globally, per tool, or per tracked project/event
- `add_custom_hook(event, command, timeout?)` : add a custom integration hook
- `remove_custom_hook(event, command?)` : remove custom hooks by event/command match

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

cortex projects list                   List all projects
cortex projects remove <name>          Remove a project (confirmation required)
cortex mcp-mode [on|off|status]        Toggle MCP integration
cortex hooks-mode [on|off|status]      Toggle hook execution

cortex skills list                     List all installed skills
cortex skills add <project> <path>     Add a skill to a project
cortex skills remove <project> <name>  Remove a skill from a project

cortex hooks list [--project <name>]   Show hook enable/disable status per tool and optional project overrides
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
- cortex-consolidate skill: archives old entries in details block, writes marker, promotes cross-project patterns to global at 2+ projects

## Architecture

Full data flow documentation lives at `~cortex/docs/architecture.md`. Key diagram:

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
| `.governance/` | shared policy JSON and access control |
| `<project>/reference/` | Deep reference docs indexed as `reference` type |

Use `runtimeFile(cortexPath, name)` and `sessionMarker(cortexPath, name)` helpers from shared.ts.

## Key Patterns

- Starter bundled in npm package, not separate repo
- FTS5 sanitizer only strips known column prefixes (preserves URLs)
- Path traversal prevention via isValidProjectName + safeProjectPath
- Init is idempotent: re-running updates MCP + hooks without clobbering data
- node resolved-path in hooks, not npx, avoids cold-start timeout
- Hook detection uses path segments not substring to avoid false positives
- Stop hook fires after every response including subagents, so consolidation never runs from Stop
- `@import shared/file.md` in indexed docs resolves to global/ dir, with cycle detection and depth cap
- `reference/` subdirectories in projects are classified as reference type in FTS index
- Backlog done sections stripped from FTS index to reduce noise
- Init supports `--template` (python-project, monorepo, library, frontend)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_FEATURE_GIT_CONTEXT_FILTER` | disabled | Set to `'true'` to enable git-context file relevance filtering in search ranking. When enabled, docs matching currently-changed files or branch name get a boost. |
| `CORTEX_FEATURE_AUTO_CAPTURE` | disabled | Set to `'1'` to extract insights from conversation transcripts at session end (written by init walkthrough to `~/.cortex/.env`). |
| `CORTEX_EMBEDDING_API_URL` | — | OpenAI-compatible `/embeddings` endpoint (e.g. `https://api.openai.com/v1`). Takes priority over Ollama when set. |
| `CORTEX_EMBEDDING_API_KEY` | — | Bearer token for `CORTEX_EMBEDDING_API_URL`. |
| `CORTEX_FEATURE_SEMANTIC_DEDUP` | disabled | Set to `'1'` to enable LLM-based semantic deduplication on `add_finding`. Checks whether a new finding is semantically equivalent to existing ones, even with different wording. Requires LLM configured via `CORTEX_LLM_ENDPOINT` or `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. |
| `CORTEX_FEATURE_SEMANTIC_CONFLICT` | disabled | Set to `'1'` to enable LLM-based conflict detection on `add_finding`. Detects contradictions between the new finding and existing ones (e.g. "always use X" vs "never use X"). Appends `<!-- conflicts_with: "..." -->` annotations when a conflict is found. |
| `CORTEX_LLM_MODEL` | `gpt-4o-mini` / `claude-haiku-4-5-20251001` | Override the LLM model used for semantic dedup and conflict detection. |
| `CORTEX_LLM_ENDPOINT` | — | OpenAI-compatible `/chat/completions` base URL for semantic dedup/conflict (e.g. `https://api.openai.com/v1`). When set, takes priority over the Anthropic fallback. |
| `CORTEX_LLM_KEY` | — | API key for `CORTEX_LLM_ENDPOINT`. Also falls back to `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. |

**Semantic / embedding:**
| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_OLLAMA_URL` | `http://localhost:11434` | Ollama base URL for local embeddings and extraction. Set to `off` to disable Ollama entirely. |
| `CORTEX_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model used with Ollama or `CORTEX_EMBEDDING_API_URL`. |
| `CORTEX_EXTRACT_MODEL` | `llama3.2` | Ollama model used for memory extraction (`cortex maintain extract`). |
| `CORTEX_EMBEDDING_PROVIDER` | — | Set to `api` to enable OpenAI API embedding fallback in `search_knowledge` (requires `OPENAI_API_KEY`). |
| `CORTEX_FEATURE_HYBRID_SEARCH` | enabled | Set to `0` to disable TF-IDF cosine fallback in `search_knowledge`. |

**Feature flags:**
| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_FEATURE_AUTO_EXTRACT` | enabled | Set to `0` to disable automatic memory extraction from project context on each prompt. |
| `CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE` | disabled | Set to `1` to inject a compact memory index instead of full snippets; use `get_memory_detail` to expand. |

**Hook context injection:**
| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_CONTEXT_TOKEN_BUDGET` | `550` | Max tokens injected per hook-prompt call. Range: 180–10000. |
| `CORTEX_CONTEXT_SNIPPET_LINES` | `6` | Max lines per snippet in injected context. Range: 2–100. |
| `CORTEX_CONTEXT_SNIPPET_CHARS` | `520` | Max characters per snippet in injected context. Range: 120–10000. |
| `CORTEX_MAX_INJECT_TOKENS` | `2000` | Hard cap on total injected tokens across all content. Range: 200–20000. |
| `CORTEX_BACKLOG_PRIORITY` | `high,medium` | Comma-separated priorities to include in hook context backlog injection (`high`, `medium`, `low`). |
| `CORTEX_LOW_VALUE_PATTERNS` | built-in list | Comma-separated substrings; findings matching these patterns are penalised in ranking. |
| `CORTEX_CROSS_PROJECT_DECAY_DAYS` | `30` | Days over which cross-project findings decay in relevance score. |
| `CORTEX_MEMORY_TTL_DAYS` | policy value | Override memory TTL (days) for hook-prompt trust filtering. |

**Auto-capture:**
| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_AUTOCAPTURE_COOLDOWN_MS` | `30000` | Minimum ms between auto-capture runs per session to avoid thrashing. |
| `CORTEX_AUTOCAPTURE_SESSION_CAP` | `10` | Maximum findings auto-captured per session. |
| `CORTEX_CONVERSATION_CONTEXT` | — | Inject additional conversation context for auto-capture heuristics (set by hooks). |

**GitHub extraction (`cortex maintain extract`):**
| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_GH_PR_LIMIT` | `40` | Max PRs fetched per extraction run. Range: 5–200. |
| `CORTEX_GH_RUN_LIMIT` | `25` | Max CI runs fetched per extraction run. Range: 5–200. |
| `CORTEX_GH_ISSUE_LIMIT` | `25` | Max issues fetched per extraction run. Range: 5–200. |
| `CORTEX_GH_TIMEOUT_MS` | `10000` | Timeout per GitHub API call (ms). Range: 1000–60000. |
| `CORTEX_GH_RETRIES` | `2` | Retries per failed GitHub API call. Range: 0–5. |
| `CORTEX_MEMORY_EXTRACT_WINDOW_DAYS` | `30` | Look-back window (days) when extracting memories from git/GitHub. |
| `CORTEX_MEMORY_AUTO_ACCEPT` | policy value | Score threshold (0–1) above which extracted memories are auto-accepted without review. |

**Content limits:**
| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_FINDINGS_CAP` | `20` | Max findings kept per date section before triggering consolidation. |
| `CORTEX_CONSOLIDATION_CAP` | `150` | Max total findings before forced consolidation. |

**Performance and locking:**
| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_HOOK_TIMEOUT_MS` | `14000` | Timeout (ms) for hook subprocess execution. Also controls `CORTEX_HOOK_TIMEOUT_S` in shell. |
| `CORTEX_SLOW_FS_WARN_MS` | `3000` | Log a warning when filesystem operations (index build, etc.) exceed this threshold (ms). |
| `CORTEX_FILE_LOCK_MAX_WAIT_MS` | `5000` | Max time (ms) to wait for a file lock before aborting. |
| `CORTEX_FILE_LOCK_POLL_MS` | `100` | Polling interval (ms) when waiting for a file lock. |
| `CORTEX_FILE_LOCK_STALE_MS` | `30000` | Age (ms) after which a file lock is considered stale and forcibly released. |

**Access control:**
| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_ACTOR` | `$USER` | Override the actor name used in governance audit log entries. |

## Finding Quality Rules

Only store: non-obvious patterns, findings, decisions with a why, things that save time next session.
Never store: secrets/API keys, PII, one-off facts, narration of what happened, obvious stuff.
