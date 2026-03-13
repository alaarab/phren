# Contributing to Cortex

Thanks for your interest in contributing. This guide covers what you need to get started.

## Dev Setup

```bash
git clone https://github.com/alaarab/cortex.git
cd cortex
npm install
npm run build
npm test
```

The build compiles TypeScript from `mcp/src/` into `mcp/dist/` and marks the entry point executable.

### Prerequisites

- Node.js 20+
- npm 9+

## Project Structure

| Path | What it does |
|------|-------------|
| `mcp/src/index.ts` | CLI routing + MCP server bootstrap (60 public tools across 11 modules) |
| `mcp/src/shared.ts` | Shared path/runtime helpers and core exports |
| `mcp/src/cli.ts` | CLI subcommands (search, doctor, shell, etc.) |
| `mcp/src/utils.ts` | FTS5 sanitization, synonym expansion, keyword extraction |
| `mcp/src/init.ts` | `npx cortex init`: configures MCP + hooks |
| `mcp/src/link.ts` | Profile sync, symlinks, hooks, context |
| `mcp/src/data-access.ts` | Task CRUD, machine/profile listing, learning management |
| `mcp/src/mcp-*.ts` | MCP module handlers (search/tasks/findings/memory/data/graph/session/ops/skills/hooks/extract) |
| `mcp/src/skill-registry.ts` | Skill precedence, alias collision handling, visibility gating, manifest generation |
| `mcp/src/governance-policy.ts` | RBAC, policy files, actor resolution (`CORTEX_ACTOR` + local access control) |
| `mcp/src/memory-ui-server.ts` | Web UI server, auth/CSRF/CSP/loopback security model |
| `mcp/src/telemetry.ts` | Opt-in local telemetry collection and summaries |
| `starter/` | Template files copied to `~/.cortex` on init |
| `docs/` | GitHub Pages site and documentation |
| `skills/` | Cortex slash command definitions |

## Running specific tests

```bash
npm test                              # run all tests
npm test -- --grep "pattern"          # filter by test name
npm test -- mcp/src/data-access.test  # run one file
npx vitest --watch                    # watch mode
```

Test files: `*.test.ts` in `mcp/src/`. When adding a new feature, add tests in the same directory as the source file.

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
3. Run `npm run build && npm test` and make sure everything passes.
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

1. Add the tool definition in the correct module (`mcp/src/mcp-<domain>.ts`) following the existing `server.registerTool()` pattern
2. Implement the handler (call data-access functions, return `{ ok, message, data }`)
3. Register/verify the module from `mcp/src/index.ts` if you created a new module
4. Add tests in the relevant `*.test.ts` file
5. Update docs:
   - `docs/api-reference.md` parameters and examples
   - `docs/llms-install.md` / `docs/llms-full.txt` tool listings
   - integration/security/governance docs when behavior affects hooks, skills, RBAC, web UI, or telemetry

## Adding a global skill

1. Create a markdown file in `global/skills/your-skill.md`
2. Follow the existing skill format: name, description, steps
3. Test locally by running `cortex init` and invoking `/your-skill` in a Claude Code session

## Reporting Bugs

Open an issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version and OS

## Questions

Open a discussion or issue.
