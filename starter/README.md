# My Cortex

Your personal knowledge base for [cortex](https://github.com/alaarab/cortex) 1.10.1-rc.1, which gives Claude Code long-term memory across sessions and machines.

## Structure

Each subdirectory is a project. Add one for every codebase you work on.

```
~/.cortex/
├── global/          # context that applies to every project
│   ├── CLAUDE.md
│   └── skills/      # personal workflow skills
├── my-project/
│   ├── CLAUDE.md    # architecture, commands, key patterns
│   ├── summary.md   # five-line project card
│   ├── LEARNINGS.md # lessons accumulated over time
│   ├── backlog.md   # task queue that persists across sessions
│   └── .claude/
│       └── skills/  # project-specific skills
├── profiles/        # YAML files mapping project sets to machine roles
└── machines.yaml    # maps machine hostnames to profiles
```

## Getting started

If you got here via `npx @alaarab/cortex init`, you're already set up. Restart Claude Code and you're good.

If you cloned manually:

1. Add the MCP server: `claude mcp add cortex -- npx @alaarab/cortex ~/.cortex`
2. Install skills: `/plugin marketplace add alaarab/cortex` then `/plugin install cortex@cortex`
3. Restart Claude Code
4. Add a project: run `/cortex:init my-project` or copy `my-first-project/` as a starting point
5. Push to a private GitHub repo to sync across machines

## Syncing across machines

Edit `machines.yaml` to map each machine's hostname to a profile:

```yaml
work-desktop: work
home-laptop: personal
```

Each profile in `profiles/` lists which projects that machine should see. After cloning on a new machine, run `/cortex:sync` to pull everything in.
