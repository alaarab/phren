# phren MCP server

MCP server that indexes your personal phren and exposes it to AI agents via full-text search.

On startup it walks your phren directory, reads all `.md` files, and builds an in-memory SQLite FTS5 index.

Public surface: 66 MCP tools across 12 modules (search, tasks, findings, memory, data, graph, sessions, ops/review, skills, hooks, config, extraction).

Notable shipped capabilities:
- finding lifecycle tools: `supersede_finding`, `retract_finding`, `resolve_contradiction`, `get_contradictions`
- finding provenance: `add_finding.source` (`human|agent|hook|extract|consolidation|unknown`)
- cross-session continuity: task checkpoints + `session_history`
- finding impact scoring from injected-context outcomes
- skill registry behavior: scope precedence, alias-collision handling, visibility gating, generated `skill-manifest.json`
- lifecycle penalties: superseded 0.25×, retracted 0.1×, contradicted 0.4× confidence in retrieval
- inactive findings stripped from FTS index (superseded/retracted findings cannot appear in search)
- auto-tagging: findings without type tags are inferred from content at write time
- session context diff: `session_start` reports new findings since last session
- decay resistance: confirmed findings decay 3× slower when repeatedly useful

## Install

```bash
npm install -g @phren/cli
phren init
```

Or add manually to Claude Code:

```bash
claude mcp add phren -- phren ~/.phren
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PHREN_PATH` | `~/.phren` | Path to your phren instance |
| `PHREN_PROFILE` | *(none)* | Active profile name. When unset, phren uses `machines.yaml` when available and otherwise falls back to an unscoped view |
| `PHREN_ACTOR` | OS user / env | Actor identity used in governance/audit RBAC checks |

## Tools

See [docs/api-reference.md](../docs/api-reference.md) for the full API reference.

## Integration model

- Claude: full native lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PostToolUse`) + MCP
- Copilot CLI / Cursor / Codex: MCP + generated hook config + session wrapper binaries

## Governance and security highlights

- RBAC uses `.governance/access-control.json` and `.runtime/access-control.local.json`
- Web UI binds loopback-only, uses per-run auth token, enforces CSRF for mutations, and sets CSP headers
- Telemetry is opt-in only (`phren config telemetry on`) and stored locally in `.runtime/telemetry.json`

### search_knowledge

Full-text search across all indexed markdown files with synonym expansion.

```
query: string              - FTS5 query (supports AND, OR, NOT, "phrase matching")
limit?: number             - Max results, 1-20, default 5
type?: string              - Filter: "claude", "findings", "reference", "summary", "task", "skill"
project?: string           - Filter to a specific project
tag?: string               - Filter findings by type tag: decision, pitfall, pattern, tradeoff, architecture, bug
since?: string             - Filter findings by date: "7d", "30d", "YYYY-MM", "YYYY-MM-DD"
status?: string            - Filter by lifecycle status: active, superseded, contradicted, stale, invalid_citation, retracted
include_history?: boolean  - Include superseded/retracted findings (default false)
synthesize?: boolean       - Generate a synthesis paragraph from top results using an LLM
```

### get_project_summary

Returns a project's summary.md content, path to its CLAUDE.md, and a list of indexed files.

```
name: string      - Project name (e.g. "my-app", "backend")
```

### list_projects

Lists all projects in the active profile with a brief description and which docs exist.

No parameters.

## How it works

1. Reads `PHREN_PATH` (or defaults to `~/.phren`)
2. Resolves the active profile from `PHREN_PROFILE`, or from `machines.yaml` when the env var is unset
3. If no active profile can be resolved yet, falls back to an unscoped view of top-level project directories
4. Walks each project directory, reads `.md` files, classifies them by filename
5. Builds an in-memory SQLite FTS5 index with Porter stemming
6. Serves tools over stdio using the MCP protocol

File types are derived from filenames: `CLAUDE.md` -> "claude", `summary.md` -> "summary", `FINDINGS.md` -> "findings", `tasks.md` -> "task", files under `reference/` -> "reference", files under `skills/` -> "skill".

## Development

```bash
cd ~/phren
npm install
npm run build    # Compile TypeScript
npm run dev      # Run with tsx (hot reload)
npm test         # Run all tests
```
