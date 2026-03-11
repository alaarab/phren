# My Cortex

Your personal project store for [cortex](https://github.com/alaarab/cortex), which gives Claude Code persistent context across sessions and machines.

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
│   ├── FINDINGS.md  # findings accumulated over time
│   ├── tasks.md     # task queue that persists across sessions
│   └── .claude/
│       └── skills/  # project-specific skills
├── profiles/        # YAML files mapping project sets to machine roles
└── machines.yaml    # maps machine hostnames to profiles
```

## Guided tour

New to cortex? Here's what each file does and when it matters.

**summary.md** is the elevator pitch. Cortex shows this to Claude first so it knows what project it's working on. Keep it to 5 lines: what, stack, status, run command, biggest finding.

**CLAUDE.md** is the project bible. Commands, architecture, key patterns, things to never do. Claude reads this before making changes. The better this file is, the fewer mistakes Claude makes.

**FINDINGS.md** fills itself. As Claude discovers findings, patterns, and decisions during your sessions, it calls `add_finding()` and entries land here grouped by date. Old entries fade from retrieval over time. Wrong entries can be removed with `remove_finding()`.

**tasks.md** is your task board file. It keeps Active (working now), Queue (up next), and Done (finished) in one place so the work history stays with the project. You can also manage it from `npx cortex shell`.

**global/CLAUDE.md** applies everywhere. Your style preferences, tool choices, things Claude should always know regardless of which project you're in.

**profiles/** and **machines.yaml** handle multi-machine setups. Map hostnames to profiles, and profiles to project lists. Your work laptop sees work projects, your home machine sees personal ones.

## Getting started

If you got here via `npx cortex init`, you're already set up. Restart Claude Code and you're good.

If you cloned manually:

1. Add the MCP server: `claude mcp add cortex -- npx cortex ~/.cortex`
2. Install skills: `/plugin marketplace add alaarab/cortex` then `/plugin install cortex@cortex`
3. Restart Claude Code
4. Add a project: run `/cortex-init my-project` or scaffold one with a template such as `npx cortex init --template python-project`
5. Push to a private GitHub repo to sync across machines

## Day-to-day workflow

1. **Start a session**: cortex auto-pulls and injects relevant context
2. **Work normally**: Claude reads your project docs and uses past findings
3. **Findings accumulate**: insights get saved to FINDINGS.md automatically
4. **Session ends**: cortex auto-commits and pushes changes
5. **Review occasionally**: run `npx cortex shell` to triage queued memories, manage backlogs, and check health

## Syncing across machines

Edit `machines.yaml` to map each machine's hostname to a profile:

```yaml
work-desktop: work
home-laptop: personal
```

Each profile in `profiles/` lists which projects that machine should see. After cloning on a new machine, run `/cortex-sync` to pull everything in.

## Troubleshooting

Run `npx cortex doctor --fix` to check and repair your setup.
