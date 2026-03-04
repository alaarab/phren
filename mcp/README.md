# @cortex/mcp

MCP server that indexes your personal cortex and exposes it to Claude via full-text search.

On startup it walks your cortex directory, reads all `.md` files, and builds an in-memory SQLite FTS5 index. Three tools let Claude search, browse, and summarize your projects without reading every file.

## Install

```bash
# Add to Claude Code
claude mcp add cortex -- npx @cortex/mcp

# Or run directly
npx @cortex/mcp
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_PATH` | `~/cortex` or `~/my-cortex` | Path to your cortex instance |
| `CORTEX_PROFILE` | *(none)* | Active profile name. Reads `profiles/<name>.yaml` to filter projects |

If no profile is set, all top-level directories in the cortex are indexed.

## Tools

### search_cortex

Full-text search across all indexed markdown files.

```
query: string     - FTS5 query (supports AND, OR, NOT, "phrase matching")
limit?: number    - Max results, 1-20, default 5
type?: string     - Filter: "claude", "learnings", "knowledge", "summary", "backlog", "skill"
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

1. Reads `CORTEX_PATH` (or finds `~/cortex`)
2. If `CORTEX_PROFILE` is set, reads `profiles/<profile>.yaml` for the project list
3. Otherwise indexes all top-level directories
4. Walks each project directory, reads `.md` files, classifies them by filename
5. Builds an in-memory SQLite FTS5 index
6. Serves tools over stdio using the MCP protocol

File types are derived from filenames: `CLAUDE.md` -> "claude", `summary.md` -> "summary", `LEARNINGS.md` -> "learnings", `KNOWLEDGE.md` -> "knowledge", `backlog.md` -> "backlog", files under `skills/` -> "skill".

## When MCP isn't available

If you can't use MCP (e.g. in a web chat), the cortex still works through:

- `MEMORY.md` files loaded into context automatically
- Direct file reads of CLAUDE.md, LEARNINGS.md, etc.
- The `/sync` skill to pull relevant context into your project

MCP just makes it searchable without loading everything into context.

## Development

```bash
cd mcp
npm install
npm run dev      # Run with tsx (hot reload)
npm run build    # Compile TypeScript
npm start        # Run compiled JS
```
