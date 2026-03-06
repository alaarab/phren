<div align="center">
<br>

<img src="icon.svg" width="120" alt="cortex" />

<br>

# cortex

**Long-term memory for AI coding agents.**

[![npm](https://img.shields.io/npm/v/@alaarab/cortex?style=flat&labelColor=0D0D0D&color=7C3AED)](https://www.npmjs.com/package/@alaarab/cortex)
[![Docs](https://img.shields.io/badge/docs-alaarab.github.io%2Fcortex-A78BFA?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/)
[![Whitepaper PDF](https://img.shields.io/badge/whitepaper-PDF-2563EB?style=flat&labelColor=0D0D0D)](https://alaarab.github.io/cortex/whitepaper.pdf)

<br>

Supports Claude Code, Copilot CLI, Cursor, and Codex.

<br>

Project knowledge, lessons learned, task queues: all in markdown files you own. One command to set up. Zero commands to use after that. When your prompt mentions something cortex knows about, the context is there before the agent starts thinking.

> **Quick start:** `npx @alaarab/cortex init` -- takes 30 seconds, no account needed.

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

### Sync across machines

```bash
cd ~/.cortex
git init && git add . && git commit -m "Initial cortex"
git remote add origin git@github.com:YOU/my-cortex.git
git push -u origin main
```

On a new machine: clone, run init, done.

---

## What's new in v2

**Memory quality.** Learnings now have confidence scores that decay over time. Stale, conflicting, or low-value entries get flagged for review instead of silently polluting your context. You set the retention policy, the TTL, the decay curve. Cortex enforces it.

**Trust filtering.** Before any memory gets injected into a prompt, it passes through a trust gate. Entries below your confidence threshold are held back. Entries with broken citations are quarantined. The agent only sees what you've decided is reliable.

**Interactive shell.** `cortex` in a terminal opens a TUI with six views: Projects, Backlog, Learnings, Memory Queue, Machines, Health. Navigate with single keys, triage your memory queue, manage backlogs, run health checks. Works on every machine, no browser needed.

**Quality feedback loop.** When an injected memory helps, mark it helpful. When it causes a bad response, mark it as a regression. Those signals feed back into confidence scoring, so the system learns which memories actually matter.

---

## What makes this different

### It runs itself

Other memory tools need the agent to remember to call them. Cortex hooks into the agent's lifecycle directly. Every prompt you type, the hook searches your knowledge base and injects matching context before the agent starts thinking. When the session ends, anything written down gets committed and pushed. You never do either of those things manually.

Before injection, every learning passes through trust filtering: confidence scoring, citation validation, and staleness checks. Only entries above your threshold make it into the prompt. Stale or conflicting memories get routed to a review queue instead.

When learnings accumulate past the consolidation threshold (25 entries, or 60 days plus 10 entries), cortex flags it once per session and suggests consolidation. Old entries get archived, duplicates get merged, cross-project patterns get promoted to global knowledge.

### It's just files

No database service. No vector store. No account or API key. Your knowledge lives in markdown files in a git repo you own. `git log` shows how it grew. `git diff` shows what changed. Quality policies live in `.governance/` as JSON files you can edit by hand.

### Search that doesn't need exact words

Type "throttling" and it also finds "rate limit", "429", and "too many requests." Type "auth" and it finds "login" and "oauth". You don't need to remember the exact phrase you used six months ago.

### Every machine, same brain

Push your cortex to a private repo. Clone it on a new machine, run init, done. Profiles control which projects each machine sees. The work laptop gets work projects. Home gets everything.

### Builds over time

When the agent figures out a tricky pattern or hits a subtle bug, it writes that down. Next session, next week, next machine: that knowledge is there. Memories that prove useful gain confidence. Memories that cause problems lose it. The longer you use it, the sharper it gets.

---

## What lives in your cortex

Each project gets its own directory. Start with `CLAUDE.md` and add the rest as the project grows.

| File | What it's for |
|------|--------------|
| `summary.md` | Five-line card: what, stack, status, how to run, the gotcha |
| `CLAUDE.md` | Full context: architecture, commands, conventions |
| `KNOWLEDGE.md` | Deep reference: API details, data models, things too long for CLAUDE.md |
| `LEARNINGS.md` | Bugs hit, patterns discovered, things to avoid next time |
| `CANONICAL_MEMORIES.md` | Pinned high-signal memories that bypass decay |
| `backlog.md` | Task queue that persists across sessions |
| `MEMORY_QUEUE.md` | Items waiting for your review (see [Memory queue](#memory-queue) below) |
| `.claude/skills/` | Project-specific slash commands |

---

## How it runs itself

### Prompt injection

Before the agent sees your message, a hook extracts keywords, searches your cortex, and injects matching results as context. Generic replies, short acks, unrelated questions: nothing gets added. When something matches, it pulls up to 3 results, constrained by a token budget (default ~550 tokens).

Every injected learning passes through trust filtering first. The filter checks:
- **Confidence score** against your minimum threshold (default 0.6)
- **Age decay** on a configurable curve (30/60/90/120 day breakpoints)
- **Citation validity** for entries that reference specific files or commits

Entries that fail any check get routed to the memory queue for human review.

### Auto-save

After each response, a hook checks for cortex changes. Anything new (a learning, a backlog update) gets committed and pushed. You don't save manually.

### Context recovery

When the context window fills and resets, a hook re-injects your project summary, recent learnings, and active backlog so the agent doesn't lose the thread.

### Consolidation

When learnings accumulate past the threshold, cortex flags it once per session. The `/cortex-consolidate` skill archives old entries, merges duplicates, and promotes patterns that appear in 3+ projects to global knowledge.

### Memory queue

When a learning fails trust filtering (low confidence, broken citation, staleness), it lands in the project's `MEMORY_QUEUE.md` instead of being discarded. Items sit there until you review them.

You can triage the queue from the shell (press `m` to see it) or with palette commands:
- `:mq approve <id>` -- move the item into LEARNINGS.md
- `:mq reject <id>` -- discard it
- `:mq edit <id> <new text>` -- rewrite it, then approve

The queue is per-project. Items that need a maintainer role to approve (risky entries below the confidence threshold) are marked in the queue view.

---

## The MCP server

The server indexes your cortex into a local SQLite FTS5 database. Tools are grouped by what they do:

### Search and browse

| Tool | What it does |
|------|-------------|
| `search_cortex` | FTS5 search with synonym expansion. Filters by project, type, limit. |
| `get_project_summary` | Summary card and file list for a project. |
| `list_projects` | Everything in your active profile. |
| `list_machines` | Registered machines and their profiles. |
| `list_profiles` | All profiles and which projects each includes. |

### Backlog management

| Tool | What it does |
|------|-------------|
| `get_backlog` | Read tasks for one or all projects. |
| `add_backlog_item` | Add a task to the Queue section. |
| `complete_backlog_item` | Match by text, move to Done. |
| `update_backlog_item` | Change priority, context, or section. |

### Learning capture

| Tool | What it does |
|------|-------------|
| `add_learning` | Append under today's date with optional citation metadata. |
| `remove_learning` | Remove by matching text. |
| `save_learnings` | Commit and push all changes. |

### Memory management

| Tool | What it does |
|------|-------------|
| `pin_memory` | Write canonical/pinned memory that bypasses decay. |
| `govern_memories` | Queue stale/conflicting/low-value entries for review. |
| `prune_memories` | Delete expired entries by retention policy. |
| `consolidate_memories` | Deduplicate and rewrite LEARNINGS.md. |
| `memory_feedback` | Record helpful/reprompt/regression outcomes. |
| `migrate_legacy_findings` | Promote legacy findings docs into LEARNINGS/CANONICAL. |
| `memory_policy` | Get/set retention, TTL, decay, confidence thresholds. |
| `memory_workflow` | Get/set approval workflow settings. |
| `memory_access` | Get/set role-based permissions. |
| `index_policy` | Configure include/exclude globs and hidden-doc indexing. |

---

## Interactive shell

`cortex` in a terminal opens the shell. Six views, single-key navigation:

| Key | View |
|-----|------|
| `p` | Projects |
| `b` | Backlog |
| `l` | Learnings |
| `m` | Memory Queue |
| `h` | Health |
| `/` | Filter current view |
| `:` | Command palette |
| `q` | Quit |

### Palette commands

**Backlog:** `:add`, `:complete`, `:move`, `:reprioritize`, `:context`, `:work next`, `:tidy`

**Learnings:** `:learn add`, `:learn remove`

**Memory queue:** `:mq approve`, `:mq reject`, `:mq edit`

**Memory quality:** `:govern`, `:consolidate`

**Git:** `:undo`, `:diff`, `:conflicts`

**Infrastructure:** `:run fix`, `:relink`, `:rerun hooks`, `:update`

**Navigation:** `:open <project>`, `:search <query>`, `:page next`, `:page prev`, `:per-page <n>`, `:reset`

### Shell git commands

| Command | What it does |
|---------|-------------|
| `:undo` | Undo the last cortex action (reverts the most recent git commit in ~/.cortex). |
| `:diff` | Show the git diff for the current project, so you can see what changed since the last commit. |
| `:conflicts` | Show any git merge conflicts and the auto-merge log. Useful after pulling on a new machine. |

The shell is the universal interface. It works the same on every machine, for every agent. If you can open a terminal, you can manage your cortex.

---

## CLI

For scripting, hooks, and quick lookups from the terminal:

```bash
cortex                               # interactive shell (TTY default)
cortex search "rate limiting"        # FTS5 search with synonym expansion
cortex add-learning <project> "..."  # append a learning from the terminal
cortex pin-memory <project> "..."    # promote canonical memory
cortex doctor [--fix]                # health checks + optional self-heal
cortex memory-ui [--port=3499]       # lightweight review UI in the browser
cortex update                        # update to latest version
```

> **Note:** `cortex config` and `cortex maintain` are the canonical command groups. Top-level aliases (like `cortex memory-policy`) still work for backwards compatibility.

Memory quality commands:

```bash
cortex govern-memories [project]     # queue stale/conflicting memories
cortex prune-memories [project]      # delete expired entries
cortex consolidate-memories [project] # deduplicate LEARNINGS.md
cortex extract-memories [project]    # mine git + GitHub signals into candidates
cortex migrate-findings <project>    # promote legacy findings docs
```

Wave 1 migration and safety:

```bash
cortex maintain migrate governance --dry-run   # preview config schema upgrades
cortex maintain migrate governance             # apply config schema upgrades
cortex maintain migrate data <project> --dry-run
cortex maintain migrate all <project> --dry-run
```

For destructive maintenance (`maintain prune`, `maintain consolidate`, and non-dry-run migrations), run `--dry-run` first. Write paths that rewrite `LEARNINGS.md` create/update `LEARNINGS.md.bak` and report changed backup paths (for example, `Updated backups (1): <project>/LEARNINGS.md.bak`); `--dry-run` does not create backups.

Locking behavior: daily background maintenance uses `.quality-YYYY-MM-DD.lock` to prevent duplicate runs on the same day (stale locks are recovered automatically), and markdown mutations use per-file `.lock` files with timeout + stale-lock recovery.

Policy tuning:

```bash
cortex memory-policy get|set ...     # retention, decay, confidence
cortex memory-workflow get|set ...   # approval gates
cortex memory-access get|set ...     # role permissions
cortex index-policy get|set ...      # indexer include/exclude globs
cortex mcp-mode on|off|status       # toggle MCP integration
cortex hooks-mode on|off|status     # toggle hook execution
```

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

Cortex reads role assignments from `.governance/access-control.json` (the config directory) and enforces least privilege by default.

Roles:
- `admin`: full access (`read`, `write`, `queue`, `pin`, `delete`, `policy`)
- `maintainer`: everything except `policy` updates
- `contributor`: `read`, `write`, `queue`
- `viewer`: `read` only

Permission model:
- Policy changes (`memory-access set`, `memory-policy set`, `memory-workflow set`) require `admin`.
- Actor identity resolves from `CORTEX_ACTOR`, then `USER`/`USERNAME`, then OS username.
- Unknown actors are treated as `viewer`.
- Role resolution order is `admin` -> `maintainer` -> `contributor` -> `viewer` (if duplicated across lists).

Config expectations:
- File path: `.governance/access-control.json`
- Shape: JSON object with optional `schemaVersion` and role arrays: `admins`, `maintainers`, `contributors`, `viewers`
- Role array values should be non-empty actor IDs (for example usernames or service identities)
- Keep each actor in only one role list to avoid ambiguity

Example:

```json
{
  "schemaVersion": 1,
  "admins": ["alice"],
  "maintainers": ["team-leads"],
  "contributors": ["dev1", "dev2"],
  "viewers": ["ci-bot"]
}
```

### Feature flags

Optional env vars for staged rollout and large-repo safety:

```bash
CORTEX_FEATURE_AUTO_EXTRACT=0       # toggle git/GitHub mining in hook-prompt
CORTEX_FEATURE_DAILY_MAINTENANCE=0  # toggle detached daily quality maintenance
CORTEX_GH_TIMEOUT_MS=10000          # GitHub mining timeout
CORTEX_GH_RETRIES=2                 # GitHub mining retry count
CORTEX_GH_PR_LIMIT=40               # max PRs to scan
```

---

## Works with every major agent

Cortex hooks are plain shell commands. Init auto-detects which tools you have and registers them all. Use `cortex link --all-tools` to configure everything regardless of detection.

| Agent | Context injection | Auto-save | MCP tools | Instruction files |
|-------|:-----------------:|:---------:|:---------:|:-----------------:|
| Claude Code | yes | yes | yes | `CLAUDE.md` |
| GitHub Copilot CLI | yes | yes | yes | `copilot-instructions.md` |
| Cursor | yes | yes | yes | via hooks |
| OpenAI Codex | yes | yes | yes | `AGENTS.md` |
| Any agentskills tool | yes | yes | no | via `cortex.SKILL.md` |

**Claude Code** gets full hook support plus MCP. Init writes `~/.claude/settings.json`.

**GitHub Copilot CLI** gets hooks written to `~/.github/hooks/cortex.json`. Per-project `CLAUDE.md` is symlinked as `.github/copilot-instructions.md`.

**Cursor** gets hooks written to `~/.cursor/hooks.json`. No session-start hook available, but prompt injection and auto-save both work.

**OpenAI Codex** gets hooks written to `codex.json` in your cortex directory. Per-project `CLAUDE.md` is symlinked as `AGENTS.md`.

The shell works regardless of which agent you use. If your agent supports MCP, cortex uses it. If it only supports hooks, that works too. The memory layer is the same either way.

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
| `/cortex-consolidate` | Read learnings across all projects and surface patterns that repeat. |

Put personal workflow skills in `~/.cortex/global/skills/`. `cortex link` symlinks them to `~/.claude/skills/` so they're available everywhere.

---

## Building your own

Cortex is installed via npm. Your data lives in `~/.cortex`, separate from the package. The split is clean: framework (`cortex link`, `mcp/`, `global/skills/`) on one side, your data (project directories, `machines.yaml`, `profiles/`) on the other.

```bash
npx @alaarab/cortex init
```

That creates `~/.cortex` with starter templates. From there, add projects:

```bash
# Let Claude scaffold it
/cortex-init my-project

# Or create manually
mkdir ~/.cortex/my-project
echo "# my-project" > ~/.cortex/my-project/CLAUDE.md
```

To contribute to cortex itself:

```bash
git clone https://github.com/alaarab/cortex.git
cd cortex && npm install && npm run build && npm test
```

---

## Troubleshooting

**Cortex not injecting context into prompts**

Check that hooks are enabled: run `cortex status` and look at the Hooks line. If it says "off", run `cortex hooks-mode on`. If hooks are on but context still isn't appearing, run `cortex doctor` to check that the prompt hook is configured in your agent's settings file.

**MCP tools not connecting**

Run `cortex status` and check the MCP and MCP cfg lines. If MCP is off, run `cortex mcp-mode on`. If MCP is on but cfg shows "missing", run `cortex init` to reconfigure. For VS Code or Cursor, check that the MCP config was written to the right settings file.

**"I saved a learning but can't find it"**

Learnings are scoped to a project. Run `cortex search "your term" --project <name>` to search within a specific project. If the learning was flagged by trust filtering, check the memory queue: `cortex` then press `m`, or search without a project filter.

**Doctor says FAIL on symlinks**

This usually means the project directory moved or the symlinks are stale. Run `cortex doctor --fix` to re-create all symlinks and hooks.

**Merge conflicts after pulling on a new machine**

Run `cortex` and type `:conflicts` to see what conflicted. Cortex auto-merges most cases (backlog items, learnings), but if a manual merge is needed the conflict markers will show in the affected files.

---

## Dependency note

Cortex uses `sql.js-fts5` for local SQLite FTS5 support in Node. This dependency is actively pinned and tested in CI. If you run in a high-security environment, review dependency updates during upgrades and keep lockfiles committed.

---

MIT License. Made by [Ala Arab](https://github.com/alaarab). Contributions welcome.
