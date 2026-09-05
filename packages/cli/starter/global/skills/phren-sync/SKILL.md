---
name: phren-sync
description: Pull your phren store onto this machine or push local changes back. Thin wrapper around the CLI, which does the linking.
dependencies:
  - git
---
# /phren-sync

phren's store is a git repo (`~/.phren`, or `$PHREN_PATH`) that syncs across machines through profiles: a profile lists projects, `machines.yaml` maps a machine to a profile, and the CLI links whatever the profile says belongs here. **Do not create symlinks or write `MEMORY.md` by hand.** The CLI owns the wiring and `phren doctor` checks it.

## Pull (new machine, or "sync my config")

```bash
git -C ~/.phren pull --rebase          # or on a new machine: git clone <store-url> ~/.phren
phren profile switch <profile>          # maps this machine (hostname) to a profile in machines.yaml
phren init -y                           # wires MCP, hooks, skill mirrors, project links for that profile
phren doctor                            # anything still red is either a repo not cloned here or a team store to join
```

If `machines.yaml` has no entry for this machine, ask which profile to use (`ls ~/.phren/profiles/`), then run the switch. If a profile project's repo is not on disk, that is expected on a new machine; clone it and run `phren add <path>`.

## Push ("save this to my phren", "sync back")

Store files are the linked originals, so edits made through `~/.claude/skills/*` or a project's `CLAUDE.md` are already in the store. Commit and push from there:

```bash
git -C ~/.phren add -A && git -C ~/.phren commit -m "<what changed> from $(hostname)" && git -C ~/.phren push
```

The stop hook auto-saves too; a manual push is only for "I want it on the other machine now".

## Conflicts

`git pull --rebase` may conflict when two machines edited the same file. `tasks.md` and `FINDINGS.md`: keep both sides. `CLAUDE.md` and skills: show the user both and let them choose. Never drop a side silently.

## Related

`/phren-profiles` to change what a profile contains. `phren config machines` and `phren config profiles` to see the mappings.
