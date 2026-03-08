<div align="center">
<br>

<img src="icon.svg" width="120" alt="cortex" />

<br>

# cortex

**Long-term memory for AI agents.**

[![npm](https://img.shields.io/npm/v/@alaarab/cortex?style=flat&labelColor=0D0D0D&color=7C3AED)](https://www.npmjs.com/package/@alaarab/cortex)
[![Docs](https://img.shields.io/badge/docs-alaarab.github.io%2Fcortex-A78BFA?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/)
[![Whitepaper PDF](https://img.shields.io/badge/whitepaper-PDF-2563EB?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/whitepaper.pdf)

<br>

Supports Claude Code, Copilot CLI, Cursor, and Codex.

<br>

Project knowledge, field findings, task queues. Stored as markdown in a git repo you own. No vendor lock-in, no cloud dependency. One command to set up. Zero commands to use after that.

> **Quick start:** `npx @alaarab/cortex init` takes 30 seconds, no account needed.

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

You can toggle later anytime:

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

## What's new

- **Terminal shell**: open `cortex` and get tabs for Backlog, Findings, Review Queue, Skills, Hooks, and Health. No agent needed
- **Synonym search**: type "throttling" and find "rate limit" and "429". You don't need to remember what you called it
- **Bulk operations**: `add_findings`, `add_backlog_items`, `complete_backlog_items`, `remove_findings` for batch work
- **Memory quality**: confidence scoring, age decay, and a feedback loop. Stale or low-signal entries stop appearing
- **Starter templates**: `cortex init --template python-project|monorepo|library|frontend`
- **Multi-agent access control**: four roles (admin, maintainer, contributor, viewer) for shared cortex repos
- **Deep reference**: `reference/` subdirectories indexed separately so API docs don't drown out your findings
- **Data portability**: export/import projects as JSON, archive/unarchive anytime

---

## What makes this different

**It runs itself.** Hooks inject context before every prompt and auto-save after every response. Trust filtering checks confidence, age decay, and citation validity before anything lands in your context.

**It's just files.** Markdown in a git repo you own. No database, no vector store, no account. `git log` shows how it grew.

**Search that works.** Type "throttling" and it finds "rate limit" and "429". You don't need to remember what you called it.

**Every machine, same brain.** Push to a private repo, clone on a new machine, run init. Profiles control which projects each machine sees.

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
| `MEMORY_QUEUE.md` | Items waiting for your review (see [Memory queue](#memory-queue) below) |
| `.claude/skills/` | Project-specific slash commands |

---

## How it runs itself

**Prompt injection.** A hook extracts keywords, searches your cortex, and injects matching context before the agent starts thinking. Trust filtering checks confidence scores, age decay, and citation validity before injection.

**Auto-save.** After each response, changes get committed and pushed automatically.

**Context recovery.** When the context window resets, a hook re-injects your project summary, recent findings, and active backlog.

**Consolidation.** When findings accumulate past the threshold, cortex flags it once per session. The `/cortex-consolidate` skill archives old entries and promotes cross-project patterns to global findings.

**Review queue.** Findings that fail trust filtering land in `MEMORY_QUEUE.md` for review. Triage from the shell (press `m`) or with `:mq approve`, `:mq reject`, `:mq edit`.

---

## The MCP server

The server indexes your cortex into a local SQLite FTS5 database. Tools are grouped by what they do:

### Search and browse

| Tool | What it does |
|------|-------------|
| `search_knowledge` | FTS5 search with synonym expansion. Filters by project, type, limit. |
| `get_memory_detail` | Fetch full content of a memory by id (e.g. `mem:project/filename`). |
| `get_project_summary` | Summary card and file list for a project. |
| `list_projects` | Everything in your active profile. |
| `get_findings` | Read recent findings for a project without a search query. |

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
| `add_finding` | Append under today's date with optional citation metadata. Accepts optional `findingType` (`decision`, `pitfall`, `pattern`) to prefix the finding inline. |
| `add_findings` | Bulk add multiple findings in one call. |
| `remove_finding` | Remove by matching text. |
| `remove_findings` | Bulk remove multiple findings in one call. |
| `push_changes` | Commit and push all changes. |

### Memory quality

| Tool | What it does |
|------|-------------|
| `pin_memory` | Write canonical/pinned memory that bypasses decay. |
| `memory_feedback` | Record helpful/reprompt/regression outcomes. |

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
| `link_findings` | Manually link a finding to an entity. Persists to manual-links.json and survives rebuilds. |
| `cross_project_entities` | Find entities shared across multiple projects. |

### Session management

| Tool | What it does |
|------|-------------|
| `session_start` | Mark session start. Returns prior session summary, recent findings, and active backlog. |
| `session_end` | Mark session end and save summary for next session. Reports duration and findings added. |
| `session_context` | Get current session state: project, duration, findings added so far. |

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

**Memory queue:** `:mq approve`, `:mq reject`, `:mq edit`

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

`cortex doctor` runs a health check across your entire setup. Add `--fix` to auto-repair what it can, or `--check-data` to also validate config files.

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

Four roles: `admin`, `maintainer`, `contributor`, `viewer`. Configured in `.governance/access-control.json`. Actor identity resolves from `CORTEX_ACTOR`, then `USER`/`USERNAME`, then OS username. Unknown actors are treated as `viewer`.

See [docs/environment.md](docs/environment.md) for feature flags and env var reference.

---

## Works with every major agent

Init auto-detects which tools you have and registers them all.

| Agent | Context injection | Auto-save | MCP tools | Instruction files |
|-------|:-----------------:|:---------:|:---------:|:-----------------:|
| Claude Code | yes | yes | yes | `CLAUDE.md` |
| GitHub Copilot CLI | yes | yes | yes | `copilot-instructions.md` |
| Cursor | yes | yes | yes | via hooks |
| OpenAI Codex | yes | yes | yes | `AGENTS.md` |

If your agent supports MCP, cortex uses it. If it only supports hooks, that works too.

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

`cortex link` merges project MCP servers into your agent config under namespaced keys (`cortex__<project>__<name>`) and cleans them up automatically when the config changes.

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

Check that hooks are enabled: run `cortex status` and look at the Hooks line. If it says "off", run `cortex hooks-mode on`. If hooks are on but context still isn't appearing, run `cortex doctor` to check that the prompt hook is configured in your agent's settings file.

**MCP tools not connecting**

Run `cortex status` and check the MCP and MCP cfg lines. If MCP is off, run `cortex mcp-mode on`. If MCP is on but cfg shows "missing", run `cortex init` to reconfigure. For VS Code or Cursor, check that the MCP config was written to the right settings file.

**"I saved a finding but can't find it"**

Findings are scoped to a project. Run `cortex search "your term" --project <name>` to search within a specific project. If the finding was flagged by trust filtering, check the memory queue: `cortex` then press `m`, or search without a project filter.

**Doctor says FAIL on symlinks**

This usually means the project directory moved or the symlinks are stale. Run `cortex doctor --fix` to re-create all symlinks and hooks.

**Merge conflicts after pulling on a new machine**

Run `cortex` and type `:conflicts` to see what conflicted. Cortex auto-merges most cases (backlog items, findings), but if a manual merge is needed the conflict markers will show in the affected files.

---

## Dependency note

Cortex uses `sql.js-fts5` for local SQLite FTS5 support in Node. This dependency is actively pinned and tested in CI. If you run in a high-security environment, review dependency updates during upgrades and keep lockfiles committed.

---

Found a security issue? See [SECURITY.md](SECURITY.md) for responsible disclosure.

MIT License. Made by [Ala Arab](https://github.com/alaarab). [Contributions welcome](CONTRIBUTING.md).
