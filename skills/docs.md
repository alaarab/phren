---
name: docs
description: Update and verify all phren documentation surfaces after code changes.
dependencies:
  - git
---
# phren-docs - Documentation accuracy check and update

> Keep all phren documentation surfaces in sync with the code after any change.

Invoke this after adding tools, changing CLI commands, bumping versions, or editing hooks. It walks every documentation surface, checks what's stale, and updates `docs/documentation.html` (the canonical public-facing reference).

## When to run

- After adding, removing, or renaming MCP tools
- After changing CLI commands or their flags
- After bumping the version number
- After changing hook names, events, or behavior
- Before publishing to npm
- When the user says "update the docs" or "check the docs"

## Documentation surfaces

| File | What it contains | What to check |
|------|-----------------|---------------|
| `README.md` | Project overview, install steps, quick-start | Tool count, version badge, CLI examples |
| `CLAUDE.md` | In-repo instructions for Claude | Tool count (heading says "MCP Tools (N)"), CLI command list, key file list |
| `AGENTS.md` | Agent-facing instructions | Tool count, hook table, CLI commands |
| `CONTRIBUTING.md` | Dev setup, build/test commands | `npm run build`, `npm test`, publish steps |
| `CHANGELOG.md` | Release history | Latest version matches `package.json` version |
| `docs/index.html` | GitHub Pages landing page | Install commands, version references, feature list |
| `docs/documentation.html` | Full reference doc (primary surface) | Tool count, CLI commands, hook table, env vars table |
| `docs/api-reference.md` | API / tool reference | Tool signatures, return shapes |
| `docs/architecture.md` | Data-flow diagrams and architecture | File paths, hook names, flow descriptions |
| `docs/faq.md` | Common questions and answers | References to commands, file paths |
| `docs/llms.txt` | Short LLM-friendly summary | Tool count, version, install command |
| `docs/llms-full.txt` | Full LLM-readable reference | Complete tool list, CLI commands, env vars |
| `mcp/README.md` | MCP server README | Tool count, server entry point |
| `vscode-extension/README.md` | VS Code extension README | Feature list, commands |

## Step-by-step

### 1. Read the source of truth

The source of truth for counts and signatures lives in the code, not the docs:

```bash
# Count exported MCP tools in index.ts
grep -c 'server\.tool(' mcp/src/index.ts

# Current version
node -p "require('./package.json').version"

# CLI commands (scan cli.ts / index.ts for subcommand registrations)
grep 'program\.' mcp/src/cli.ts | head -40
```

Record: **tool count**, **version**, and the list of top-level CLI subcommands.

### 2. Check each documentation surface

For each surface in the table above:

1. Read the file
2. Find every place it mentions a tool count (e.g. "65 tools", "MCP Tools (65)")
3. Find every place it mentions the version number
4. Find every CLI command listing
5. Find the hook table (event names, what each hook does)
6. Note any stale references (old file paths, renamed tools, removed commands)

### 3. Spot-check critical numbers

These numbers appear in multiple files and must all agree:

| Item | Where to verify |
|------|----------------|
| MCP tool count | `mcp/src/index.ts`: count `server.tool(` calls |
| CLI subcommand count | `mcp/src/cli.ts`: count `program.command(` calls |
| Version | `package.json` → `version` field |
| Hook events | `mcp/src/init.ts`: look for hook registration |

Run `/parity` if it is installed to automate numeric cross-checking across surfaces.

### 4. Update `docs/documentation.html`

This is the primary public reference. It must reflect the current state of the code.

Sections to verify and update:

- **Tool reference table**: every tool name, description, and parameter signature
- **CLI commands block**: every `phren <subcommand>` with flags and description
- **Hooks table**: event name, what it runs, what it does
- **Environment variables table**: variable name, default, description
- **Version number** in the page title, install command snippets, and any badges
- **Tool count** in any summary sentence (e.g. "65 MCP tools")

When updating the HTML:
- Keep existing structure and CSS classes. Do not restructure the page
- Update text content only; do not rewrite layout
- Preserve the `<details>` blocks for env var categories if they exist

### 5. Update `docs/llms.txt` and `docs/llms-full.txt`

These files are consumed by LLMs directly. Keep them plain text with no HTML.

`llms.txt`, short summary (under 60 lines):
- Tool count
- Install command
- One-line description of what phren does

`llms-full.txt`, comprehensive reference:
- All MCP tool signatures with descriptions
- All CLI commands
- All environment variables
- Directory structure

### 6. Update `CLAUDE.md` (in-repo)

The heading `## MCP Tools (N)` must match the actual tool count. Update N if it changed.

The CLI commands block must list every top-level command. Add or remove lines to match.

### 7. Sync version references

`CHANGELOG.md`: the top entry's version must match `package.json`. If a new version was bumped but the changelog has no entry yet, note it. Do not fabricate one.

`README.md` and `docs/index.html`: update any hardcoded version strings (badges, `npm install @phren/cli@X.Y.Z`, etc.).

### 8. Report

After reviewing and updating, output:

```
phren-docs

Version: 0.0.8
MCP tools: 65
CLI subcommands: 22

Surfaces checked: 14

Changes made:
  - docs/documentation.html: updated tool count (64→65), added new env var PHREN_X
  - CLAUDE.md: updated MCP Tools heading (64→65)
  - docs/llms-full.txt: added PHREN_X to env vars section

No changes needed:
  - README.md: version and tool count already correct
  - CHANGELOG.md: top entry matches package.json version
  - mcp/README.md: tool count correct

Warnings:
  - docs/faq.md: references `phren init`, command was renamed to `phren link` in v0.0.7
```

List every file checked. Be specific about what changed and what line/section.

## What not to do

- Do not restructure or reformat documentation for style. Only fix accuracy
- Do not add new sections or features to the docs without user direction
- Do not fabricate changelog entries for unreleased versions
- Do not silently skip a surface because it looks "probably fine". Check all of them
- Do not guess tool counts. Always derive from `grep` on the source file

## Related skills

- `/parity`: numeric cross-check across all documentation surfaces
- `/consolidate`: surface cross-project patterns before updating architecture docs
- `/discover`: find gaps in project documentation
