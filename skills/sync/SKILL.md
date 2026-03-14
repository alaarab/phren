---
name: sync
description: Sync your Claude skills and project config across machines using profiles.
dependencies:
  - git
---
# phren-sync - Profile-aware sync

> Sync your Claude skills and project config across machines using profiles that control what goes where.

Phren carries your skills and project config between machines. Profile-aware: he only syncs what belongs on this machine.

## Prerequisites

This skill requires a phren repository. If you don't have one yet, see "New machine setup" at the bottom.

**Expected structure:**
```
~/.phren/               # or wherever your phren repo lives
  global/               # skills and config for all projects
    skills/             # global skill files (.md)
    CLAUDE.md           # global Claude instructions
  <project>/            # per-project config
    CLAUDE.md
    skills/
    summary.md
  profiles/             # machine profile definitions
    work.yaml
    personal.yaml
  machines.yaml         # maps machine names to profiles
```

If any of these are missing, the skill will tell you what to create and how.

## How it works

Phren uses profiles to decide what goes where. A profile is a list of projects. A machine is mapped to a profile. When you sync, phren only brings over the projects in your machine's profile.

## Sync down (pull to this machine)

When the user says "get my skills", "sync my config", "pull from phren", or just "phren-sync":

### 1. Find the phren directory

```bash
PHREN_DIR="${PHREN_DIR:-$HOME/.phren}"
ls "$PHREN_DIR" 2>/dev/null
```

If the directory doesn't exist, tell the user:
> "No phren repo found at ~/.phren. Clone yours with `git clone <your-repo-url> ~/.phren`, or set `PHREN_DIR` to point to a different location."

### 2. Figure out which machine this is

```bash
cat ~/.phren/.machine-id 2>/dev/null || hostname
```

If `~/.phren/.machine-id` doesn't exist, ask the user to pick a name:
> "I need a machine name to look up your profile. What should I call this machine? (e.g. 'work-laptop', 'home-desktop')"

Then save it:
```bash
mkdir -p ~/.phren && echo "work-laptop" > ~/.phren/.machine-id
```

### 3. Look up the profile

```bash
cat "$PHREN_DIR/machines.yaml"
```

If the machine name isn't in `machines.yaml`, tell the user:
> "Machine 'work-laptop' isn't in machines.yaml yet. Which profile should it use?"
> Then show available profiles: `ls "$PHREN_DIR/profiles/"*.yaml`

```bash
cat "$PHREN_DIR/profiles/<profile-name>.yaml"
```

The profile YAML has:
```yaml
name: work
description: Work laptop setup
projects:
  - myapp
  - api-server
```

If no profiles exist yet, offer to create one with `phren-init`.

### 4. Pull latest

```bash
cd "$PHREN_DIR" && git pull
```

If this fails (not a git repo, no remote), tell the user. Don't silently skip.

### 5. Refresh the machine with the supported flow

Run init against the pulled phren repo so hooks, MCP registration, and machine/profile wiring are refreshed:

```bash
PHREN_PATH="$PHREN_DIR" npx phren init -y
```

If the user is in an untracked repo afterward, tell them to open a session there and let the agent ask, or run `phren add` from that directory.

Only mention `phren link` if the user is explicitly repairing an older pre-init install.

### 6. Build the context file

Write `~/.phren-context.md` with a summary of what's active on this machine:

```markdown
# Phren context: <machine-name> (<profile-name>)

Machine: <machine-name>
Profile: <profile-name>
Last synced: <date>

## Active projects
- myapp: Description from summary.md
- api-server: Description from summary.md

## Global skills
phren-sync, phren-init, phren-consolidate, phren-discover
```

Pull project descriptions from each project's `summary.md` if it exists.

### 7. Rebuild MEMORY.md

Regenerate `~/.claude/projects/*/memory/MEMORY.md` with cross-project awareness from the active profile. Pull key facts from each project's `summary.md`.

### 8. Check project health

After syncing, check each active project in the phren directory for missing files. Print a one-line status per project. Informational only, does not block the sync.

