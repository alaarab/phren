---
name: discover
description: Audit your cortex repo and tell you exactly what needs attention.
---
# /cortex-discover - Cortex health check

> Audit your cortex repo and tell you exactly what needs attention.

Scans your cortex directory for missing files, stale content, skill gaps, and stuck backlog items. Outputs a concrete, prioritized action list.

**Works standalone.** Just needs a cortex directory.

## When to run

- Weekly or monthly maintenance
- When you feel like things are getting messy
- Before starting a new project (to see what you've been neglecting)
- When the user asks "what should I work on"

## What to do

### 1. Find the cortex directory

```bash
CORTEX_DIR="${CORTEX_DIR:-$HOME/cortex}"
ls "$CORTEX_DIR" 2>/dev/null
```

If it doesn't exist:
> "No cortex directory found at ~/cortex. Run `/cortex-init` to set one up."

### 2. Scan all projects

For each project directory in `$CORTEX_DIR/*/` (skip `global/`, `profiles/`):

```bash
for dir in "$CORTEX_DIR"/*/; do
  PROJECT=$(basename "$dir")
  [ "$PROJECT" = "global" ] || [ "$PROJECT" = "profiles" ] && continue

  [ -f "$dir/CLAUDE.md" ]    && echo "$PROJECT: has CLAUDE.md"    || echo "$PROJECT: MISSING CLAUDE.md"
  [ -f "$dir/summary.md" ]   && echo "$PROJECT: has summary.md"   || echo "$PROJECT: MISSING summary.md"
  [ -f "$dir/LEARNINGS.md" ] && echo "$PROJECT: has LEARNINGS.md" || echo "$PROJECT: MISSING LEARNINGS.md"
  [ -f "$dir/backlog.md" ]   && echo "$PROJECT: has backlog.md"   || echo "$PROJECT: MISSING backlog.md"
done
```

### 3. Check staleness

For projects that are in a git-tracked cortex, check when files were last modified:

```bash
cd "$CORTEX_DIR"
for dir in */; do
  PROJECT=$(basename "$dir")
  [ "$PROJECT" = "global" ] || [ "$PROJECT" = "profiles" ] && continue

  if [ -f "$dir/LEARNINGS.md" ]; then
    LAST_MODIFIED=$(git log -1 --format="%cr" -- "$dir/LEARNINGS.md" 2>/dev/null || stat -c %Y "$dir/LEARNINGS.md" 2>/dev/null)
    echo "$PROJECT/LEARNINGS.md: last updated $LAST_MODIFIED"
  fi

  if [ -f "$dir/CLAUDE.md" ]; then
    LAST_MODIFIED=$(git log -1 --format="%cr" -- "$dir/CLAUDE.md" 2>/dev/null || stat -c %Y "$dir/CLAUDE.md" 2>/dev/null)
    echo "$PROJECT/CLAUDE.md: last updated $LAST_MODIFIED"
  fi
done
```

Flag anything not updated in 30+ days as stale.

### 4. Detect skill gaps

Look at patterns in backlog.md files and LEARNINGS.md files across projects. A skill gap is when:
- Multiple projects repeat the same manual process (e.g., "remember to update the changelog," which should be a skill)
- A LEARNINGS.md entry says "next time, do X first," which is a skill waiting to happen
- A backlog item keeps getting deferred, and might need a skill to make it easier

Also check global/skills/ to see what skills exist, and whether any project's workflow isn't covered.

### 5. Check backlog health

For each project with a backlog.md:
- Count total items, completed items, items with no recent progress
- Flag backlogs where nothing has been completed recently
- Flag backlogs with items older than 60 days that haven't moved

### 6. Output the report

```
/cortex-discover

## Section 1: Missing files

Projects without core files:

| Project | CLAUDE.md | summary.md | LEARNINGS.md | backlog.md |
|---------|-----------|------------|--------------|------------|
| myapp   | ok        | MISSING    | MISSING      | ok         |
| api     | ok        | ok         | ok           | MISSING    |

## Section 2: Stale content

Files not updated in 30+ days:
- my-app/LEARNINGS.md: last updated 45 days ago
- frontend/CLAUDE.md: last updated 62 days ago

## Section 3: Skill gaps

Things you do repeatedly that could be skills:
- "Update changelog before release" appears in 3 project backlogs. Consider a `/changelog` skill.
- my-app LEARNINGS.md mentions "always run parity check" 4 times. Already have `/parity`, but it's not in the workflow skill.

## Section 4: Backlog health

- my-app: 12 items (3 completed, 2 stale > 60 days)
- backend: 5 items (0 completed, all stale)
- frontend: 8 items (6 completed, healthy)

Stuck items:
- backend#2: "Add rate limiting" (added 90 days ago, no progress)
- my-app#7: "Improve query performance" (added 75 days ago, no progress)

## Top 3 things to work on next

1. **Add LEARNINGS.md to myapp.** You've been working on it actively but capturing nothing. Learnings are captured automatically via hooks now, but the file needs to exist first.
2. **Unstick api-server backlog.** 5 items, 0 completed. Either work them or trim them. Stale backlogs are worse than no backlog.
3. **Create a `/changelog` skill.** You're doing it manually in 3 projects. 15 minutes to write the skill saves hours over time.
```

The "Top 3" section is the most important part. Make these:
- Concrete (not "improve documentation" but "add LEARNINGS.md to myapp")
- Prioritized (highest impact first)
- Actionable (someone could start right now)

## What not to do

- Don't flag missing files in projects that are archived or inactive
- Don't recommend creating files just for completeness; only flag what would actually help
- Don't be vague in the Top 3. Every item should be a clear next action.
- Don't pad the report with things that are fine. Focus on what needs attention.

## Related skills

- `/cortex-init`: scaffold missing files for a project
- `/cortex-consolidate`: synthesize cross-project patterns
- `/backlog`: work on stuck backlog items
