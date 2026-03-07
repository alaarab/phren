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

- Node.js 18+
- npm 9+

## Project Structure

| Path | What it does |
|------|-------------|
| `mcp/src/index.ts` | CLI routing + MCP server (22 tools) |
| `mcp/src/shared.ts` | Core logic: FTS5 indexing, querying, memory governance |
| `mcp/src/cli.ts` | CLI subcommands (search, doctor, shell, etc.) |
| `mcp/src/utils.ts` | FTS5 sanitization, synonym expansion, keyword extraction |
| `mcp/src/init.ts` | `npx @alaarab/cortex init`: configures MCP + hooks |
| `mcp/src/link.ts` | Profile sync, symlinks, hooks, context |
| `mcp/src/data-access.ts` | Backlog CRUD, machine/profile listing, learning management |
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
- If your PR adds or changes MCP tools, update `docs/api-reference.md`.
- Make sure CI passes before requesting review.

## Commit conventions

Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`

```
feat: add synonym expansion for search queries
fix: FTS5 sanitizer stripping valid URLs
docs: update API reference with bulk tools
```

## Adding a new MCP tool

1. Add the tool definition in `mcp/src/index.ts` following the existing `server.registerTool()` pattern
2. Implement the handler (call data-access functions, return `{ ok, message, data }`)
3. Add it to the tools list in `CLAUDE.md`
4. Add tests in the relevant `*.test.ts` file
5. Update `docs/api-reference.md` with the new tool's parameters

## Adding a global skill

1. Create a markdown file in `global/skills/your-skill.md`
2. Follow the existing skill format: name, description, steps
3. Test locally by running `cortex link` and invoking `/your-skill` in a Claude Code session

## Reporting Bugs

Open an issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version and OS

## Questions

Open a discussion or issue.
