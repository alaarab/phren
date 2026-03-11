---
name: cortex-consolidate
description: Find patterns across project findings and surface insights that apply everywhere.
dependencies:
  - git
---
# cortex-consolidate - Cross-project synthesis

> Find patterns across project findings and surface insights that apply everywhere.

Read every project's FINDINGS.md, find patterns that show up across multiple projects, and write them to a shared global findings file.

The point: something you learned on one project probably applies elsewhere. This surfaces those connections.

## Prerequisites

This skill needs at least two projects with FINDINGS.md files to be useful. If you haven't captured any findings yet, use `add_finding()` during a session first.

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
> "No cortex directory found at ~/.cortex. This skill needs a cortex repo with project findings. Run `cortex-init` to set one up, or set CORTEX_DIR if yours is elsewhere."

### 2. Gather ALL findings

Try the profile-aware path first, fall back to scanning all directories:

```bash
MACHINE=$(cat ~/.cortex/.machine-id 2>/dev/null || hostname)
# look up profile in machines.yaml to get the project list

# fallback: scan all project directories
FINDINGS_FILES=()
for dir in "$CORTEX_DIR"/*/; do
  if [ -f "$dir/FINDINGS.md" ]; then
    PROJECT_NAME=$(basename "$dir")
    FINDINGS_FILES+=("$PROJECT_NAME:$dir/FINDINGS.md")
  fi
done
```

Read **every** FINDINGS.md file found. Don't sample or skip any. For each file, track which project it came from.

If no FINDINGS.md files exist anywhere, tell the user:
> "No FINDINGS.md files found in any project. Use `add_finding()` during a work session to start capturing findings."

If only one project has a FINDINGS.md, tell the user:
> "Only found findings for <project>. Need at least two projects to find cross-cutting patterns. Use `add_finding()` in other projects first."

### 3. Find cross-cutting patterns

Compare findings across all projects. A pattern counts as cross-cutting when the **same insight, technique, or pitfall** appears in 2+ projects. Don't just look for keyword overlap; look for conceptual overlap.

Be specific. Not "testing is important" but "mocking at service boundaries instead of HTTP layer caught integration bugs in both my-app and backend."

Common categories (use only the ones that have actual matches):

- **Build and tooling**: cache issues, config pitfalls, CI patterns
- **Testing**: mocking strategies, fixture patterns, what to test vs skip
- **TypeScript/JS**: type tricks, async pitfalls, framework quirks
- **State management**: reactivity pitfalls, update ordering, stale closures
- **API patterns**: error handling, retry logic, auth flows
- **Performance**: what actually mattered vs premature optimization
- **Git and workflow**: branching patterns, commit conventions, release steps
- **Dependencies**: version conflicts, peer dep issues, lock file handling

Don't force categories. If only one project mentions something, it stays project-specific. If a pattern genuinely spans projects, include it even if it doesn't fit a neat category.

### 4. Check existing global findings

Before writing, read `$CORTEX_DIR/global/FINDINGS.md` if it exists. Don't duplicate entries that are already there. Update existing entries if there's new evidence or additional projects that confirm the pattern.

### 5. Write global findings

File: `$CORTEX_DIR/global/FINDINGS.md`

```markdown
# Cross-project findings

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
- Be specific enough that someone could act on it without reading the original findings
- If two projects describe the same thing differently, synthesize into one clear statement
- Keep entries to 1-2 lines max

### 6. Report

```
cortex-consolidate

Scanned: my-app (12 findings), backend (8 findings), frontend (5 findings)

Found 6 cross-cutting patterns:
  Build: 2 patterns (cache invalidation, lock file handling)
  Testing: 2 patterns (mock boundaries, fixture scoping)
  TypeScript: 2 patterns (strict nulls, path aliases)

New patterns added: 4
Existing patterns updated: 2 (added new project evidence)
Skipped: 0 (already captured)

Updated: $CORTEX_DIR/global/FINDINGS.md
```

### 7. Commit (if git repo)

```bash
cd "$CORTEX_DIR"
git add global/FINDINGS.md
git commit -m "update global findings"
git push  # only if remote exists
```

## What not to do

- Don't include findings that only apply to one project. Those stay in the project's own file.
- Don't water down specifics to make them "general." If it's about Angular signals specifically, say so.
- Don't duplicate what's already in global findings. Update existing entries if there's new evidence.
- Don't create a wall of text. Keep it scannable. Bullet points, grouped by theme.
- Don't invent patterns. If two findings use the same word but describe different problems, they're not a pattern.

## Related skills

- `add_finding()`: capture findings during a session via MCP
- `cortex-sync`: sync the consolidated findings to other machines
