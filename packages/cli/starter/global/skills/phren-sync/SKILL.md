---
name: phren-sync
description: Pull the phren memory store onto this machine (and wire it with `phren init`) or push local memory changes to its git remote. Use on a new machine or when memory on another machine should catch up.
dependencies:
  - git
---
# /phren-sync

phren's store is a git repo (`~/.phren`, or `$PHREN_PATH`) that syncs across machines through profiles: a profile lists projects, `machines.yaml` maps a machine to a profile, and the CLI links whatever the profile says belongs here. **Do not create symlinks or write `MEMORY.md` by hand.** The CLI owns the wiring and `phren doctor` checks it.

## Pull (new machine, or "sync my config")

```bash
phren store sync                       # or on a new machine: git clone <store-url> ~/.phren
phren profile switch <profile>          # maps this machine (hostname) to a profile in machines.yaml
phren init -y                           # wires MCP, hooks, skill mirrors, project links for that profile
phren doctor                            # anything still red is either a repo not cloned here or a team store to join
```

If `machines.yaml` has no entry for this machine, ask which profile to use (`ls ~/.phren/profiles/`), then run the switch. If a profile project's repo is not on disk, that is expected on a new machine; clone it and run `phren add <path>`.

## Push ("save this to my phren", "sync back")

Store files are the linked originals, so edits made through `~/.claude/skills/*` or a project's `AGENTS.md` are already in the store. Commit and push from there:

```bash
git -C ~/.phren add -A && git -C ~/.phren commit -m "<what changed> from $(hostname)" && git -C ~/.phren push
```

The stop hook auto-saves too; a manual push is only for "I want it on the other machine now".

## Conflicts

`phren store sync` union-merges conflicts in `tasks.md`, `FINDINGS.md`, and task archives. For other conflicts, it aborts the merge and reports the paths for manual resolution. Never drop a side silently.

## Related

`/phren-profiles` to change what a profile contains. `phren config machines` and `phren config profiles` to see the mappings.
