<p align="center"><img src="docs/phren-transparent.png" width="180" alt="phren"></p>

<h3 align="center">Your agents forget everything. Phren doesn't.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@phren/cli"><img src="https://img.shields.io/npm/v/%40phren%2Fcli?style=flat&labelColor=0D0D0D&color=7C3AED" alt="npm version"></a>
  <a href="https://github.com/alaarab/phren/blob/main/LICENSE"><img src="https://img.shields.io/github/license/alaarab/phren?style=flat&labelColor=0D0D0D&color=7C3AED" alt="license"></a>
  <a href="https://alaarab.github.io/phren/"><img src="https://img.shields.io/badge/docs-alaarab.github.io%2Fphren-7C3AED?style=flat&labelColor=0D0D0D" alt="docs"></a>
  <a href="https://alaarab.github.io/phren/whitepaper.pdf"><img src="https://img.shields.io/badge/whitepaper-PDF-7C3AED?style=flat&labelColor=0D0D0D" alt="whitepaper"></a>
</p>

<p align="center">
A coding agent with persistent memory. Findings, tasks, and patterns live in markdown files in a git repo you control. No database, no vendor lock-in.
</p>

---

## What is phren?

**A coding agent** that reads, writes, and edits your code with tool calling. It starts each session knowing your project's gotchas, active tasks, and past decisions — because it remembers them.

**A memory layer** for any AI agent. 53 MCP tools, session hooks, and FTS5 full-text search let Claude Code, Copilot, Cursor, and Codex share persistent context across conversations and machines.

---

## Quickstart

### A) Use the agent

```bash
npm i -g @phren/cli @phren/agent
phren init
phren agent -i                              # interactive TUI
phren agent "fix the login bug"             # one-shot task
phren agent --yolo "add input validation"   # full-auto, no confirmations
```

### B) Add memory to your existing agent

```bash
npx @phren/cli init
```

One command. Sets up `~/.phren`, wires MCP into Claude Code / Copilot / Cursor / Codex, and installs hooks. Next time you open a prompt, context flows automatically.

### C) VS Code extension

Install **Phren** from the VS Code marketplace. It runs `phren init` on first activation, then gives you a sidebar with projects, findings, tasks, and a knowledge graph.

---

## The Agent

```bash
phren agent <task>           # run a task
phren agent -i               # interactive TUI (multi-turn)
phren agent --plan <task>    # review plan before execution
phren agent --resume         # resume last session
phren agent --multi          # multi-agent TUI
```

### CLI flags

| Flag | Description |
|------|-------------|
| `-i`, `--interactive` | Interactive TUI with streaming, history, tab completion |
| `--provider <name>` | Force provider: `openrouter`, `anthropic`, `openai`, `codex`, `ollama` |
| `--budget <dollars>` | Max spend in USD (aborts when exceeded) |
| `--plan` | Show plan before executing tools |
| `--yolo` | Full-auto permissions — no confirmations |
| `--resume` | Resume last session's conversation |
| `--multi` | Multi-agent TUI mode |
| `--team <name>` | Team mode with shared task coordination |
| `--verbose` | Debug-level logging |

### Providers

| Provider | Model | Source |
|----------|-------|--------|
| OpenRouter | claude-sonnet-4-20250514 | `OPENROUTER_API_KEY` |
| Anthropic | claude-sonnet-4-20250514 | `ANTHROPIC_API_KEY` |
| OpenAI | gpt-4.1 | `OPENAI_API_KEY` |
| Codex | gpt-5.3-codex | ChatGPT subscription (browser auth) |
| Ollama | llama3.3 | Local, no API key |

### Keyboard shortcuts (interactive TUI)

| Key | Action |
|-----|--------|
| Tab | Toggle memory browser |
| Shift+Tab | Cycle permission mode |
| Up/Down | Input history |
| Left/Right | Cursor movement |
| Ctrl+A / Ctrl+E | Start / end of line |
| Ctrl+U / Ctrl+K | Kill line / kill forward |
| Ctrl+W | Delete word |
| Alt+Left/Right | Jump word |
| `!` | Enter bash mode |
| Ctrl+C | Progressive cancel/quit |
| Ctrl+D | Exit |

