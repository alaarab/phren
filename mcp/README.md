# cortex MCP server

MCP server that indexes your personal cortex and exposes it to AI agents via full-text search.

On startup it walks your cortex directory, reads all `.md` files, and builds an in-memory SQLite FTS5 index. 51 tools let agents search, browse, manage tasks, capture findings, link task items to GitHub issues, and track entities across your projects.

## Install

```bash
npm install -g @alaarab/cortex
cortex init
```

Or add manually to Claude Code:

```bash
claude mcp add cortex -- cortex ~/.cortex
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_PATH` | `~/.cortex` | Path to your cortex instance |
| `CORTEX_PROFILE` | *(none)* | Active profile name. When unset, cortex uses `machines.yaml` when available and otherwise falls back to an unscoped view |

## Tools

See [docs/api-reference.md](../docs/api-reference.md) for the full API reference.

### search_knowledge

Full-text search across all indexed markdown files with synonym expansion.

```
query: string     - FTS5 query (supports AND, OR, NOT, "phrase matching")
limit?: number    - Max results, 1-20, default 5
type?: string     - Filter: "claude", "findings", "reference", "summary", "task", "skill"
project?: string  - Filter to a specific project
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

1. Reads `CORTEX_PATH` (or defaults to `~/.cortex`)
2. Resolves the active profile from `CORTEX_PROFILE`, or from `machines.yaml` when the env var is unset
3. If no active profile can be resolved yet, falls back to an unscoped view of top-level project directories
4. Walks each project directory, reads `.md` files, classifies them by filename
5. Builds an in-memory SQLite FTS5 index with Porter stemming
6. Serves tools over stdio using the MCP protocol

File types are derived from filenames: `CLAUDE.md` -> "claude", `summary.md` -> "summary", `FINDINGS.md` -> "findings", `tasks.md` -> "task", files under `reference/` -> "reference", files under `skills/` -> "skill".

## Development

```bash
cd ~cortex
npm install
npm run build    # Compile TypeScript
npm run dev      # Run with tsx (hot reload)
npm test         # Run all tests
```
