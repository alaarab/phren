<div align="center">
<br>

<img src="icon.svg" width="120" alt="cortex" />

<br>

# cortex

**Your agents keep forgetting. They don't have to.**

[![npm](https://img.shields.io/npm/v/@alaarab/cortex?style=flat&labelColor=0D0D0D&color=7C3AED)](https://www.npmjs.com/package/@alaarab/cortex)
[![Docs](https://img.shields.io/badge/docs-alaarab.github.io%2Fcortex-A78BFA?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/)
[![Whitepaper PDF](https://img.shields.io/badge/whitepaper-PDF-2563EB?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/whitepaper.pdf)

<br>

You're running Claude Code, Codex, Cursor, maybe on a few machines at the same time. Every session starts over. Everything your agents figure out disappears when the context clears.

Cortex stores it. A private git repo you own, shared across all your tools and machines. Work projects stay on your work machine. Personal projects stay personal. Every agent reads from the same knowledge base, and every session builds on the last.

You stop re-explaining things. Your agents stop rediscovering things. The work you've already done starts working for you.

> `npx @alaarab/cortex init` — one command, 30 seconds, no account needed.

<br>
</div>

---

## Getting started

```bash
npx @alaarab/cortex init
# Preview changes without writing files
npx @alaarab/cortex init --dry-run
```

That's it. This:
- Creates `~/.cortex` with starter templates
- Registers MCP for detected tools (Claude Code, VS Code, Copilot CLI, Cursor, Codex)
- Sets up hooks for automatic context injection and auto-save
- Registers your machine

After init, you'll see something like:

```
  cortex initialized
  Path:    ~/.cortex
  Machine: work-laptop
  Profile: personal (6 projects)
  MCP:     registered for Claude Code
  Hooks:   prompt injection, auto-save, session lifecycle

  Restart your agent. Your next prompt will already have context.
```

If you want hooks-only mode (no MCP tools), install with:

```bash
npx @alaarab/cortex init --mcp off
```

Toggle anytime:

```bash
cortex mcp-mode on       # recommended: MCP + hooks
cortex mcp-mode off      # hooks-only fallback
cortex hooks-mode off    # disable hook execution temporarily
cortex hooks-mode on     # re-enable hooks
```

### Templates

`cortex init --template <name>` scaffolds with a project-specific starter:

| Template | Best for |
|----------|----------|
| `python-project` | Python packages and scripts |
| `monorepo` | Multi-package repos |
| `library` | Reusable libraries |
| `frontend` | React/Vue/web apps |

Use `--from-existing <path>` to import an existing project structure.

### Sync across machines

```bash
cd ~/.cortex
git init && git add . && git commit -m "Initial cortex"
git remote add origin git@github.com:YOU/my-cortex.git
git push -u origin main
```

On a new machine: clone, run init, done.

---

## What makes this different

**You stop figuring out the same things twice.** Every bug you traced, every workaround you found, every decision you made — it gets saved. Next session your agent already knows it. You draw from your knowledge instead of rebuilding it.

**All your agents share one brain.** Running Claude Code and Codex at the same time, on different machines. They all read from the same store. What one figures out, the others get. No coordination needed, it just flows through git.

**Work and personal stay separate.** Your work machine sees work projects. Your home machine sees personal ones. Same system, same commands, different profiles. Nothing bleeds across.

**It doesn't clog your context.** Loading your whole `CLAUDE.md` into every session is slow and expensive. Cortex pulls in only what's relevant to what you're working on right now. Less token spend per run means you can run more agents at the same time.

**Your data lives in your own GitHub.** No account, no vendor, no cloud service. Markdown in a private repo you control. You can read it, edit it, grep it, delete it. Nothing leaves unless you push it.

**It runs on its own.** Before each prompt, relevant context gets injected. After each response, changes save and push. You don't think about it.

**You can see what your agents know.** Everything is in git. `git log` shows what your agents learned and when. `git diff` shows what changed. No dashboards, just files.

---

## What lives in your cortex

`cortex init` creates your project store with starter templates. Each project gets its own directory. Add files as the project grows.

| File | What it's for |
|------|--------------|
| `summary.md` | Five-line card: what, stack, status, how to run, key insight |
| `CLAUDE.md` | Full context: architecture, commands, conventions |
| `REFERENCE.md` | Deep reference: API details, data models, things too long for CLAUDE.md |
| `FINDINGS.md` | Bugs hit, patterns discovered, things to avoid next time |
| `CANONICAL_MEMORIES.md` | Pinned memories that never expire and always inject |
| `backlog.md` | Task queue that persists across sessions |
| `MEMORY_QUEUE.md` | Items waiting for your review (see [Review queue](#review-queue) below) |
| `.claude/skills/` | Project-specific slash commands |

---

## How it runs itself

Three things happen every session without you doing anything:

**Before each prompt** — a hook pulls keywords from your message, searches the index, and injects the best matches. Trust filtering drops low-confidence or outdated entries.

**After each response** — changes get committed and pushed. Findings, backlog updates, session state. If nothing changed, the hook skips.

**When context resets** — a hook re-injects your project summary, recent findings, and active backlog so the agent picks up where it left off.

Two more things run in the background:

**Consolidation.** When findings pile up past the threshold, cortex flags it once per session. `/cortex-consolidate` archives old entries and promotes patterns that show up in three or more projects.

**Review queue.** Findings that fail trust filtering land in `MEMORY_QUEUE.md` for review. Triage from the shell (press `m`) or with `:mq approve`, `:mq reject`, `:mq edit`.

---

## The MCP server

The MCP server indexes your project store into a local SQLite FTS5 database and exposes 47 tools:

### Search and browse

| Tool | What it does |
|------|-------------|
| `search_knowledge` | Hybrid search (FTS5 + token-overlap + vector) with synonym expansion and recency boost. |
| `get_memory_detail` | Fetch full content of a memory by id (e.g. `mem:project/filename`). |
| `get_project_summary` | Summary card and file list for a project. |
| `list_projects` | Everything in your active profile. |
| `get_findings` | Read recent findings for a project without a search query. |
| `get_consolidation_status` | Check if findings need consolidation. |
| `health_check` | Run doctor checks and return results. |

### Backlog management

| Tool | What it does |
|------|-------------|
| `get_backlog` | Read tasks for one or all projects, or fetch a single item by ID or text. |
| `add_backlog_item` | Add a task to the Queue section. |
| `add_backlog_items` | Bulk add multiple tasks in one call. |
| `complete_backlog_item` | Match by text, move to Done. |
| `complete_backlog_items` | Bulk complete multiple items in one call. |
| `update_backlog_item` | Change priority, context, or section. |

### Finding capture

| Tool | What it does |
|------|-------------|
| `add_finding` | Save a finding with optional citation and type (`decision`, `pitfall`, `pattern`). |
| `add_findings` | Bulk add multiple findings in one call. |
| `remove_finding` | Remove by matching text. |
| `remove_findings` | Bulk remove multiple findings in one call. |
| `push_changes` | Commit and push all changes. |

### Memory quality

| Tool | What it does |
|------|-------------|
| `pin_memory` | Pin a memory so it never decays. |
| `memory_feedback` | Record helpful / reprompt / regression outcomes. |

### Data management

| Tool | What it does |
|------|-------------|
| `export_project` | Export project data as portable JSON. |
| `import_project` | Import project from exported JSON. |
| `manage_project` | Archive or unarchive a project. |

### Entity graph

| Tool | What it does |
|------|-------------|
| `search_entities` | Find entities and related docs by name. |
| `get_related_docs` | Get docs linked to a named entity. |
| `read_graph` | Read the entity graph for a project or all projects. |
| `link_findings` | Link a finding to an entity. Persists across rebuilds. |
| `cross_project_entities` | Find entities shared across multiple projects. |

### Session management

| Tool | What it does |
|------|-------------|
| `session_start` | Start a session. Returns prior summary, recent findings, active backlog. |
| `session_end` | End session and save summary for next time. |
| `session_context` | Current session state: project, duration, findings added. |

Governance, policy, and maintenance tools are CLI-only (see `cortex config` and `cortex maintain`).

---

## Interactive shell

`cortex` in a terminal opens the shell. Seven views, single-key navigation:

| Key | View |
|-----|------|
| `p` | Projects |
| `b` | Backlog |
| `l` | Findings |
| `m` | Review Queue |
| `s` | Skills |
| `k` | Hooks |
| `h` | Health |
| `/` | Filter current view |
| `:` | Command palette |
| `q` | Quit |

### Palette commands

**Backlog:** `:add`, `:complete`, `:move`, `:reprioritize`, `:context`, `:work next`, `:tidy`

**Findings:** `:find add`, `:find remove`

**Review queue:** `:mq approve`, `:mq reject`, `:mq edit`

**Memory quality:** `:govern`, `:consolidate`

**Git:** `:undo`, `:diff`, `:conflicts`

**Infrastructure:** `:run fix`, `:relink`, `:rerun hooks`, `:update`

**Navigation:** `:open <project>`, `:search <query>`, `:reset`

The shell works the same on every machine, for every agent.

---

## CLI

For scripting, hooks, and quick lookups from the terminal:

```bash
cortex                                   # interactive shell (TTY default)
cortex search "rate limiting"            # FTS5 search with synonym expansion
cortex add-finding <project> "..."       # append a finding from the terminal
cortex pin <project> "..."               # promote canonical memory
cortex backlog [project]                 # cross-project backlog view
cortex status                            # health, active project, stats
cortex doctor [--fix]                    # health checks + optional self-heal
cortex verify                            # check init completed correctly
cortex review-ui [--port=3499]           # lightweight review UI in the browser
cortex update                            # update to latest version
cortex uninstall                         # remove cortex config and hooks

cortex projects list                        # list all projects
cortex projects add <name>                  # create a new project
cortex projects remove <name>               # remove a project (confirmation required)

cortex link [--machine <n>] [--profile <n>]  # sync profile, symlinks, hooks
cortex mcp-mode [on|off|status]          # toggle MCP integration
cortex hooks-mode [on|off|status]        # toggle hook execution

cortex skills list                       # list all installed skills
cortex skills add <project> <path>       # add a skill to a project
cortex skills remove <project> <name>    # remove a skill from a project
cortex skill-list                        # alias for skills list

cortex hooks list                        # show hook status per tool
cortex hooks enable <tool>              # enable hooks for tool (claude/copilot/cursor/codex)
cortex hooks disable <tool>             # disable hooks for tool
```

Use `cortex config` for policy tuning and `cortex maintain` for governance operations. Run `--dry-run` before destructive maintenance commands.

### cortex doctor

`cortex doctor` checks your setup. `--fix` repairs what it can. `--check-data` also validates config files.

| Check | What it verifies | What FAIL means |
|-------|-----------------|-----------------|
| `machine-registered` | Your hostname is in machines.yaml | Run `cortex init` or add your machine manually |
| `profile-exists` | The profile YAML file exists in profiles/ | Create the profile file or fix the mapping in machines.yaml |
| `profile-projects` | At least one project is listed in the profile | Add projects to your profile YAML |
| `context-file` | ~/.cortex-context.md exists | Run `cortex link` or `cortex doctor --fix` to regenerate |
| `root-memory` | The generated MEMORY.md exists | Run `cortex link` or `cortex doctor --fix` |
| `global-link` | ~/.claude/CLAUDE.md symlinks to your cortex global | Run `cortex link` to re-create the symlink |
| `symlink:<project>/<file>` | Per-project file symlinks are correct | Run `cortex link` to re-create symlinks |
| `claude-hooks` | Prompt hook is configured in settings.json | Run `cortex init` to reconfigure hooks |
| `lifecycle-hooks` | Session-start and stop hooks are configured | Run `cortex init` to reconfigure hooks |
| `runtime-health-file` | The runtime health tracker file exists | Will be created on next hook run |
| `runtime-auto-save` | Last auto-save completed successfully | Check ~/.cortex/.audit-log for details |
| `runtime-prompt` | Prompt hook has run at least once | Start a new agent session to trigger it |
| `fts-index` | SQLite FTS5 index builds and queries correctly | Check for corrupt data files, run `cortex doctor --fix` |
| `copilot-hooks` | Copilot CLI hook config exists (if Copilot detected) | Run `cortex init` to configure |
| `cursor-hooks` | Cursor hook config exists (if Cursor detected) | Run `cortex init` to configure |
| `codex-hooks` | Codex hook config exists (if Codex detected) | Run `cortex init` to configure |
| `config` | .governance/ config directory exists | Run `cortex init` to create config files |

### Access control (RBAC)

Four roles: `admin`, `maintainer`, `contributor`, `viewer`. Set in `.governance/access-control.json`. Identity comes from `CORTEX_ACTOR`, then `USER`/`USERNAME`, then your OS username. Unknown actors default to `viewer`.

See [docs/environment.md](docs/environment.md) for all feature flags and env vars.

---

## Works with every major agent

Init detects your tools and registers them. A finding saved by Claude Code shows up in Codex next session, and the other way around.

| Agent | Context injection | Auto-save | MCP tools | Instruction files |
|-------|:-----------------:|:---------:|:---------:|:-----------------:|
| Claude Code | yes | yes | yes | `CLAUDE.md` |
| GitHub Copilot CLI | yes | yes | yes | `copilot-instructions.md` |
| Cursor | yes | yes | yes | via hooks |
| OpenAI Codex | yes | yes | yes | `AGENTS.md` |

MCP or hooks-only, either works. Same knowledge base either way.

---

## Multiple machines, one repo

Your cortex is a git repo. Push it to a private remote, clone it anywhere.

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

`cortex link` applies the profile and keeps only the listed projects on disk. First run asks for a machine name and profile. After that, nothing to configure.

For CI or unattended setup:

```bash
npx @alaarab/cortex init --machine ci-runner --profile work
```

---

## Multiple agents, shared knowledge

When you run multiple agents, they all read and write the same project store. An agent on Codex hits a pitfall and saves a finding. Ten minutes later, a Claude Code session on a different machine gets that finding in its context. No coordination code. No message passing. Just a shared git repo.

- **Parallel agents** share findings on push/pull cycles
- **Sequential sessions** build on each other. Session 47 knows everything sessions 1 through 46 learned.
- **Cross-project patterns** surface when the same insight shows up in three or more projects
- **Backlog items** persist across agents and sessions. One agent adds a task, another finishes it.

Because it's all markdown in git, you have a full record of what your agents learned, when, and which session produced each insight.

---

## Skills

Four skills for the things that can't be automatic:

| Skill | What it does |
|-------|-------------|
| `/cortex-sync` | Pull latest from your cortex repo and re-link on this machine. |
| `/cortex-init` | Scaffold a new project. Creates summary.md, CLAUDE.md, backlog, adds to your profile. |
| `/cortex-discover` | Health audit. Missing files, stale content, stuck backlog items. |
| `/cortex-consolidate` | Read findings across all projects and surface patterns that repeat. |

Put personal workflow skills in `~/.cortex/global/skills/`. `cortex link` symlinks them to `~/.claude/skills/` so they're available everywhere.

### Per-project agent config

Drop a `cortex.project.yaml` in `~/.cortex/<project>/` to control what gets injected for that project:

```yaml
# Opt out of global skill injection for this project
skills: false

# Register extra MCP servers when this project is linked
mcpServers:
  my-tool:
    command: node
    args: [/path/to/server.js]
  my-api:
    command: /usr/local/bin/api-server
    env:
      API_KEY: "from-your-env"
```

`cortex link` merges project MCP servers into your agent config under namespaced keys (`cortex__<project>__<name>`) and cleans them up when the config changes.

---

## Adding projects

```bash
/cortex-init my-project              # let Claude scaffold it
# or manually:
mkdir ~/.cortex/my-project && echo "# my-project" > ~/.cortex/my-project/CLAUDE.md
```

---

## Troubleshooting

**Cortex not injecting context into prompts**

Run `cortex status` and check the Hooks line. If it says "off", run `cortex hooks-mode on`. If hooks are on but nothing's appearing, run `cortex doctor` to check the prompt hook config.

**MCP tools not connecting**

Run `cortex status` and check the MCP line. If it's off, run `cortex mcp-mode on`. If cfg shows "missing", run `cortex init`. For VS Code or Cursor, check that MCP config landed in the right settings file.

**"I saved a finding but can't find it"**

Findings are scoped to a project. Try `cortex search "your term" --project <name>`. If it was flagged by trust filtering, check the review queue: `cortex` then press `m`.

**Doctor says FAIL on symlinks**

Project directory probably moved or symlinks are stale. Run `cortex doctor --fix`.

**Merge conflicts after pulling on a new machine**

Run `cortex` and type `:conflicts`. Cortex auto-merges most cases (backlog items, findings). If a manual merge is needed, conflict markers show in the files.

---

## Dependency note

Cortex uses `sql.js-fts5` for local SQLite FTS5 in Node. Pinned and tested in CI. If you're in a high-security environment, review dependency updates on upgrade and keep lockfiles committed.

---

Found a security issue? See [SECURITY.md](SECURITY.md) for responsible disclosure.

MIT License. Made by [Ala Arab](https://github.com/alaarab). [Contributions welcome](CONTRIBUTING.md).