### Slash commands

`/help` `/model` `/provider` `/cost` `/plan` `/undo` `/compact` `/context` `/history` `/turns` `/clear` `/files` `/cwd` `/diff` `/git` `/spawn` `/agents` `/preset` `/exit`

### Tools

File I/O (read, write, edit), shell, glob, grep, git (status, diff, commit), web fetch, web search, plus phren memory tools (search, add finding, add task, get tasks, complete task).

### Multi-agent

Spawn sub-agents from the TUI with `/spawn <name> <task>`. Agents run as child processes with IPC messaging and shared task coordination.

---

## The Memory Layer

### How it works

**When you open a prompt:**
- Hooks extract keywords from your question
- Phren searches findings across projects (FTS5 full-text with semantic fallback)
- Relevant snippets inject into your prompt before you hit send

**When you discover something:**
- `add_finding` captures it with tags (`[decision]`, `[pattern]`, `[pitfall]`, `[bug]`)
- Trust scores decay over time; decisions never do; observations expire in 14 days
- Findings link to fragments (named concepts) that connect knowledge across projects

**Sessions:**
- `session_start` / `session_end` mark boundaries
- Next session sees your prior summary, active tasks, and where you left off
- Checkpoints track edited files and failing tests for exact resume

### What's stored

| Concept | Description |
|---------|-------------|
| **Findings** | Decisions, patterns, pitfalls, bugs. Typed and tagged. Decay over time. |
| **Sessions** | Summaries, checkpoints, file lists. Resume where you left off. |
| **Tasks** | Priority, sections, GitHub issue links. Cross-project rollups. |
| **Fragments** | Named concepts that link findings across projects. Graph-navigable. |
| **Truths** | Pinned findings that always inject into context. |

### 53 MCP tools

Search, add/edit/retract/supersede findings, manage tasks, read the knowledge graph, control sessions, configure governance policies, and more. See [docs](https://alaarab.github.io/phren/) for the full reference.

### Team stores

Shared knowledge repos for teams. One person creates with `phren team init`, others join with `phren team join`. Findings, tasks, and skills sync via git.

```bash
phren team init my-team --remote git@github.com:org/phren-store.git
phren team join git@github.com:org/phren-store.git
phren store subscribe my-team arc intranet    # only see what you care about
```

### Skills and hooks

Drop custom slash commands into `~/.phren/global/skills/`. Hooks run on user prompt, tool use, and session events — wire phren into your own workflows.

### Governance

Per-project retention policies, confidence decay curves, review queues, semantic dedup, contradiction detection. Configure with `phren config` or the VS Code extension settings.

---

## Platform support

| Platform | Integration |
|----------|-------------|
| **Claude Code** (VS Code, Web, Desktop) | MCP server + session hooks |
| **GitHub Copilot** (VS Code, GitHub.com) | MCP server + hooks |
| **Cursor** (IDE) | MCP server + skill system |
| **Codex** (OpenAI) | MCP tools + hooks |
| **VS Code Extension** | Sidebar UI, knowledge graph, task viewer, setup wizard |

All platforms share the same `~/.phren` store. No vendor lock-in.

---

## Project structure

```
packages/
  cli/      @phren/cli     — CLI, MCP server, data layer (53 tools, FTS5, hooks)
  agent/    @phren/agent   — Coding agent with TUI (providers, tools, multi-agent)
  vscode/   phren-vscode   — VS Code extension (sidebar, graph, onboarding)
```

---

## Contributing

```bash
git clone https://github.com/alaarab/phren.git
cd phren
pnpm install
pnpm build
pnpm test
```

See [CLAUDE.md](CLAUDE.md) for development conventions and the full CLI reference.

---

MIT License. Made by [Ala Arab](https://github.com/alaarab).
