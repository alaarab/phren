<!-- tokens: ~900 -->
# CLAUDE.md

Open-source knowledge layer for AI agents. Published as `@phren/cli` on npm.

## Project Location

Source lives at `~phren`. Published to npm. Starter templates are bundled in the package.

## Monorepo Structure

pnpm workspace with turborepo. Three packages:

| Package | Path | npm | Description |
|---------|------|-----|-------------|
| `@phren/cli` | `packages/cli/` | Published | CLI, MCP server, data layer |
| `@phren/agent` | `packages/agent/` | Published | Standalone coding agent |
| `@phren/vscode` | `packages/vscode/` | VS Code Marketplace | VS Code extension |

## Key Files

| File | Purpose |
|------|---------|
| `packages/cli/src/index.ts` | Entry point: CLI routing + MCP server with 54 tools |
| `packages/cli/src/shared.ts` | Shared infrastructure: findPhrenPath, getProjectDirs, runtimeFile, sessionMarker |
| `packages/cli/src/content/` | Content operations: finding CRUD, trust filtering, dedup, consolidation |
| `packages/cli/src/governance/` | Governance: policy/access/workflow config, review queue, audit log, locks |
| `packages/cli/src/shared/index.ts` | FTS5 indexer: buildIndex, queryRows, @import resolution, file classification |
| `packages/cli/src/cli/cli.ts` | CLI subcommands: search, shell, hooks, doctor, memory-ui, governance commands |
| `packages/cli/src/utils.ts` | Utilities: FTS5 sanitization, synonym expansion, keyword extraction |
| `packages/cli/src/init/init.ts` | `phren init`: configures MCP + hooks for all detected agents |
| `packages/cli/src/link/` | Reconciles an existing install's machine/profile wiring, hooks, and local context |
| `packages/cli/src/data/access.ts` | Data layer: task CRUD, machine/profile listing, finding management |
| `packages/cli/src/telemetry.ts` | Opt-in usage telemetry: tool call and CLI command tracking |
| `packages/cli/src/status.ts` | `phren status`: health, project, stats overview |
| `packages/cli/skills/` | Phren slash commands: sync, init, discover, consolidate, profiles, docs |
| `packages/cli/starter/` | Bundled starter templates (4 project types, copied to ~/.phren on init) |
| `packages/cli/starter/templates/` | Project templates: python-project, monorepo, library, frontend |
| `docs/index.html` | GitHub Pages site |
| `global/CLAUDE.md` | User-level instructions shipped with the package |

## Commands

```bash
cd ~phren
pnpm build         # compile TypeScript (all packages)
pnpm test          # run the vitest suite
pnpm lint          # lint all packages
```

## Current Version

0.1.16

## Reference Documentation

See `reference/topics/` for detailed documentation:
- `mcp-tools.md` -- all 54 MCP tools
- `cli-commands.md` -- full CLI command reference
- `agent.md` -- built-in coding agent, providers, multi-agent
- `hooks.md` -- lifecycle hooks, consolidation system, key patterns
- `environment.md` -- environment variables, directory structure, finding quality rules
- `architecture.md` -- system architecture and design patterns