**Required files** (warn if missing):
- `summary.md`: project description used by context file and memory
- `CLAUDE.md`: project-level Claude instructions

**Recommended files** (note if missing, don't warn):
- `tasks.md`: persistent task queue
- `FINDINGS.md`: captured session findings

For each project in the profile, check `$PHREN_DIR/<project>/` for these files and print:

```
Project health:
  + my-app: all files present
  ~ backend: missing recommended: FINDINGS.md
  ! new-project: missing required: summary.md, CLAUDE.md
```

Legend: `+` all good, `~` missing recommended files, `!` missing required files.

Skip the "global" entry since it has a different structure. Only check actual project directories.

### 9. Report

```
phren-sync down: <machine-name> (<profile-name>)

Synced:
  - myapp (CLAUDE.md + 3 skills)
  - api-server (CLAUDE.md + 1 skill)
  - global (CLAUDE.md + 11 skills)

Skipped (not in profile):
  - old-project

Project health:
  + myapp: all files present
  ~ api-server: missing recommended: FINDINGS.md

Context: ~/.phren-context.md updated
```

## Sync up (push changes back)

When the user says "sync this back", "push to phren", "save this to my phren":

### 1. Find what changed

```bash
diff "$PHREN_DIR/<project>/CLAUDE.md" ./<project-path>/CLAUDE.md
diff -r "$PHREN_DIR/<project>/skills/" ./<project-path>/.claude/skills/

Remember: `.claude/skills/` is a generated mirror. The source-of-truth lives in phren `skills/`, and the project mirror also includes inherited global skills after resolution.
```

If files are symlinked (same inode), they're already in sync. Just commit from the phren directory.

If files are regular copies that differ, copy them back:
```bash
cp <changed-file> "$PHREN_DIR/<project>/<corresponding-path>"
```

### 2. Commit and push

```bash
cd "$PHREN_DIR"
git add -A
git commit -m "<project> updates from <machine-name>"
git push
```

## Conversational shortcuts

These should work naturally in conversation:

| User says | What to do |
|-----------|-----------|
| "add myapp to my work profile" | Edit the profile YAML, add to projects list, commit |
| "show me my personal profile" | Read and display the profile YAML |
| "what's on this machine?" | Read and display `~/.phren-context.md` |
| "remove old-project from work" | Edit the profile YAML, commit |
| "switch to personal profile" | Update the machine mapping in `machines.yaml`, re-run sync down |
| "create a new profile called travel" | Create a new profile YAML with empty projects list, ask what to include |

## New machine setup

First time on a new machine:

```bash
# 1. Clone your phren repo
git clone <your-repo-url> ~/.phren

# 2. Name this machine
mkdir -p ~/.phren && echo "my-machine-name" > ~/.phren/.machine-id

# 3. Map it to a profile in machines.yaml
#    Add a line: my-machine-name: work

# 4. Run phren-sync
```

If you don't have a phren repo yet, start with `phren-init` to create one from scratch.

## Conflict resolution

When two machines edit the same phren file before syncing, `git pull` will hit a merge conflict. Here's how to handle each file type:

**tasks.md**: Take both changes. Task items from both machines are valid. Concat them, deduplicate if needed, commit.

**FINDINGS.md**: Take both changes. Keep entries in chronological order. If both machines added entries on the same date, interleave or group them under the same date heading.

**CLAUDE.md**: Manual merge. Ask the user which version they want, or show both and let them pick. These files contain preferences and instructions where intent matters, so don't auto-resolve.

**skills/ files**: If the same skill was edited on both machines, show the user a diff and let them choose. If different skills were edited, git handles this automatically (no conflict).

**General approach**: Run `git pull --rebase` during sync. If conflicts appear, tell the user which files conflict and apply the rules above. Don't silently drop changes from either side.

## Related skills

- `phren-init`: create a new project or set up phren from scratch
- `add_finding()`: capture findings via MCP (synced across machines by `push_changes()`)
- `phren-consolidate`: synthesize findings across projects
