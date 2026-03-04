---
name: pipeline
description: Status check that reads your actual repo state and tells you exactly where you are in the workflow.
---
# /pipeline - Where Am I Right Now

Run this when you're not sure where you are in the workflow.

It's a status check, not a guide. Read the actual state of the repo and report it.

## What to detect

**1. Project identity**

```bash
# Name and what kind of project it is
cat package.json | grep '"name"'
# Or check for CLAUDE.md
cat CLAUDE.md | head -5
```

**2. Branch and commits**

```bash
git branch --show-current
git status --short
git log --oneline -5
git rev-list --count @{u}.. 2>/dev/null || echo "no upstream"
```

**3. What's actually changed**

```bash
git diff --stat HEAD
git diff --cached --stat
```

**4. Has /done been run?**

Check for signs that the feature is wrapped up:
- Is CHANGELOG.md or HISTORY.md recently touched? (`git log --oneline -1 -- CHANGELOG.md`)
- Did the last commit message look like a release or completion?
- Are there any uncommitted changes left?

**5. Tests and build**

Only check if it's fast. If the test suite takes minutes, skip it and note that. Don't block the status check on a long test run.

## How to report it

After gathering the above, output a clean status block:

```
/pipeline - <project-name> (<branch>)

Stage: <stage>
Branch: <branch> (<N> commits ahead of <upstream>)
Changes: <X files modified, Y new> (or "clean working tree")

Done:
  <list what's confirmed complete>

Next:
  <what to do next>
```

**Stages** (pick the most accurate one):

| Stage | What it means |
|-------|--------------|
| Building | Uncommitted changes - feature still in progress |
| Ready for /done | Clean tree, tests likely passing, need to wrap up |
| Post-/done | Changelog updated, commits look complete |
| Ready to push | Everything done, not yet on remote |
| Ready to release | Pushed, needs version bump and publish |
| Shipped | Published and tagged |

## What "Next" should say

Don't list every possible action. Pick the one thing that makes sense right now:

- Mid-feature: "Keep building"
- Done building, messy commit: "Run /done before committing"
- Agents were involved: "Consider /humanize"
- Clean and wrapped: "Push when ready"
- Ready to publish: "Run /release"
- After push: "Nothing - you're done"

## What not to do

Don't just describe the pipeline steps in general. Read the actual repo state first, then tell the user where they are in it. The output should be specific to this moment, not a template.

If the project has its own CLAUDE.md, check it for project-specific pipeline steps (e.g., OGrid has its own build/test/publish flow).
