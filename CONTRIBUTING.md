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

## Tests

Tests use [Vitest](https://vitest.dev/) and live alongside the source files:

```bash
npm test                          # run all tests
npx vitest run mcp/src/shared     # run a specific test file
npx vitest --watch                # watch mode
```

Test files: `*.test.ts` in `mcp/src/`. Currently around 105 tests covering search, data access, hooks, init, link, shell, and shared utilities.

When adding a new feature, add tests in the same directory as the source file.

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

## Commit Messages

Use present tense, imperative mood:

```
add synonym expansion for search queries
fix FTS5 sanitizer stripping valid URLs
update memory governance to respect TTL policy
```

No need for conventional commit prefixes (`feat:`, `fix:`, etc.) unless you prefer them.

## Adding a Global Skill

1. Create a markdown file in `global/skills/your-skill.md`.
2. Follow the existing skill format: name, description, steps.
3. Test it locally by running `cortex link` and invoking `/your-skill` in a Claude Code session.
4. Open a PR with the skill file.

### Skill Format

```markdown
# /skill-name

One sentence description.

## Steps

1. What to do first
2. What to do next
3. How to verify it worked
```

Keep skills focused. One skill, one job. If it does two things, make two skills.

Skills are markdown instructions with no test runner. The test is: does Claude do the right thing when you invoke it?

## Reporting Bugs

Open an issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version and OS

## Questions

Open a discussion or issue.
