<p align="center"><img src="docs/phren-transparent.png" width="180" alt="phren"></p>

<h3 align="center">Your agents forget everything. Phren doesn't.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@phren/cli"><img src="https://img.shields.io/npm/v/%40phren%2Fcli?style=flat&labelColor=0D0D0D&color=7C3AED" alt="npm version"></a>
  <a href="https://github.com/alaarab/phren/blob/main/LICENSE"><img src="https://img.shields.io/github/license/alaarab/phren?style=flat&labelColor=0D0D0D&color=7C3AED" alt="license"></a>
</p>

<p align="center">
Phren is a git-backed knowledge layer that gives AI agents persistent memory across sessions, projects, and machines. Findings, decisions, and patterns are captured as markdown in a repo you control — no hosted service, no vendor lock-in.
</p>

---

## Install

```bash
npx @phren/cli init
```

That single command creates `~/.phren`, wires up MCP, installs hooks, and gives your agents a memory they can actually keep. Re-running on a new machine with an existing remote picks up right where you left off.

## What phren does

- **Captures findings** from your coding sessions — bugs hit, patterns discovered, architectural decisions and their reasoning
- **Surfaces relevant context on every prompt** via hooks, so agents build on what they already know instead of starting fresh
- **Syncs across machines** through ordinary git push/pull — no coordination service required
- **Works with Claude Code, Copilot, Cursor, and Codex** — tell one agent something, and the others know it next session
- **Ships a shell and web UI** for browsing, searching, and triaging everything phren knows (`phren` or `phren web-ui`)

## Quick start

```bash
npx @phren/cli init          # set up phren (interactive walkthrough)
```

Init detects your tools, registers MCP servers, and installs lifecycle hooks. After it finishes, open a prompt in any tracked project — phren is already injecting context.

To add a project later, run `phren add` from that directory. To browse what phren knows, run `phren` to open the interactive shell.

## Learn more

- [Documentation site](https://alaarab.github.io/phren/)
- [Whitepaper (PDF)](https://alaarab.github.io/phren/whitepaper.pdf)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

---

MIT License. Made by [Ala Arab](https://github.com/alaarab).
