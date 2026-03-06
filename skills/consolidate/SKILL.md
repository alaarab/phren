---
name: consolidate
description: Find patterns across project learnings and surface insights that apply everywhere.
---
# /cortex-consolidate - Cross-project synthesis

> Find patterns across project learnings and surface insights that apply everywhere.

Read every project's LEARNINGS.md, find patterns that show up across multiple projects, and write them to a shared global learnings file.

The point: something you learned on one project probably applies elsewhere. This surfaces those connections.

## Prerequisites

This skill needs at least two projects with LEARNINGS.md files to be useful. If you haven't captured any learnings yet, use `add_learning()` during a session first.

**Works with or without profiles.** If profiles are set up, it scans projects in the active profile. If not, it scans all project directories in the cortex repo.

## When to run

- Monthly, or when the user asks
- After a burst of work across multiple projects
- When starting a new project (to seed it with relevant cross-cutting knowledge)

## What to do

### 1. Find the cortex directory

```bash
CORTEX_DIR="${CORTEX_DIR:-$HOME/.cortex}"
ls "$CORTEX_DIR" 2>/dev/null
```

If it doesn't exist, tell the user:
> "No cortex directory found at ~/.cortex. This skill needs a cortex repo with project learnings. Run `/cortex-init` to set one up, or set CORTEX_DIR if yours is elsewhere."

### 2. Gather ALL learnings

Try the profile-aware path first, fall back to scanning all directories:

```bash
MACHINE=$(cat ~/.cortex-machine 2>/dev/null || hostname)
# look up profile in machines.yaml to get the project list

# fallback: scan all project directories
LEARNINGS_FILES=()
for dir in "$CORTEX_DIR"/*/; do
  if [ -f "$dir/LEARNINGS.md" ]; then
    PROJECT_NAME=$(basename "$dir")
    LEARNINGS_FILES+=("$PROJECT_NAME:$dir/LEARNINGS.md")
  fi
done
```

Read **every** LEARNINGS.md file found. Don't sample or skip any. For each file, track which project it came from.

If no LEARNINGS.md files exist anywhere, tell the user:
> "No LEARNINGS.md files found in any project. Use `add_learning()` during a work session to start capturing learnings."

If only one project has a LEARNINGS.md, tell the user:
> "Only found learnings for <project>. Need at least two projects to find cross-cutting patterns. Use `add_learning()` in other projects first."

### 3. Find cross-cutting patterns

Compare learnings across all projects. A pattern counts as cross-cutting when the **same insight, technique, or gotcha** appears in 2+ projects. Don't just look for keyword overlap; look for conceptual overlap.

Be specific. Not "testing is important" but "mocking at service boundaries instead of HTTP layer caught integration bugs in both my-app and backend."

Common categories (use only the ones that have actual matches):

- **Build and tooling**: cache issues, config gotchas, CI patterns
- **Testing**: mocking strategies, fixture patterns, what to test vs skip
- **TypeScript/JS**: type tricks, async pitfalls, framework quirks
- **State management**: reactivity gotchas, update ordering, stale closures
- **API patterns**: error handling, retry logic, auth flows
- **Performance**: what actually mattered vs premature optimization
- **Git and workflow**: branching patterns, commit conventions, release steps
- **Dependencies**: version conflicts, peer dep issues, lock file handling

Don't force categories. If only one project mentions something, it stays project-specific. If a pattern genuinely spans projects, include it even if it doesn't fit a neat category.

### 4. Check existing global learnings

Before writing, read `$CORTEX_DIR/global/LEARNINGS.md` if it exists. Don't duplicate entries that are already there. Update existing entries if there's new evidence or additional projects that confirm the pattern.

### 5. Write global learnings

File: `$CORTEX_DIR/global/LEARNINGS.md`

```markdown
# Cross-project learnings

Last consolidated: <date>
Sources: <list of project names scanned>

## Build and tooling
- Clear dist/ after any tsconfig change, the build cache doesn't invalidate (my-app, backend)
- Lock file conflicts: delete and regenerate, don't try to merge (my-app, frontend)

## Testing
- Mock at the service boundary, not the HTTP layer (backend, frontend)
- Session-scoped fixtures cause flaky parallel tests (backend, my-app)
```

Rules for each entry:
- Include which projects it came from in parentheses
- Be specific enough that someone could act on it without reading the original learnings
- If two projects describe the same thing differently, synthesize into one clear statement
- Keep entries to 1-2 lines max

### 6. Report

```
/cortex-consolidate

Scanned: my-app (12 learnings), backend (8 learnings), frontend (5 learnings)

Found 6 cross-cutting patterns:
  Build: 2 patterns (cache invalidation, lock file handling)
  Testing: 2 patterns (mock boundaries, fixture scoping)
  TypeScript: 2 patterns (strict nulls, path aliases)

New patterns added: 4
Existing patterns updated: 2 (added new project evidence)
Skipped: 0 (already captured)

Updated: $CORTEX_DIR/global/LEARNINGS.md
```

### 7. Commit (if git repo)

```bash
cd "$CORTEX_DIR"
git add global/LEARNINGS.md
git commit -m "update global learnings"
git push  # only if remote exists
```

## What not to do

- Don't include learnings that only apply to one project. Those stay in the project's own file.
- Don't water down specifics to make them "general." If it's about Angular signals specifically, say so.
- Don't duplicate what's already in global learnings. Update existing entries if there's new evidence.
- Don't create a wall of text. Keep it scannable. Bullet points, grouped by theme.
- Don't invent patterns. If two learnings use the same word but describe different problems, they're not a pattern.

## Related skills

- `add_learning()`: capture learnings during a session via MCP
- `/cortex-sync`: sync the consolidated learnings to other machines
