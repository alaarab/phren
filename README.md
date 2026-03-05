<div align="center">
<br>

<img src="icon.svg" width="120" alt="cortex" />

<br>

# cortex

**Long-term memory for AI coding agents.**

[![MIT License](https://img.shields.io/badge/license-MIT-7C3AED?style=flat&labelColor=0D0D0D)](LICENSE)
[![npm](https://img.shields.io/npm/v/@alaarab/cortex?style=flat&labelColor=0D0D0D&color=7C3AED)](https://www.npmjs.com/package/@alaarab/cortex)
[![Claude Code](https://img.shields.io/badge/works_with-Claude_Code-A78BFA?style=flat&labelColor=0D0D0D)](https://claude.ai)
[![Copilot](https://img.shields.io/badge/works_with-GitHub_Copilot-A78BFA?style=flat&labelColor=0D0D0D)](https://github.com/features/copilot)
[![Cursor](https://img.shields.io/badge/works_with-Cursor-A78BFA?style=flat&labelColor=0D0D0D)](https://cursor.com)
[![Codex](https://img.shields.io/badge/works_with-Codex-A78BFA?style=flat&labelColor=0D0D0D)](https://openai.com/codex)
[![Docs](https://img.shields.io/badge/docs-alaarab.github.io%2Fcortex-A78BFA?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/)

<br>

Project knowledge, lessons learned, task queues: all in markdown files you own. One command to set up. Zero commands to use after that. When your prompt mentions something cortex knows about, the context is there before the agent starts thinking.

<br>
</div>

---

## What makes this different

### It runs itself

Other memory tools need the agent to remember to call them. Cortex hooks into the agent's lifecycle directly. Every prompt you type, the hook searches your knowledge base. If it finds something relevant, it injects that context before the agent starts thinking. If not, nothing gets added. When the session ends, anything written down gets committed and pushed. You never do either of those things manually.

### It's just files

No database service. No vector store. No account or API key. Your knowledge lives in markdown files in a git repo you own. `git log` shows how it grew. `git diff` shows what changed. If something is wrong, open a file and fix it.

### Search that doesn't need exact words

Type "throttling" and it also finds "rate limit", "429", and "too many requests." Type "auth" and it finds "login" and "oauth". You don't need to remember the exact phrase you used six months ago.

### Every machine, same brain

Push your cortex to a private repo. Clone it on a new machine, run init, done. Profiles control which projects each machine sees. The work laptop gets work projects. Home gets everything.

### Builds over time

When the agent figures out a tricky pattern or hits a subtle bug, it writes that down. Next session, next week, next machine: that knowledge is there. The longer you use it, the more useful it gets.

---

## Getting started

```bash
npx @alaarab/cortex init
```

That's it. This:
- Creates `~/.cortex` with starter templates
- Registers the MCP server in Claude Code and VS Code
- Sets up hooks for automatic context injection and auto-save
- Configures hooks for any other detected agents (Copilot CLI, Cursor, Codex)
- Registers your machine

Restart your agent. Your next prompt will already have context.

### Sync across machines

```bash
cd ~/.cortex
git init && git add . && git commit -m "Initial cortex"
git remote add origin git@github.com:YOU/my-cortex.git
git push -u origin main
```

On a new machine: clone, run init, done.

---

## What lives in your cortex

Each project gets its own directory. Start with `CLAUDE.md` and add the rest as the project grows.

| File | What it's for |
|------|--------------|
| `summary.md` | Five-line card: what, stack, status, how to run, the gotcha |
| `CLAUDE.md` | Full context: architecture, commands, conventions |
| `KNOWLEDGE.md` | Deep reference: API details, data models, things too long for CLAUDE.md |
| `LEARNINGS.md` | Bugs hit, patterns discovered, things to avoid next time |
| `backlog.md` | Task queue that persists across sessions |
| `.claude/skills/` | Project-specific slash commands |

---

## How it runs itself

Before the agent sees your message, a hook extracts keywords, searches your cortex, and injects matching results as context. Generic replies, short acks, unrelated questions: nothing gets added. When something matches, it's the top 3 results, roughly 400 tokens. Runs in about 250ms.

After each response, a hook checks for cortex changes. Anything new (a learning, a backlog update) gets committed and pushed. You don't save manually.

When the context window fills and resets, a hook re-injects your project summary, recent learnings, and active backlog so the agent doesn't lose the thread.

---

## The MCP server

The server indexes your cortex into a local SQLite FTS5 database. Twelve tools available:

**Search and browse:**
- `search_cortex(query, type?, limit?)` with automatic synonym expansion
- `get_project_summary(name)` for a project's summary card and file list
- `list_projects()` for everything in your active profile
- `list_machines()` shows registered machines and their profiles
- `list_profiles()` shows all profiles and which projects each includes

**Backlog management:**
- `get_backlog(project?)` reads tasks for one or all projects
- `add_backlog_item(project, item)` adds to the Queue section
- `complete_backlog_item(project, item)` matches by text, moves to Done
- `update_backlog_item(project, item, updates)` changes priority, context, or section

**Learning capture:**
- `add_learning(project, insight)` appends under today's date
- `remove_learning(project, text)` removes by matching text
- `save_learnings(message?)` commits and pushes all changes

### CLI subcommands

For scripting, hooks, and quick lookups:

```bash
cortex search "rate limiting"        # FTS5 search with synonym expansion
cortex hook-prompt                   # reads stdin JSON, outputs context block
cortex hook-context                  # project context for current directory
cortex add-learning <project> "..."  # append a learning from the terminal
```

---

## Works with every major agent

Cortex hooks are plain shell commands. Init auto-detects which tools you have and registers them all. Use `cortex link --all-tools` to configure everything regardless of detection.

| Agent | Context injection | Auto-save | MCP tools | Instruction files |
|-------|:-----------------:|:---------:|:---------:|:-----------------:|
| Claude Code | ✓ | ✓ | ✓ | `CLAUDE.md` |
| GitHub Copilot CLI | ✓ | ✓ | ✓ | `copilot-instructions.md` |
| Cursor | ✓ (no session start) | ✓ | ✓ | — |
| OpenAI Codex | ✓ | ✓ | — | `AGENTS.md` |
| Any agentskills tool | ✓ | ✓ | — | via `cortex.SKILL.md` |

**Claude Code** — full hook support plus MCP. Init writes `~/.claude/settings.json`.

**GitHub Copilot CLI** — hooks written to `~/.github/hooks/cortex.json`. Global `CLAUDE.md` is also symlinked as `~/.github/copilot-instructions.md`. Per-project `CLAUDE.md` is also symlinked as `.github/copilot-instructions.md` in each project.

**Cursor** — hooks written to `~/.cursor/hooks.json`. Cursor has no session-start hook, so context re-injection after compaction isn't available, but prompt injection and auto-save both work.

**OpenAI Codex** — hooks written to `codex.json` in your cortex directory. Per-project `CLAUDE.md` is also symlinked as `AGENTS.md` in each project.

**Any agentskills-compatible tool** — `cortex link` writes `cortex.SKILL.md` to your cortex root with hook frontmatter. Any tool following the [Agent Skills spec](https://agentskills.io/specification) picks this up automatically.

---

## Multiple machines, one repo

`machines.yaml` maps each hostname to a profile:

```yaml
work-desktop: work
home-laptop: personal
```

Each profile lists its projects:

```yaml
# profiles/personal.yaml
name: personal
projects:
  - global
  - my-api
  - my-frontend
  - side-project
```

`cortex link` applies the profile. Sparse-checkout keeps only the listed projects on disk. First run asks for a machine name and profile. After that, zero config.

For CI or unattended setup:

```bash
npx @alaarab/cortex init --machine ci-runner --profile work
```

---

## Skills

Four skills for the things that can't be automatic:

| Skill | What it does |
|-------|-------------|
| `/cortex-sync` | Pull latest from your cortex repo and re-link on this machine. Multi-machine sync needs a manual trigger. |
| `/cortex-init` | Scaffold a new project. Creates summary.md, CLAUDE.md, backlog, adds to your profile. |
| `/cortex-discover` | Health audit. Missing files, stale content, stuck backlog items. |
| `/cortex-consolidate` | Read learnings across all projects and surface patterns that repeat. Needs human judgment about which patterns matter. |

Put personal workflow skills in `~/.cortex/global/skills/`. `cortex link` symlinks them to `~/.claude/skills/` so they're available everywhere.

---

## Building your own

Fork this repo. The split is clean: framework (`cortex link`, `mcp/`, `global/skills/`) on one side, your data (project directories, `machines.yaml`, `profiles/`) on the other.

```bash
git clone git@github.com:YOU/cortex.git ~/cortex
cd ~/cortex && npx @alaarab/cortex link
```

Or let Claude scaffold a project: `/cortex-init my-project` creates the files, asks which profile to add it to, and commits.

---

MIT License. Made by [Ala Arab](https://github.com/alaarab). Contributions welcome.
