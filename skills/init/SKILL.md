---
name: init
description: Set up a new project in cortex with summary, CLAUDE.md, backlog, and skill templates.
dependencies:
  - git
---
# /cortex-init - Scaffold a new project

> Set up a new project in cortex with summary, CLAUDE.md, backlog, and skill templates.

Add a new project to your cortex instance, or bootstrap cortex itself if you're starting fresh.

## Usage

```
/cortex-init my-new-project    # scaffold a specific project
/cortex-init                   # list existing projects, suggest unconfigured ones
```

## First: find or create the cortex directory

```bash
CORTEX_DIR="${CORTEX_DIR:-$HOME/.cortex}"
ls "$CORTEX_DIR" 2>/dev/null
```

If the cortex directory doesn't exist, offer to create it:
> "No cortex repo found. Want me to create one at ~/.cortex? This will set up the base directory structure (global/, profiles/, machines.yaml)."

If the user says yes, create the base structure:
```bash
mkdir -p "$CORTEX_DIR"/{global/skills,profiles}
# Create a starter machines.yaml
# Create a starter profile
```

Then continue with the project scaffolding below.

## With a project name

### 1. Check it doesn't already exist

```bash
ls "$CORTEX_DIR/<project-name>/" 2>/dev/null
```

If it exists, tell the user and ask if they want to reset it or just update specific files.

### 2. Create the project directory

```bash
mkdir -p "$CORTEX_DIR/<project-name>/skills"
```

### 3. Create summary.md

This is the project's identity card. Five lines, no more.

```markdown
# <project-name>

What: <one sentence about what this project does>
Stack: <languages, frameworks, key deps>
Status: <active / maintenance / new / archived>
Run: <the main command to start it, e.g. "npm run dev">
Gotcha: <the one thing that trips people up>
```

Ask the user for these if you can't figure them out from the project directory. If the project directory exists on disk (e.g. `~/<project-name>/`), read its package.json, pyproject.toml, README, or similar to pre-fill.

### 4. Create CLAUDE.md

```markdown
# <project-name>

<One paragraph: what this project is and what it does.>

## Commands

```
<dev command>
<build command>
<test command>
```

## Architecture

<!-- Fill this in as the project grows -->

## Conventions

<!-- Project-specific rules, patterns, naming conventions -->
```

Pre-fill from the project's existing README or package.json if available. Leave architecture and conventions as placeholders with the HTML comments.

### 5. Create backlog.md

```markdown
# <project-name> backlog

## Active

## Queue

## Done
```

### 6. Create skills README

```markdown
# <project-name> skills

Project-specific skills go here. Add .md files and they'll be symlinked to the project's .claude/skills/ directory on sync.
```

Write this to `$CORTEX_DIR/<project-name>/skills/README.md`.

### 7. Add to profile(s)

Check if profiles exist:
```bash
ls "$CORTEX_DIR/profiles/"*.yaml 2>/dev/null
```

If profiles exist, ask: "Which profile should this project be in?" and show the options.

If no profiles exist, offer to create one:
> "No profiles set up yet. Want me to create a 'default' profile with this project in it?"

Then add the project name to the chosen profile's `projects` list.

### 8. Commit (if git repo)

```bash
cd "$CORTEX_DIR"
git add <project-name>/
git add profiles/  # if modified
git commit -m "add <project-name>"
git push  # only if remote exists
```

If cortex isn't a git repo yet, walk them through the full setup:

```bash
cd "$CORTEX_DIR"
git init
git add -A
git commit -m "initial cortex setup"
```

Then check if `gh` is available:

```bash
which gh && gh auth status
```

If yes, offer to create the GitHub repo:
> "Your cortex isn't on GitHub yet. Want me to create a private repo and push it? That's what lets you sync across machines."

If they say yes:
```bash
gh repo create my-cortex --private --source=. --push
```

If `gh` isn't available, show the manual steps:
> "Create a private repo at github.com/new, then:
>   git remote add origin git@github.com:YOU/my-cortex.git
>   git push -u origin main
>
> Once it's on GitHub, clone it on any machine and run `/cortex:sync` to activate."

### 9. Report

```
/cortex-init <project-name>

Created:
  $CORTEX_DIR/<project-name>/summary.md
  $CORTEX_DIR/<project-name>/CLAUDE.md
  $CORTEX_DIR/<project-name>/backlog.md
  $CORTEX_DIR/<project-name>/skills/README.md

Added to profile: default

Run /cortex-sync to activate on this machine.
```

## Without a project name

When user just runs `/cortex-init` with no args:

1. If cortex directory exists, list all directories that have a `summary.md` (configured projects)
2. Look for directories in `~/` that look like projects (have package.json, pyproject.toml, Cargo.toml, go.mod, etc.) but don't have a cortex entry
3. Show both lists and suggest adding unconfigured ones

```
/cortex-init: project scan

Configured in cortex:
  myapp, api-server

Found on this machine but not in cortex:
  ~/side-project (has package.json)
  ~/experiments/rust-thing (has Cargo.toml)

Run /cortex-init <name> to add one.
```

If cortex doesn't exist at all, offer to bootstrap it from scratch.

## Related skills

- `/cortex-sync`: activate the new project on this machine after init
- `/cortex-discover`: find what to build next in a project
- `/backlog`: manage the project's task queue
