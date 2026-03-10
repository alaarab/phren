<div align="center">
<br>

<img src="icon.svg" width="120" alt="cortex" />

<br>

# cortex

**Long-term memory for your AI agents.**

[![npm](https://img.shields.io/npm/v/@alaarab/cortex?style=flat&labelColor=0D0D0D&color=7C3AED)](https://www.npmjs.com/package/@alaarab/cortex)
[![Docs](https://img.shields.io/badge/docs-alaarab.github.io%2Fcortex-A78BFA?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/)
[![Whitepaper PDF](https://img.shields.io/badge/whitepaper-PDF-2563EB?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/whitepaper.pdf)

<br>

Project memory should not disappear between sessions or get stranded on one machine. Cortex keeps that memory in a git-backed store you control, so useful context can accumulate across projects and machines without turning every prompt into a dump of old notes. Agents search it automatically, retrieve only what fits the budget, and keep building on the same project state as you work.

<br>
</div>

---

## Getting started

```bash
npx @alaarab/cortex init
# Preview changes without writing files
npx @alaarab/cortex init --dry-run
```

| Scenario | What to do |
|---|---|
| First time | `npx @alaarab/cortex init` |
| Add a project | Open a session there and let the agent ask, or run `cortex add` |
| New machine | `npx @alaarab/cortex init` and paste your cortex repo URL |

This one command bootstraps Cortex locally. It:
- Creates `~/.cortex` with starter templates
- Registers MCP for detected tools (Claude Code, VS Code, Copilot CLI, Cursor, Codex)
- Sets up hooks for automatic context injection and auto-save
- Registers your machine
- Auto-bootstraps the current repo when you run it inside a git project or a folder with `CLAUDE.md`

After init, you'll see something like:

```
  cortex initialized
  Path:    ~/.cortex
  Machine: work-laptop
  Profile: personal (6 projects)
  MCP:     registered for Claude Code
  Hooks:   prompt injection, auto-save, session lifecycle

  Open a prompt in your project directory. Your next prompt will already have context.
```

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

## Positioning

Cortex sits in the same broad agent-memory space as claude-mem, Supermemory, Mem0, GitHub Copilot Memory, and research systems such as MemoryBank and MemGPT. It does not claim to invent long-term memory, progressive disclosure, or hybrid retrieval as general ideas.

The distinction is architectural: Cortex applies those patterns to a repo-backed project memory system built from markdown + git, with explicit governance, review workflows, and shared use across agents, projects, and machines.

---

## Why cortex

**Compounding context, bounded retrieval.** Cortex lets project memory grow over time, but it does not inject the whole store. It searches what you actually wrote and keeps injection selective -- about 550 tokens by default -- so long-lived context does not turn into prompt bloat. Tune it with `CORTEX_CONTEXT_TOKEN_BUDGET`.

**Stale context fades, recurring context stays.** Findings decay over time. Patterns that keep coming up stay strong. Things that have not mattered in months fall back, so retrieval reflects what is still useful instead of everything ever recorded.

**Cross-machine continuity through git sync.** Claude Code, Codex, Cursor, all read from the same project memory. What one tool figures out becomes available on another machine through ordinary git sync cycles. Profiles keep work and personal separate.

**Your project memory stays in a repo you control.** No account, no vendor, no hosted service in the default path. Markdown in a repo you control. Read it, edit it, grep it, delete it.

---

## How it runs itself

Three things happen every session without you doing anything:

**Before each prompt** -- a hook pulls keywords from your message, searches the index, and injects the best matches. Trust filtering drops low-confidence or outdated entries.

**After each response** -- changes get committed locally. If a remote is configured, Cortex queues a background sync worker to push safely. If nothing changed, the hook skips.

**When context resets** -- a hook re-injects your project summary, recent findings, and active backlog so the agent picks up where it left off.

Two more things run in the background:

**Consolidation.** When findings pile up past the threshold, cortex flags it once per session. Background maintenance governs and prunes on its own schedule, and `/cortex-consolidate` remains the direct operator command for cleanup and pattern promotion.

**Review queue.** Findings that fail trust filtering land in `MEMORY_QUEUE.md` for review. Triage from the shell (press `m`) or with `:mq approve`, `:mq reject`, `:mq edit`.

---

## Reference

<details>
<summary><strong>What lives in your cortex</strong></summary>

`cortex init` creates your project store with starter templates. Each project gets its own directory. Add files as the project grows.

| File | What it's for |
|------|--------------|
| `summary.md` | Five-line card: what, stack, status, how to run, key insight |
| `CLAUDE.md` | Full context: architecture, commands, conventions |
| `REFERENCE.md` | Deep reference: API details, data models, things too long for CLAUDE.md |
| `FINDINGS.md` | Bugs hit, patterns discovered, things to avoid next time |
| `CANONICAL_MEMORIES.md` | Pinned memories that never expire and always inject |
| `backlog.md` | Task queue that persists across sessions |
| `MEMORY_QUEUE.md` | Items waiting for your review |
| `skills/` | Project-local Cortex skill source files; the resolved agent-facing mirror is generated into `.claude/skills/` as local state and should not be committed from app repos |

</details>

<details>
<summary><strong>Memory across your machines</strong></summary>

Your cortex repo carries your project memory. Push it to a private remote, clone it anywhere you work.

```bash
cd ~/.cortex
git init && git add . && git commit -m "Initial cortex"
git remote add origin git@github.com:YOU/my-cortex.git
git push -u origin main
```

On a new machine: run `npx @alaarab/cortex init` and paste your repo URL when the walkthrough asks if you have an existing cortex repo.

`SessionStart` pulls on open. The Stop hook commits locally after each response and queues a best-effort push when a remote exists. This is eventual consistency -- git gives you portability and auditability, not real-time sync.

Shared state lives in your cortex repo. Generated local state does not. The `.claude/` mirrors created inside app repos, tool-specific instruction files such as `.github/copilot-instructions.md`, and the local machine alias file (`~/.cortex/.machine-id`) are machine-local artifacts and should not be treated as canonical project memory.

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

Profiles decide which projects are active on each machine. `cortex init` is the normal refresh path: it registers the current machine/profile mapping, rewires supported agents, and bootstraps the current repo when needed.

If you want stable names across laptops, desktops, and CI, set the machine name explicitly at onboarding instead of relying on the raw OS hostname:

```bash
npx @alaarab/cortex init --machine work-laptop --profile work
```

For CI or unattended setup:

```bash
npx @alaarab/cortex init --machine ci-runner --profile work
```

</details>

<details>
<summary><strong>Shared project memory</strong></summary>

When more than one tool or session touches the same project, they all read and write the same store. A Codex session hits a pitfall and saves a finding. Ten minutes later, a Claude Code session on a different machine gets that finding in its context after the next successful sync cycle. No coordination service or custom broker layer, just a shared git repo.

- **Parallel agents** share findings on push/pull cycles
- **Sequential sessions** build on each other. Session 47 knows everything sessions 1 through 46 learned.
- **Cross-project patterns** surface when the same insight shows up in two or more projects
- **Backlog items** persist across agents and sessions. One agent adds a task, another finishes it.

Because it's all markdown in git, you have a full record of what your agents learned, when, and which session produced each insight.

</details>

<details>
<summary><strong>Retrieval modes</strong></summary>

**Core mode (default).** Markdown is the source of truth. Git handles sync and audit history. Retrieval runs through a local SQLite FTS5 index. This is the simplest and most portable setup: no required hosted service, predictable token budgets, and a repo you can inspect with normal tools.

**Optional semantic mode.** Cortex can also use Ollama or an embeddings API for gated semantic recovery when lexical retrieval is sparse or weak. After the relaxed lexical rescue pass, that vector stage often stays dormant on exact and near-lexical queries, so the steady-state path is still mostly local markdown + git + FTS5. Semantic mode exists for harder paraphrase recovery, not as a blanket speed claim.

</details>

<details>
<summary><strong>Init options and templates</strong></summary>

Hooks-only mode (no MCP tools):

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

To add an existing repo, run `cortex add` from that directory, or just open a session there and cortex will suggest it. Cortex auto-detects git repos and folders that already contain `CLAUDE.md`.

### Adding projects

From a project directory:

```bash
cd ~/code/my-project
cortex add
```

Or just open a session in the project directory. Cortex tells the agent to ask whether you want to add it, then the agent can call `add_project` or run `cortex add`.

For a brand-new scaffold inside Claude:

```bash
/cortex-init my-project
```

- `cortex add` is the supported path for existing repos.
- Platform support and release expectations are documented in [docs/platform-matrix.md](docs/platform-matrix.md).
- Best-effort vs fail-closed behavior is documented in [docs/error-reporting.md](docs/error-reporting.md).
- Package/update behavior is documented in [docs/versioning.md](docs/versioning.md).
- Backlog items stay local by default. GitHub issue linkage is optional, and promotion is one-way unless you explicitly act on the linked issue.

</details>

<details>
<summary><strong>Skills</strong></summary>

Four skills for the things that can't be automatic:

| Skill | What it does |
|-------|-------------|
| `/cortex-sync` | Pull latest from your cortex repo and re-link on this machine. |
| `/cortex-init` | Scaffold a brand-new project entry. Use this when the project does not exist yet; use `cortex add` for an existing repo. |
| `/cortex-discover` | Health audit. Missing files, stale content, stuck backlog items. |
| `/cortex-consolidate` | Read findings across all projects and surface patterns that repeat. |

**When to run these manually:**

- **`/cortex-discover`** -- Run after your first week on a new project, or when you feel like things are slipping through the cracks. It tells you what's missing, what's stale, and what's stuck.
- **`/cortex-consolidate`** -- Run after a burst of work across multiple projects, or monthly. It finds patterns that repeat across projects and promotes them to global knowledge so every agent benefits.
- **`cortex maintain govern`** -- Run when search results feel noisy or after a long break from a project. It queues low-value and stale entries for review.
- **`cortex maintain consolidate`** -- Run when findings in a single project feel repetitive. It deduplicates bullets in FINDINGS.md. Use `--dry-run` first to preview.

Put personal workflow skills in `~/.cortex/global/skills/`. `cortex init` and later refresh runs wire them into supported agents automatically.

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

`cortex init` applies project MCP servers into your agent config under namespaced keys (`cortex__<project>__<name>`) and cleans them up when the config changes.

</details>

<details>
<summary><strong>The MCP server (51 tools)</strong></summary>

The MCP server indexes your project store into a local SQLite FTS5 database and exposes 51 tools:

### Search and browse

| Tool | What it does |
|------|-------------|
| `search_knowledge` | Lexical-first retrieval: strict FTS5, relaxed lexical rescue, bounded local fallback scoring, and optional gated vector recovery with shared reranking/recency boosts. |
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
| `update_backlog_item` | Change priority, context, section, or linked GitHub issue. |
| `link_backlog_item_issue` | Link or unlink an existing GitHub issue on a backlog item. |
| `promote_backlog_item_to_issue` | Create a GitHub issue from a backlog item and write the link back. |

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
| `add_project` | Bootstrap a repo or working directory into cortex and add it to the active profile. |
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
| `session_start` | Start a session. Returns prior summary, recent findings, active backlog, and a `sessionId`. |
| `session_end` | End a session by `sessionId` or bound `connectionId`, and save summary for next time. |
| `session_context` | Read current session state by `sessionId` or bound `connectionId`. |

Governance, policy, and maintenance tools are CLI-only (see `cortex config` and `cortex maintain`).

</details>

<details>
<summary><strong>Interactive shell</strong></summary>

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

</details>

<details>
<summary><strong>CLI reference</strong></summary>

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
cortex update [--refresh-starter]        # update package; optionally refresh starter globals too
cortex uninstall                         # remove cortex config and hooks

cortex add [path]                           # add current directory (or path) as a project
cortex projects list                        # list all projects
cortex projects remove <name>               # remove a project (confirmation required)

cortex mcp-mode [on|off|status]          # toggle MCP integration
cortex hooks-mode [on|off|status]        # toggle hook execution

cortex skills list                       # list all installed skills
cortex skills add <project> <path>       # add a skill to a project
cortex skills enable <project|global> <name>   # enable a disabled skill without rewriting it
cortex skills disable <project|global> <name>  # disable a skill without deleting it
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
| `context-file` | ~/.cortex-context.md exists | Run `cortex doctor --fix` or rerun `cortex init` to regenerate |
| `root-memory` | The generated MEMORY.md exists | Run `cortex doctor --fix` or rerun `cortex init` |
| `global-link` | ~/.claude/CLAUDE.md symlinks to your cortex global | Run `cortex doctor --fix` or rerun `cortex init` |
| `symlink:<project>/<file>` | Per-project file symlinks are correct | Run `cortex doctor --fix` or rerun `cortex init` |
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

</details>

<details>
<summary><strong>Repository structure</strong></summary>

This repo has two roles: it's the source code for the `@alaarab/cortex` npm package, and it ships the starter files that `cortex init` copies to `~/.cortex`. The top-level directories break down like this:

| Directory | What it is | When you'd touch it |
|-----------|-----------|---------------------|
| `mcp/` | MCP server and CLI source code (TypeScript). The core of cortex. | Adding tools, fixing bugs, changing CLI behavior. |
| `global/` | Default user-level config shipped with the package. Contains the template `CLAUDE.md`, shared context files, and built-in skill definitions. Copied to `~/.cortex/global/` on init. | Editing the default instructions or adding built-in skills that ship with every install. |
| `hooks/` | Shell scripts that plug into agent lifecycle events (Stop, SessionStart, UserPromptSubmit). Registered by init into agent settings. | Adding or modifying agent hooks. |
| `skills/` | Cortex slash commands (`/cortex-init`, `/cortex-sync`, etc.). Each subdirectory has a `SKILL.md` with the full prompt. | Writing or editing built-in cortex skills. |
| `starter/` | Complete `~/.cortex` skeleton copied on first init: example projects, profiles, machines.yaml, and typed project templates. | Changing what new users get out of the box. |
| `templates/` | Default project scaffolding used by the `/cortex-init` skill (no `--template` flag). Contains the bare project skeleton and example summary files. | Editing the default project scaffold or adding example files. |
| `profiles/` | Example profile YAML files (personal, work) showing how to map project sets to machines. Copied to `~/.cortex/profiles/` on init. | Adding new example profiles that ship with the package. |
| `scripts/` | Dev scripts for maintainers: doc validation, retrieval evaluation. Not shipped to users. | Running CI checks or contributing to the test suite. |
| `docs/` | Documentation site, whitepaper, architecture docs, and internal design specs. Served via GitHub Pages. | Reading or updating docs. |

**starter/ vs templates/**: `starter/` is the full `~/.cortex` directory tree (projects, profiles, machines.yaml). `templates/` holds the bare project skeleton used by the `/cortex-init` skill. `starter/templates/` holds typed project templates (frontend, library, etc.) used by `cortex init --template`. Three layers: starter seeds the whole store, templates seeds the default project, starter/templates seeds typed projects.

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

**Cortex not injecting context into prompts**

Run `cortex status` and check the Hooks line. If it says "off", run `cortex hooks-mode on`. If hooks are on but nothing's appearing, run `cortex doctor` to check the prompt hook config.

**MCP tools not connecting**

Run `cortex status` and check the MCP line. If it's off, run `cortex mcp-mode on`. If cfg shows "missing", run `cortex init`. For VS Code or Cursor, check that MCP config landed in the right settings file.

**"I saved a finding but can't find it"**

Findings are scoped to a project. Try `cortex search "your term" --project <name>`. If it was flagged by trust filtering, check the review queue: `cortex` then press `m`.

**Doctor says FAIL on symlinks**

Project directory probably moved or symlinks are stale. Run `cortex doctor --fix`.

**Push failed or sync looks stuck**

Run `cortex status` first. If the store says `saved-local`, your data is committed locally and waiting on sync. The shell health view and review UI also show the last push error and unsynced commit count. Fix the remote or network issue, then let the background worker retry or run a normal git push yourself.

**Hooks disabled or stale**

Run `cortex hooks list`. If the target tool is off or misconfigured, enable it again with `cortex hooks enable <tool>` or rerun `cortex init`.

**Review queue keeps growing**

Your trust policy is probably pushing too much low-confidence content into review. Triage with `cortex` then `m`, or tune policy with `cortex config`.

**Governance writes are denied**

Check `.governance/access-control.json` and your `CORTEX_ACTOR` identity. Cortex will reject the write rather than silently dropping it.

**Merge conflicts after pulling on a new machine**

Run `cortex` and type `:conflicts`. Cortex auto-merges most cases (backlog items, findings). If a manual merge is needed, conflict markers show in the files.

</details>

---

Found a security issue? See [SECURITY.md](SECURITY.md) for responsible disclosure.

Cortex uses `sql.js-fts5` for local SQLite FTS5 in Node. Pinned and tested in CI.

MIT License. Made by [Ala Arab](https://github.com/alaarab). [Contributions welcome](CONTRIBUTING.md).
