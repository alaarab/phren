# Contributing to Phren

Thanks for your interest in contributing. This guide covers what you need to get started.

## Dev Setup

```bash
git clone https://github.com/alaarab/phren.git
cd phren
pnpm install
pnpm build
pnpm test
```

This is a pnpm monorepo managed by [Turborepo](https://turbo.build/). `pnpm build` compiles all packages via `turbo run build`. `pnpm test` runs vitest from the workspace root.

### Prerequisites

- Node.js 20+
- pnpm 10+

## Project Structure

The repo is a monorepo defined by `pnpm-workspace.yaml` with three packages:

| Package | Path | What it does |
|---------|------|-------------|
| `@phren/cli` | `packages/cli/` | CLI, MCP server, hooks, data layer, web UI |
| `@phren/agent` | `packages/agent/` | Built-in coding agent with TUI, multi-agent, provider abstraction |
| `phren-vscode` | `packages/vscode/` | VS Code extension: sidebar, onboarding, config panel |

### `packages/cli/src/` (the core)

| Path | What it does |
|------|-------------|
| `index.ts` | CLI routing + MCP server bootstrap |
| `shared.ts` | Shared path/runtime helpers and core exports |
| `cli.ts` | CLI subcommands (search, doctor, shell, etc.) |
| `utils.ts` | FTS5 sanitization, synonym expansion, keyword extraction |
| `init.ts` | `phren init`: configures MCP + hooks |
| `link.ts` | Profile sync, symlinks, hooks, context |
| `data/access.ts` | Findings, queue, and data access |
| `data/tasks.ts` | Task CRUD |
| `tools/` | MCP tool modules (search/tasks/finding/memory/data/graph/session/ops/skills/hooks/extract/config) |
| `skill-registry.ts` | Skill precedence, alias collision handling, visibility gating |
| `governance-policy.ts` | RBAC, policy files, actor resolution |
| `ui/server.ts` | Web UI server, auth/CSRF/CSP/loopback security model |
| `telemetry.ts` | Opt-in local telemetry collection and summaries |

### `packages/agent/src/` (the coding agent)

| Path | What it does |
|------|-------------|
| `agent-loop.ts` | Core agent loop: turn execution, tool calling, context pruning |
| `index.ts` | CLI entry point, provider/tool wiring |
| `commands.ts` | 23 slash commands for the interactive TUI |
| `tui.ts` | Full-screen TUI with status bar, streaming, input modes |
| `providers/` | LLM providers: Anthropic, OpenRouter, OpenAI, Codex, Ollama |
| `tools/` | Agent tools: file I/O, shell, git, grep, glob, phren memory |
| `multi/` | Multi-agent spawner, coordinator, TUI |
| `permissions/` | Permission system: suggest, auto-confirm, full-auto |

### Other top-level paths

| Path | What it does |
|------|-------------|
| `turbo.json` | Turborepo build pipeline config |
| `pnpm-workspace.yaml` | Workspace package declarations |
| `starter/` | Template files copied to `~/.phren` on init |
| `docs/` | GitHub Pages site and documentation |
| `skills/` | Phren slash command definitions |

## Running specific tests

```bash
pnpm test                                                  # run all tests
pnpm -w test -- packages/cli/src/__tests__/mcp-search.test.ts  # run one file
pnpm -w test -- --grep "pattern"                           # filter by test name
npx vitest --watch                                         # watch mode
```

Test files: `*.test.ts` in `packages/cli/src/` and `packages/agent/src/`. When adding a new feature, add tests in the same directory or in `__tests__/`.

## Code Style

Read `CLAUDE.md` for the full set of conventions. The highlights:

- **No AI voice.** No "robust", "seamless", "leverage", "comprehensive". Write like a person.
- **No em dashes.** Use a colon, a comma, or rewrite the sentence.
- **No filler comments.** If the code is clear, it does not need a comment restating what it does.
- **No over-documentation.** Only add comments where the logic is not self-evident.
- **Keep it simple.** Don't add abstractions for one-time operations. Three similar lines beat a premature helper function.

## Making Changes

1. Create a feature branch from `main`.
2. Make your changes with tests.
3. Run `pnpm build && pnpm test` and make sure everything passes.
4. Keep commits focused. One logical change per commit.
5. Write commit messages that explain *why*, not just *what*.

## Pull Requests

- Keep PRs small and focused. One feature or fix per PR.
- Include a short description of what changed and why.
- If your PR changes user-facing behavior, update the README.
- If your PR adds or changes MCP tools, update:
  - `docs/api-reference.md`
  - `docs/llms-install.md`
  - `docs/llms-full.txt`
- If your PR changes finding lifecycle/provenance, session checkpoints/history, web-ui security, RBAC identity, or telemetry behavior, update the matching docs in `docs/` in the same PR.
- Make sure CI passes before requesting review.

## Commit conventions

Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`

```
feat: add synonym expansion for search queries
fix: FTS5 sanitizer stripping valid URLs
docs: update API reference with bulk tools
```

## Adding a new MCP tool

1. Add the tool definition in the correct module (`packages/cli/src/tools/<domain>.ts`) following the existing `server.registerTool()` pattern
2. Implement the handler (call data-access functions, return `{ ok, message, data }`)
3. Register/verify the module from `packages/cli/src/index.ts` if you created a new module
4. Add tests in `packages/cli/src/__tests__/`
5. Update docs:
   - `docs/api-reference.md` parameters and examples
   - `docs/llms-install.md` / `docs/llms-full.txt` tool listings
   - integration/security/governance docs when behavior affects hooks, skills, RBAC, web UI, or telemetry

## Adding a global skill

1. Create a markdown file in `global/skills/your-skill.md`
2. Follow the existing skill format: name, description, steps
3. Test locally by running `phren init` and invoking `/your-skill` in a Claude Code session

## Reporting Bugs

Open an issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version and OS

## Questions

Open a discussion or issue.
