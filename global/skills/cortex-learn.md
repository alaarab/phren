# /cortex-learn - Extract What You Learned

> Capture session learnings as durable, project-specific notes that persist across conversations.

Post-session learning capture. Pulls out patterns, gotchas, and decisions from what just happened and saves them so future sessions don't repeat mistakes.

**Works standalone.** You don't need the full cortex setup. If there's no cortex repo, learnings get saved to a LEARNINGS.md in the project directory itself. If cortex is set up, they go to the cortex repo where they sync across machines.

## Usage

```
/cortex-learn              # auto-detect project from cwd
/cortex-learn myapp        # specify project explicitly
```

## What to do

### 1. Figure out the project

Check cwd against known project paths. If ambiguous, ask.

```bash
# What directory are we in?
pwd
# Does it match a known project?
basename $(git rev-parse --show-toplevel 2>/dev/null || pwd)
```

### 2. Figure out where to save

```bash
CORTEX_DIR="${CORTEX_DIR:-$HOME/cortex}"

if [ -d "$CORTEX_DIR/<project>" ]; then
  # Full cortex setup: save to cortex repo
  LEARNINGS_FILE="$CORTEX_DIR/<project>/LEARNINGS.md"
else
  # Standalone mode: save to project directory
  LEARNINGS_FILE="./<project-root>/LEARNINGS.md"
fi
```

If neither location makes sense, ask the user where to put it.

### 3. Review what just happened

Look at the session context:
- Recent file edits (what was touched, what patterns emerged)
- Commands that were run (especially ones that failed first, then worked)
- Decisions made (why X instead of Y)
- Surprises (things that didn't work as expected)

### 4. Extract the learnings

Only keep things that pass this filter: **"Would knowing this save time next session?"**

Good learnings:
- "Angular signals don't trigger change detection in zone-less mode (call markForCheck() after updates)"
- "The build cache breaks if you change tsconfig paths. Clear dist/ first."
- "pytest fixtures in conftest.py are session-scoped by default in this project"

Bad learnings (don't save these):
- "Updated the README" (that's a log entry, not a learning)
- "The codebase uses TypeScript" (obvious from looking at it)
- "Fixed a bug in the login flow" (what was the bug? what was the gotcha?)

### 5. Write to LEARNINGS.md

Create the file if it doesn't exist. Append new entries at the top with a date header.

```markdown
## 2026-03-04

- Angular: `markForCheck()` needed after signal updates in zone-less mode
- Build: clear dist/ after tsconfig path changes, cache doesn't invalidate
- Testing: mock the Graph client, not the HTTP layer (SPFx wraps it)
```

Keep entries as bullet points. One line each. Specific enough to act on. No filler.

### 6. Commit (if in a git repo)

If the learnings file is inside a git repo (either cortex or the project itself):

```bash
cd <repo-root>
git add <path-to>/LEARNINGS.md
git commit -m "learn: <project>: <one-line summary of what was learned>"
git push  # only if remote exists
```

If it's not in a git repo, just save the file and tell the user.

### 7. Report

```
/cortex-learn <project>

Extracted 3 learnings:
- Angular signal change detection gotcha
- Build cache invalidation on tsconfig changes
- Graph client mocking strategy

Saved to: <path>/LEARNINGS.md
Committed: learn: myapp: signal detection, build cache, graph mocking
```

## What makes a good learning

- **Specific.** Not "be careful with state" but "React state updates in event handlers are batched, so reading state right after setState gives stale values."
- **Actionable.** Someone reading this can change their behavior.
- **Not obvious.** If you'd know it from reading the README, skip it.
- **Durable.** Will this still be true next month? Skip one-off workarounds for temporary issues.

## Related skills

- `/cortex-consolidate`: find patterns across learnings from multiple projects
- `/cortex-sync`: sync learnings across machines (requires full cortex setup)
