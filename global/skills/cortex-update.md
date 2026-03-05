# /cortex:update - End of day

Wrap up the session. Capture what you learned, commit it, push it.

Run this when you're done for the day, switching machines, or just want to save state. Say "update my cortex", "wrap it up", "done for today", or "save what we learned": they all trigger this.

## What it does

1. Detects which projects were touched this session (from recent file edits or context)
2. For each project, extracts learnings and updates `LEARNINGS.md`
3. Commits everything to the cortex repo
4. Pushes to remote

Tomorrow, on any machine, Claude has it all.

## Step 1: Detect active projects

Look at what was discussed and edited this session. List the project names that had meaningful work done. If only one project, proceed with that. If unclear, ask.

## Step 2: Extract learnings for each project

For each project, run the same process as `/cortex:learn`:

- What bugs or blockers came up, and how they were resolved?
- What patterns or conventions were established?
- What decisions were made and why?
- What should be avoided next time?
- What's still in progress?

Write to `~/.cortex/<project>/LEARNINGS.md`. Append under a date heading:

```markdown
## YYYY-MM-DD

- <learning>
- <learning>
```

If `LEARNINGS.md` doesn't exist, create it.

## Step 3: Commit and push

```bash
cd ~/.cortex
git add -A
git commit -m "<project(s)>: session learnings $(date +%Y-%m-%d)"
git push
```

If push fails (no remote, auth issue), commit locally and note it.

## Step 4: Confirm

Report back:

```
/cortex:update done

Projects updated: <list>
Learnings added: <count> items
Pushed: yes / local only (reason)
```

## If nothing to save

If the session had no meaningful learnings (setup work, reading, no decisions made), say so and skip the commit. Don't write empty entries.
