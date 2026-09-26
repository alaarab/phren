---
name: phren-init
description: Set up phren memory. Creates the store with `phren init` on first use, or adds the current project to an existing store with its summary, AGENTS.md and task list. Use when phren reports no store or the user wants a project remembered.
dependencies:
  - git
---
# phren-init - Scaffold a new project

> Set up a new project in phren with summary, AGENTS.md, task, and skill templates.

Add a new project to your phren instance, or bootstrap phren itself if you're starting fresh.

## Usage

```
phren-init my-new-project    # scaffold a specific project
phren-init                   # list existing projects, suggest unconfigured ones
```

## First: find or create the phren directory

```bash
PHREN_DIR="${PHREN_DIR:-$HOME/.phren}"
ls "$PHREN_DIR" 2>/dev/null
```

If the phren directory doesn't exist, this is a first run. Offer to set phren up:
> "phren has no memory store on this machine yet. Want me to run `phren init`? It creates a local git-backed store at ~/.phren and registers phren's memory hooks and MCP server with Claude Code (and any other agents it finds). Nothing leaves this machine unless you add a git remote."

If the user says yes, let the CLI build the store; never create it by hand:
```bash
if command -v phren >/dev/null 2>&1; then phren init --yes; else npx -y @phren/cli init --yes; fi
```

If phren's MCP server is running in setup mode it offers the same thing as the `phren_setup` tool (`confirm: true` runs it). Either way, tell the user to restart Claude Code afterwards so the memory tools and hooks load, then continue with the project scaffolding below if they named a project.

## With a project name

### 1. Check it doesn't already exist

```bash
ls "$PHREN_DIR/<project-name>/" 2>/dev/null
```

If it exists, tell the user and ask if they want to reset it or just update specific files.

### 2. Create the project directory

```bash
mkdir -p "$PHREN_DIR/<project-name>/skills"
```

### 3. Create summary.md

This is the project's identity card. Five lines, no more.

```markdown
# <project-name>

What: <one sentence about what this project does>
Stack: <languages, frameworks, key deps>
Status: <active / maintenance / new / archived>
Run: <the main command to start it, e.g. "npm run dev">
Watch out: <the one thing that trips people up>
```

Ask the user for these if you can't figure them out from the project directory. If the project directory exists on disk (e.g. `~/<project-name>/`), read its package.json, pyproject.toml, README, or similar to pre-fill.

### 4. Create AGENTS.md

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

### 5. Create tasks.md

```markdown
# <project-name> tasks

## Active

## Queue

## Done
```

### 6. Create skills README

```markdown
# <project-name> skills

Project-specific skills go here. Add `.md` files and Phren will resolve them together with global skills, then mirror the effective set into the project's `.claude/skills/` directory on sync.
```

Write this to `$PHREN_DIR/<project-name>/skills/README.md`.

### 7. Add to profile(s)

Check if profiles exist:
```bash
ls "$PHREN_DIR/profiles/"*.yaml 2>/dev/null
```

If profiles exist, ask: "Which profile should this project be in?" and show the options.

If no profiles exist, offer to create one:
> "No profiles set up yet. Want me to create a 'default' profile with this project in it?"

Then add the project name to the chosen profile's `projects` list.

### 8. Commit (if git repo)

```bash
cd "$PHREN_DIR"
git add <project-name>/
git add profiles/  # if modified
git commit -m "add <project-name>"
git push  # only if remote exists
```

If phren isn't a git repo yet, walk them through the full setup:

```bash
cd "$PHREN_DIR"
git init
git add -A
git commit -m "initial phren setup"
```

Then check if `gh` is available:

```bash
which gh && gh auth status
```

If yes, offer to create the GitHub repo:
> "Your phren isn't on GitHub yet. Want me to create a private repo and push it? That's what lets you sync across machines."

If they say yes:
```bash
gh repo create my-phren --private --source=. --push
```

If `gh` isn't available, show the manual steps:
> "Create a private repo at github.com/new, then:
>   git remote add origin git@github.com:YOU/my-phren.git
>   git push -u origin main
>
> Once it's on GitHub, clone it on any machine and run `phren:sync` to activate."

### 9. Report

```
phren-init <project-name>

Created:
  $PHREN_DIR/<project-name>/summary.md
  $PHREN_DIR/<project-name>/AGENTS.md
  $PHREN_DIR/<project-name>/tasks.md
  $PHREN_DIR/<project-name>/skills/README.md

Added to profile: default

Run phren-sync to activate on this machine.
```

## Without a project name

When user just runs `phren-init` with no args:

1. If phren directory exists, list all directories that have a `summary.md` (configured projects)
2. Look for directories in `~/` that look like projects (have package.json, pyproject.toml, Cargo.toml, go.mod, etc.) but don't have a phren entry
3. Show both lists and suggest adding unconfigured ones

```
phren-init: project scan

Configured in phren:
  myapp, api-server

Found on this machine but not in phren:
  ~/side-project (has package.json)
  ~/experiments/rust-thing (has Cargo.toml)

Run phren-init <name> to add one.
```

If phren doesn't exist at all, offer to bootstrap it from scratch.

## Related skills

- `phren-sync`: activate the new project on this machine after init
- `phren-discover`: find what to build next in a project
- `/tasks`: manage the project's task queue
