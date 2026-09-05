# Instructions for the agent

<!-- phren copies this to ~/.phren/global/CLAUDE.md and links it as ~/.claude/CLAUDE.md. Every session reads it, so keep it short and addressed to the agent. Fill in "How I work"; leave the rest. -->

## Memory lives in phren

phren already knows this user's projects. Ask it before asking them to repeat themselves, and tell it what you learn as you go, not at the end.

- Recall: `search_knowledge(query)`, then `get_memory_detail(id)` for the full entry. `get_project_summary(project)` when starting on a project.
- Save: `add_finding(project, finding, findingType?)` the moment you learn something non-obvious that would save time next session. `kind: "note"` for a lightweight daily note.
- Tasks: `get_tasks(project)`, `add_task(project, item)`, `manage_task(action: "complete", project, item)`. Tasks live in phren, not in chat.
- Sessions: `session(action: "start", project)` for substantial work, `session(action: "end", summary)` when done. Hooks do not do this for you.
- Everything else: `phren_admin(action: …)`; `phren_admin(action: "list_actions")` lists it.
- Do not write to `~/.claude/projects/*/memory/`. phren is the memory.

Worth saving: decisions and why, pitfalls with the fix, patterns that worked, measurements. Not worth saving: secrets or personal data, one-off facts, narration of what happened, anything obvious from the code. Fewer, sharper entries beat volume.

## How I work

<!-- Your rules, in your words. Examples: -->
<!-- - Lead with the answer. Don't over-engineer. Scope to what I asked. -->
<!-- - Draft emails and comms for me, don't send. -->
<!-- - Save findings as we go, not at the end. -->

## Skills

`/phren-sync`, `/phren-init`, `/phren-discover`, `/phren-consolidate`, `/phren-profiles`, `/phren-summarize` manage the store. Your own skills live in `~/.phren/global/skills/` and are listed by `phren skills list`; invoke them by name rather than expecting them to appear as memory.

## Team agents

Every agent follows these rules, and tells phren about non-obvious findings before handing work back.

## Where things are

`~/.phren` (or `$PHREN_PATH`) is a git repo: `global/` for everything-everywhere, `<project>/` for each project's CLAUDE.md, findings, tasks and skills, `profiles/` and `machines.yaml` for which projects belong on which machine. `phren doctor` explains anything that is off. If the MCP server is not running, phren still injects context through hooks; the CLI (`phren search`, `phren add-finding`) does the rest.
