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
[![Website](https://img.shields.io/badge/site-alaarab.github.io%2Fcortex-A78BFA?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/)

<br>

A git repo that gives Claude persistent context across sessions and machines. Project knowledge, lessons learned, slash commands, task queues: all in markdown files you own. Run `npx @alaarab/cortex init`, and Claude knows your projects from session one.

<br>
</div>

---

## Why this is worth setting up

### Claude stops burning tokens on things it already knows

Without cortex, Claude reads your project files upfront. Every session. A complex project burns 3-4k tokens before you've typed a word.

With the MCP server, Claude starts lean. It searches your knowledge base when it needs something instead of loading everything upfront. Ask about the auth flow, it fetches just that section. Ask about deployment, it pulls the deployment notes. Same answers, fraction of the context cost.

### Each machine only sees what it needs to

Cortex uses git sparse-checkout under the hood. Each machine has a profile that lists which projects it should see: the work machine gets work projects, everything else stays off disk. No leakage between environments.

### You stop losing what you learned

Claude figures out a tricky bug, discovers a non-obvious pattern in your codebase, then the session ends and that knowledge is gone. `/cortex-update` captures it: a few bullet points, committed to your cortex repo, available in every future session on every machine. Over time your LEARNINGS.md files become a project history worth more than any ticket system.

### It's just files

Everything lives in markdown files in a git repo you own. `git log` shows how your project knowledge evolved. `git diff` shows what changed. If Claude's context is wrong, you open a file and fix it. No account required, nothing to break.

---

## How it works

Run `npx @alaarab/cortex init`. This creates `~/.cortex` with starter templates, registers your machine, and configures the MCP server automatically.

Push `~/.cortex` to a private GitHub repo to sync across machines. On a new machine, clone it and run `npx @alaarab/cortex init` again. It reads the profile for that machine and configures itself.

---

## Getting started

### Option A: one command (recommended)

```bash
npx @alaarab/cortex init
```

This creates `~/.cortex` with starter templates, registers your machine, and configures the MCP server in Claude Code and VS Code automatically.

Then restart Claude Code and your context is live.

### Option B: manual

```bash
# 1. Create your cortex directory
npx @alaarab/cortex init

# 2. Push to a private repo for syncing across machines
cd ~/.cortex
git init
git add .
git commit -m "Initial cortex setup"
git remote add origin git@github.com:YOUR_USERNAME/cortex.git
git push -u origin main
```

### Option C: self-hosted (fork the whole framework)

```bash
# Fork this repo, clone it, then run link.sh
git clone git@github.com:YOUR_USERNAME/cortex.git ~/cortex
cd ~/cortex && ./link.sh
```

Open any project with Claude Code and your context is already there.

---

## What lives in your cortex

Each project gets its own directory. Start with `CLAUDE.md` and add the rest as the project grows.

| File | What it's for |
|------|--------------|
| `summary.md` | Five-line card: what the project is, the stack, current status, how to run it, the one thing that trips people up |
| `CLAUDE.md` | Full context: architecture, commands, conventions, gotchas. Claude reads this at the start of every session. |
| `KNOWLEDGE.md` | Deep reference: API details, data models, things too long for CLAUDE.md |
| `LEARNINGS.md` | Lessons accumulated over time: bugs hit, patterns discovered, things to avoid next time |
| `backlog.md` | Task queue that persists across sessions |
| `.claude/skills/` | Project-specific slash commands |

`summary.md` is always loaded, five lines that keep Claude oriented without cost. `CLAUDE.md` is loaded when you're actively working in that project. With the MCP server, everything else is retrieved on demand.

---

## Multiple machines, one repo

Every machine maps to a profile. `machines.yaml` in your cortex repo holds the mapping:

```yaml
work-desktop: work
home-laptop: personal
```

Each profile lists what that machine should know about:

```yaml
# profiles/work.yaml
name: work
projects:
  - global
  - my-api
  - my-frontend
```

```yaml
# profiles/personal.yaml
name: personal
projects:
  - global
  - my-api
  - my-frontend
  - side-project-1
  - side-project-2
```

When you run `link.sh` on your work machine, it applies the `work` profile. Sparse-checkout keeps only those project directories on disk (personal projects don't exist on the filesystem), and symlinks wire everything up. On your personal machine: same repo, different profile, full access.

First run on a new machine, link.sh asks for a machine name and profile. After that, zero config.

---

## The MCP server

The server indexes every markdown file in your cortex into a local SQLite FTS database and exposes these tools to Claude:

**Search and browse:**
- `search_cortex(query, type?, limit?)` searches across all your project docs, learnings, backlogs, and skills. The optional `type` filter narrows results to a specific document type: `claude`, `learnings`, `knowledge`, `summary`, `backlog`, or `skill`.
- `get_project_summary(name)` pulls up a specific project's summary card and file list
- `list_projects()` shows everything in your active profile with a one-line description of each

**Backlog management:**
- `get_backlog(project?)` reads the backlog for one project or all of them
- `add_backlog_item(project, item)` appends a task to the Queue section of a project's backlog.md
- `complete_backlog_item(project, item)` matches the item by text and moves it to Done
- `update_backlog_item(project, item, updates)` updates an item's priority, context, or moves it between sections

**Learning capture:**
- `add_learning(project, insight)` appends a bullet to a project's LEARNINGS.md under today's date. Claude calls this the moment it discovers something worth remembering, not at the end of the session.
- `remove_learning(project, text)` removes a learning that turned out to be wrong or outdated by matching text
- `save_learnings(message?)` commits and pushes all cortex changes. Call at end of session or after a burst of updates.

Instead of loading context upfront, Claude calls `search_cortex` when it needs to know something. A project with 3k tokens of architecture notes? Claude fetches the relevant 300 tokens for the current task instead of the whole file.

The MCP server is installed automatically when you run `npx @alaarab/cortex init`. No separate build step needed.

### Without the MCP server

Not everyone runs the MCP server. Some work in restricted environments, use web Claude, or haven't set it up yet. Cortex still works through MEMORY.md and explicit file reads:

- Claude reads `~/.cortex-context.md` at session start for machine context
- `MEMORY.md` in `~/.claude/projects/` has a pointer table with one line per project
- Per-project `MEMORY-{name}.md` files have the full summary and notes
- For any project detail, Claude reads the file directly from `~/.cortex/project-name/`

This gives roughly equivalent context. MCP just makes retrieval faster and more targeted. Instead of loading everything, Claude searches for what it needs.

---

## Works with Claude Code and GitHub Copilot

Cortex is MCP-native, so it works wherever MCP is supported.

**Claude Code:** `npx @alaarab/cortex init` writes the server config into `~/.claude/settings.json` automatically. You can also add it manually:

```bash
claude mcp add cortex -- npx -y @alaarab/cortex ~/.cortex
```

**VS Code / GitHub Copilot:** `npx @alaarab/cortex init` detects VS Code and writes `~/.config/Code/User/mcp.json` automatically. To set it up manually, add to `~/.config/Code/User/mcp.json` (Linux) or `~/Library/Application Support/Code/User/mcp.json` (macOS):

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

Cortex ships five skills for managing your knowledge base. They're the only ones included in this package. Add project-specific ones in `.claude/skills/` inside any project, or put global workflow skills in `~/.cortex/global/skills/` so they're available everywhere.

| Skill | What it does |
|-------|-------------|
| `/cortex-update` | End-of-session wrap: capture what you learned, commit to your knowledge base, push |
| `/cortex-sync` | Pull the latest from your cortex repo and re-link everything on this machine |
| `/cortex-init` | Scaffold a new project: summary card, CLAUDE.md, backlog, skills directory |
| `/cortex-discover` | Audit your cortex: missing files, stale content, skill gaps, stuck backlog items |
| `/cortex-consolidate` | Read LEARNINGS.md files across all projects and surface patterns that repeat across codebases |

### Your own workflow skills

Skills like `/humanize`, `/swarm`, `/pipeline`, `/release`, and `/creative` are personal. They're not part of the cortex package because everyone's workflow is different.

Put your own skills in `~/.cortex/global/skills/`. The `link.sh` script symlinks them to `~/.claude/skills/` so Claude picks them up in every session. The starter template (included in the package) has examples you can copy and adapt.

```bash
# add a skill to your cortex
cp my-skill.md ~/.cortex/global/skills/
cd ~/.cortex && ./link.sh
```

---

## Splitting large context files

If a CLAUDE.md grows past around 100 lines, Claude Code's `@file` import syntax lets you split it without losing anything:

```markdown
# CLAUDE.md

@CLAUDE-architecture.md
@CLAUDE-commands.md
@CLAUDE-conventions.md
```

Each section is a separate file. Claude loads them all at session start, but you can remove an import line to stop loading a section. Useful when you're doing focused work and don't need the full architecture notes loaded for a quick bug fix.

---

## Building your own

Fork this repo. The split is clean: framework on one side (`link.sh`, `mcp/`, `global/skills/`, `templates/`), your data on the other (project directories, `machines.yaml`, `profiles/`). The framework is the machinery you don't touch much. Your data is yours to edit freely and commit often.

Add a new project:

```bash
cp -r templates/project/ my-new-project/
# fill in my-new-project/CLAUDE.md and summary.md
# add "my-new-project" to your profile
./link.sh
```

Or let Claude do it: `/cortex-init my-new-project` scaffolds the files, asks which profile to add it to, and commits everything.

---

MIT License. Created by [Ala Arab](https://github.com/alaarab).
