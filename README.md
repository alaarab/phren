<div align="center">
<br>

<img src="icon.svg" width="120" alt="cortex" />

<br>

# cortex

**Long-term memory for Claude Code.**

[![MIT License](https://img.shields.io/badge/license-MIT-7C3AED?style=flat&labelColor=0D0D0D)](LICENSE)
[![Claude Code](https://img.shields.io/badge/built_for-Claude_Code-A78BFA?style=flat&labelColor=0D0D0D)](https://claude.ai)

<br>

A git repo that gives Claude persistent context across sessions and machines.<br>
Project knowledge, lessons learned, slash commands, task queues, all in markdown files you own.<br>
Fork it, clone it to `~/.cortex`, install the package. Claude knows your projects from session one.

<br>
</div>

---

## Why this is worth setting up

### Claude stops burning tokens on things it already knows

Without cortex, Claude reads your project files upfront. Every session. A complex project burns 3-4k tokens before you've typed a word.

With the MCP server, Claude starts lean. It searches your knowledge base when it needs something instead of loading everything upfront. Ask about the auth flow, it fetches just that section. Ask about deployment, it pulls the deployment notes. Same answers, fraction of the context cost.

### Each machine only sees what it needs to

Cortex uses git sparse-checkout under the hood. Each machine has a profile that lists which projects it should see — work machine gets work projects, everything else stays off disk. No leakage between environments.

### You stop losing what you learned

Claude figures out a tricky bug, discovers a non-obvious pattern in your codebase, then the session ends and that knowledge is gone. `/cortex-learn` captures it: a few bullet points, committed to your cortex repo, available in every future session on every machine. Over time your LEARNINGS.md files become a project history worth more than any ticket system.

### It's just files

Everything lives in markdown files in a git repo you own. `git log` shows how your project knowledge evolved. `git diff` shows what changed. If Claude's context is wrong, you open a file and fix it. No account required, nothing to break.

---

## How it works

Fork this repo and clone it to `~/cortex`. This is your knowledge base.

Run `link.sh`. It registers your machine, applies your profile, and symlinks everything into place. CLAUDE.md files land in your project directories, skills land in `~/.claude/skills/`. Claude picks them up next time it starts.

Push to GitHub to sync across machines. On a new machine, clone and run link.sh. It reads the profile for that machine and configures itself.

---

## Getting started

### Option A: npm (recommended)

```bash
# Add the MCP server
claude mcp add cortex -- npx @alaarab/cortex

# Add cortex as a plugin marketplace, then install skills
/plugin marketplace add alaarab/cortex
/plugin install cortex@cortex
```

### Option B: self-hosted (fork and own it)

```bash
# 1. Fork this repo on GitHub, then clone your fork
git clone git@github.com:YOUR_USERNAME/cortex.git ~/cortex
cd ~/cortex

# 2. Register this machine and activate your profile
./link.sh

# 3. Build the MCP server (optional but recommended)
cd mcp && npm install && npm run build && cd ..
./link.sh  # auto-configures MCP in your Claude settings
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

`summary.md` is the always-on card, five lines that keep Claude oriented. `CLAUDE.md` is loaded when you're actively working in that project. With the MCP server, everything else is retrieved on demand.

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

The server indexes every markdown file in your cortex into a local SQLite FTS database and exposes three tools to Claude:

- `search_cortex(query)` searches across all your project docs, learnings, backlogs, and skills
- `get_project_summary(name)` pulls up a specific project's summary card and file list
- `list_projects()` shows everything in your active profile with a one-line description of each

Instead of loading context upfront, Claude calls `search_cortex` when it needs to know something. A project with 3k tokens of architecture notes? Claude fetches the relevant 300 tokens for the current task instead of the whole file.

```bash
cd mcp
npm install
npm run build
```

Run `link.sh` after building and it patches your Claude settings automatically.

---

## Skills

These are the skills I use in my own workflow. They're included as a starting point, not a requirement. Replace them with your own, add project-specific ones, delete what you don't use. Skills are just markdown files in `~/.claude/skills/`.

### Cortex skills

| Skill | What it does |
|-------|-------------|
| `/cortex-sync` | Pull the latest from your cortex repo and re-link everything on this machine |
| `/cortex-learn` | At the end of a session, extract what was figured out and commit it to LEARNINGS.md |
| `/cortex-init` | Scaffold a new project: summary card, CLAUDE.md, backlog, skills directory |
| `/cortex-consolidate` | Read LEARNINGS.md files across all projects and surface patterns that repeat across codebases |
| `/cortex-discover` | Audit your cortex: missing files, stale content, skill gaps, stuck backlog items |

### Workflow skills

General-purpose skills that work with or without cortex. I include them because I reach for them constantly.

`/humanize` sweeps your code and prose for AI tells before you ship. If it sounds like a language model wrote it, this finds it.

`/creative` is a design pass. It looks at UI work and asks the questions a good designer would: is the spacing consistent, does the typography have a real hierarchy, does this look like something someone made or something someone filled in from a template.

`/swarm` spins up a team of Claude agents and splits work across them. Frontend, backend, tests in parallel. They coordinate through a shared task list and report back when done.

`/backlog` manages a persistent task queue in a `backlog.md` file. Tasks survive across sessions, can be prioritized, and can be handed off to a swarm.

`/pipeline` checks where you are in the dev workflow right now. Git status, recent commits, test results, open PRs. It gives you a "here's what state things are in and what the obvious next step is" summary.

`/release` handles shipping: version bump, changelog update, git tag, publish to npm or PyPI. Projects can override with their own `/publish` skill for custom release flows.

Every skill is a self-contained markdown file. You can copy one to `~/.claude/skills/` and use it without any of the rest of cortex.

```bash
# grab just the skill you want
curl -o ~/.claude/skills/humanize.md \
  https://raw.githubusercontent.com/YOUR_USERNAME/cortex/main/global/skills/humanize.md
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
