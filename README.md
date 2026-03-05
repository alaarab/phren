<div align="center">
<br>

<img src="icon.svg" width="120" alt="cortex" />

<br>

# cortex

**Long-term memory for Claude Code.**

[![MIT License](https://img.shields.io/badge/license-MIT-7C3AED?style=flat&labelColor=0D0D0D)](LICENSE)
[![npm](https://img.shields.io/npm/v/@alaarab/cortex?style=flat&labelColor=0D0D0D&color=7C3AED)](https://www.npmjs.com/package/@alaarab/cortex)
[![Claude Code](https://img.shields.io/badge/works_with-Claude_Code-A78BFA?style=flat&labelColor=0D0D0D)](https://claude.ai)
[![VS Code](https://img.shields.io/badge/works_with-GitHub_Copilot-A78BFA?style=flat&labelColor=0D0D0D)](https://github.com/features/copilot)
[![Docs](https://img.shields.io/badge/docs-alaarab.github.io%2Fcortex-A78BFA?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/)

<br>

Project knowledge, lessons learned, task queues: all in markdown files you own. One command to set up. Zero commands to use after that. Claude gets your context automatically on every prompt.

<br>
</div>

---

## What makes this different

### It runs itself

Other memory tools need Claude to remember to call them. Cortex hooks into Claude Code's lifecycle directly. Every prompt you type, the hook searches your knowledge base and injects the relevant context before Claude even starts thinking. Learnings auto-commit when the session ends. You never have to remember to save or search.

### It's just files

No database service. No vector store running on a port. No account or API key. Your knowledge lives in markdown files in a git repo. `git log` shows how it evolved. `git diff` shows what changed. If something is wrong, you open a file and fix it.

### Search understands what you mean

Type "throttling" and it also finds "rate limit", "429", and "too many requests." The synonym engine covers common dev terms: auth matches login and oauth, deploy matches release and ship, db matches database and postgres. You don't need to guess the exact word you used six months ago.

### Every machine, same brain

Push your cortex to a private repo. Clone it on another machine, run init, done. Profiles control which projects each machine sees: the work laptop gets work projects, the home setup gets everything. Git sparse-checkout keeps the boundaries clean.

### Claude gets smarter over time

When Claude figures out a tricky pattern or hits a subtle bug, it writes that down in your LEARNINGS.md. Next session, next week, next machine: that knowledge is there. Over time your learnings files become a project history worth more than any ticket system.

---

## Getting started

```bash
npx @alaarab/cortex init
```

That's it. This:
- Creates `~/.cortex` with starter templates
- Registers the MCP server in Claude Code and VS Code
- Sets up hooks for automatic context injection and auto-save
- Registers your machine

Restart Claude Code. Your next prompt will already have context.

Already have cortex? Run init again to pick up the v1.7.0 hooks.

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

## How the automatic context works

### On every prompt (UserPromptSubmit hook)

When you type a message, the hook:
1. Extracts keywords from your prompt (strips filler words)
2. Detects which project you're in from your working directory
3. Searches your cortex with synonym expansion
4. Injects the top results as context before Claude sees the prompt

This takes ~250ms. Claude starts every response knowing what project you're in and what's relevant to your question.

### When the session ends (Stop hook)

Any changes to your cortex (new learnings, backlog updates) are automatically committed and pushed. Nothing gets lost even if you forget to save.

### After context compaction

When Claude's context window fills up and gets compacted, it loses previously injected context. The `hook-context` command re-injects your project summary, recent learnings, and active backlog so Claude stays oriented.

---

## The MCP server

The server indexes your cortex into a local SQLite FTS5 database. Ten tools available to Claude:

**Search and browse:**
- `search_cortex(query, type?, limit?)` with automatic synonym expansion
- `get_project_summary(name)` for a project's summary card and file list
- `list_projects()` for everything in your active profile

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

### Without the MCP server

Cortex still works through MEMORY.md and direct file reads. Claude reads `~/.cortex-context.md` at session start, and per-project MEMORY files point to the right cortex directories. MCP makes retrieval faster and more targeted, but it's not required.

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

`link.sh` applies the profile. Sparse-checkout keeps only the listed projects on disk. First run asks for a machine name and profile. After that, zero config.

---

## Works with Claude Code and GitHub Copilot

**Claude Code:** `npx @alaarab/cortex init` configures everything automatically. Manual setup:

```bash
claude mcp add cortex -- npx -y @alaarab/cortex ~/.cortex
```

**VS Code / GitHub Copilot:** Init detects VS Code and writes `mcp.json` automatically. Manual setup in `~/.config/Code/User/mcp.json`:

```json
{
  "servers": {
    "cortex": {
      "command": "npx",
      "args": ["-y", "@alaarab/cortex", "~/.cortex"]
    }
  }
}
```

---

## Skills

Five skills for the things that can't be automatic:

| Skill | What it does |
|-------|-------------|
| `/cortex-update` | Deep end-of-session reflection. The hooks handle auto-commit, but this is for when you want Claude to actively think about what it learned and write it down well. Optional now, but worth running after big sessions. |
| `/cortex-sync` | Pull latest from your cortex repo and re-link on this machine. The hooks can't replace this because multi-machine sync needs a manual trigger. |
| `/cortex-init` | Scaffold a new project. Creates summary.md, CLAUDE.md, backlog, adds to your profile. |
| `/cortex-discover` | Health audit. Missing files, stale content, stuck backlog items, skill gaps. |
| `/cortex-consolidate` | Read learnings across all projects and surface patterns that repeat. Needs human judgment about which patterns matter. |

Put personal workflow skills in `~/.cortex/global/skills/`. The `link.sh` script symlinks them to `~/.claude/skills/` so they're available everywhere.

---

## Building your own

Fork this repo. The split is clean: framework (`link.sh`, `mcp/`, `global/skills/`) on one side, your data (project directories, `machines.yaml`, `profiles/`) on the other.

```bash
git clone git@github.com:YOU/cortex.git ~/cortex
cd ~/cortex && ./link.sh
```

Or let Claude scaffold a project: `/cortex-init my-project` creates the files, asks which profile to add it to, and commits.

---

MIT License. Created by [Ala Arab](https://github.com/alaarab).
