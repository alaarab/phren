# My Phren

Your personal project store for [phren](https://github.com/alaarab/phren). Phren is your project's memory keeper. He holds what your agents learn and surfaces it when it matters, across sessions and machines.

## Structure

Each subdirectory is a project. Add one for every codebase you work on.

```
~/.phren/
├── global/          # context that applies to every project
│   ├── CLAUDE.md
│   └── skills/      # personal workflow skills
├── my-project/
│   ├── CLAUDE.md    # architecture, commands, key patterns
│   ├── summary.md   # five-line project card
│   ├── FINDINGS.md  # fragments accumulated over time
│   ├── tasks.md     # task queue that persists across sessions
│   └── .claude/
│       └── skills/  # project-specific skills
├── profiles/        # YAML files mapping project sets to machine roles
└── machines.yaml    # maps machine hostnames to profiles
```

## Guided tour

New to phren? Here's what each file does and when it matters.

**summary.md** is the elevator pitch. Phren shows this to Claude first so it knows what project it's working on. Keep it to 5 lines: what, stack, status, run command, biggest insight.

**CLAUDE.md** is the project bible. Commands, architecture, key patterns, things to never do. Claude reads this before making changes. The better this file is, the fewer mistakes Claude makes.

**FINDINGS.md** fills itself. As Claude discovers insights, patterns, and decisions during your sessions, it tells phren and entries land here grouped by date. Old entries fade from retrieval over time. Wrong entries can be removed with `remove_finding()`.

**tasks.md** is your task board file. It keeps Active (working now), Queue (up next), and Done (finished) in one place so the work history stays with the project. You can also manage it from `npx phren shell`.

**global/CLAUDE.md** applies everywhere. Your style preferences, tool choices, things Claude should always know regardless of which project you're in.

**profiles/** and **machines.yaml** handle multi-machine setups. Map hostnames to profiles, and profiles to project lists. Your work laptop sees work projects, your home machine sees personal ones.

## Getting started

If you got here via `npx phren init`, you're already set up. Restart Claude Code and you're good.

If you cloned manually:

1. Add the MCP server: `claude mcp add phren -- npx phren ~/.phren`
2. Install skills: `/plugin marketplace add alaarab/phren` then `/plugin install phren@phren`
3. Restart Claude Code
4. Add a project: run `/phren-init my-project` or scaffold one with a template such as `npx phren init --template python-project`
5. Push to a private GitHub repo to sync across machines

## Day-to-day workflow

1. **Start a session**: phren pulls the latest and feeds relevant context to your agent
2. **Work normally**: Claude reads your project docs and builds on what phren remembers
3. **Fragments accumulate**: tell phren what you learned, or he picks up insights automatically
4. **Session ends**: phren commits and pushes what he collected
5. **Review occasionally**: run `npx phren shell` to triage what phren queued, manage tasks, and check health

## Syncing across machines

Edit `machines.yaml` to map each machine's hostname to a profile:

```yaml
work-desktop: work
home-laptop: personal
```

Each profile in `profiles/` lists which projects that machine should see. After cloning on a new machine, run `/phren-sync` to pull everything in.

## Troubleshooting

Run `npx phren doctor --fix` to check and repair your setup.
