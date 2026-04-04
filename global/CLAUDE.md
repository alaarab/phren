# User-level instructions

<!-- Copy this file to your personal phren instance's global/CLAUDE.md and fill in your own preferences. -->
<!-- This becomes ~/.claude/CLAUDE.md after syncing. Claude reads it at the start of every session. -->

## Memory

**Use Phren for all knowledge persistence, not Claude Code's built-in auto memory.** Do not write to `~/.claude/projects/.../memory/` files. Instead:

- Save knowledge → `add_finding(project, finding)`
- Recall knowledge → `search_knowledge(query)`
- Track tasks → `add_task()` / `complete_task()` / `get_tasks()`
- Track sessions → `session_start()` / `session_end()`

## How I Work

<!-- Your non-negotiable rules. Examples: -->
<!-- "Write human from the start. No em dashes. No double hyphens. No AI buzzwords." -->
<!-- "Think visually. If it looks like a template, it's not done." -->
<!-- "Finish the job. Changelog, README, tests. Don't wait to be asked." -->

## Skills

These skills are available as a full set via phren, or individually from the Claude skills marketplace. You don't need the full phren setup to use skills marked with (standalone).

### Phren skills (manage your project store)

| Skill | What it does |
|-------|-------------|
| `/phren-sync` | Pull phren to a new machine or push config changes back to the repo |
| `/phren-init` | Scaffold a new project with summary, CLAUDE.md, task |
| `/phren-discover` | Research what's missing in a project and surface gaps and opportunities |
| `/phren-consolidate` | Find patterns across all project FINDINGS.md files |
| `/phren-profiles` | Manage machine-to-profile mappings (multi-machine only) |

### Your own skills

Put personal workflow skills in `~/.phren/global/skills/` and list them here. See [phren](https://github.com/alaarab/phren) for examples.

<!-- Example:
| `/humanize` | Strip AI language from writing and code |
| `/release`  | Version bump, changelog, tag, publish |
-->

## Agent coordination

<!-- If you use team agents, document your coordination pattern here. Example: -->
<!-- "Never use fire-and-forget background agents. Always use TeamCreate/TaskCreate/SendMessage." -->

- Team agents follow the same phren rules as the primary agent.
- Before handing work back or stopping, record non-obvious bugs, patterns, tradeoffs, or decisions with `add_finding(...)`.
- Do not wait for the user to explicitly say "save this as a finding" if the insight will matter next session.

### Spawned agents and subagents

When spawning an Agent() or using team agents, phren context is auto-injected via the UserPromptSubmit hook. Agents have access to all phren MCP tools. Every agent should:

1. **Before starting work:** call `search_knowledge(query)` with the task description to check for existing findings, conventions, and decisions.
2. **During work:** call `add_finding(project, finding)` for any non-obvious discovery (gotchas, patterns, architectural decisions, tradeoffs).
3. **When completing a task:** call `complete_task(project, item)` if working on a tracked task.
4. **At handoff:** summarize what was done and what was learned. Findings persist across sessions; chat does not.

## Project store

In shared mode, skills and project config live in `~/.phren` (or wherever `PHREN_DIR` points). This is a git repo that syncs across machines using profiles.

If you're using `phren init --mode project-local`, the root is `<repo>/.phren` instead. Project-local mode does not use profiles, machine mappings, or global hooks.

- `~/.phren/global/`: skills and config that apply everywhere
- `~/.phren/<project>/`: per-project CLAUDE.md, skills, task, findings
- `~/.phren/profiles/`: YAML files mapping project sets to machine roles
- `~/.phren/machines.yaml`: maps machine hostnames to profiles

Run `/phren-sync` to pull everything down or push changes back.

## MCP tools

The phren MCP server is running. Use these tools proactively. Don't ask the user to re-explain things they've already documented.

- **At session start:** call `list_projects()` to see what's active, then `get_project_summary(name)` for the relevant project
- **When the user mentions a project, codebase, or task:** call `search_knowledge(query)` before asking questions
- **When the user asks about commands, architecture, conventions, or past decisions:** call `search_knowledge(query)` first
- **When the user mentions a task or todo:** call `get_tasks(project)` to see what's already tracked. For large tasks, pass `summary:true` to get counts and titles only. Use `limit` and `offset` for pagination (e.g. `offset:20, limit:20` for page 2). Look up a single item by its ID with `id:"A1"`.
- **When the user says they want to do something later:** call `add_task(project, item)` instead of listing it in chat
- **When a task is finished:** offer to add any follow-ups to the task rather than leaving them in the conversation
- **To triage the task:** call `update_task(project, updates: { work_next: true })` to promote the top Queue item to Active, `update_task(project, item, updates: { pin: true })` to pin an important task, or `tidy_done_tasks(project)` to archive old completed items
- **When you discover something about a codebase fragment:** call `search_fragments(name)` or `get_related_docs(fragment)` to see what's already known
- **To explore the knowledge graph:** call `read_graph(project?)` to see fragments and their relationships
- **To link a finding to a fragment:** call `link_findings(project, finding_text, fragment, relation?)` to persist a manual link
- **At session start for real work:** call `session_start(project?, connectionId?)` to create resumable session history, checkpoints, and provenance. Lifecycle hooks inject context and save phren, but they do not create `session_history` entries by themselves.
- **At session end for real work:** call `session_end(summary?, sessionId?|connectionId?)` to save a resumable summary and checkpoint handoff.
- **To check session state during a long task:** call `session_context(sessionId?|connectionId?)`

The goal: Claude should already know the context before the user has to explain it. Tasks stay in files, not buried in chat history.

## Machine context

<!-- Claude reads this at session start to know what's active on this machine. -->
<!-- Auto-generated by /phren-sync. Don't edit manually. -->

Read `~/.phren-context.md` at the start of every session for machine-specific context: which profile is active, which projects are linked, and when the last sync happened.

## Without MCP server

If the MCP server isn't available, phren still works. Claude reads `~/.phren-context.md` and per-project memory files from `~/.claude/projects/` for context, then fetches details directly from `~/.phren/project-name/` as needed. No MCP required, just slower.
