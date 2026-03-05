---
name: consolidate
description: Consolidate a project's LEARNINGS.md: deduplicate, archive old entries, promote cross-project patterns to global.
---
# /cortex-consolidate

Consolidate accumulated learnings. Deduplicates, archives, and promotes cross-project patterns. Run this when cortex tells you a project has 25+ new entries, or any time you want to clean up.

## What "consolidate" means

1. **Deduplicate:** merge entries that say the same thing differently
2. **Distill:** rewrite scattered bullets into clear, actionable insights
3. **Archive:** move all pre-consolidation entries into a `<details>` block (preserved, not deleted)
4. **Promote:** patterns that appear in 3+ projects go to `global/LEARNINGS.md`
5. **Mark:** write a `<!-- consolidated: -->` marker so detection knows where you left off

## Step 1: Pick which projects to consolidate

If the user said a specific project, use that. Otherwise check which projects have a `<cortex-notice>` about consolidation in the current context, and ask if they want to consolidate all of them or pick one.

Read each target project's full LEARNINGS.md.

## Step 2: Find the marker

Look for `<!-- consolidated: YYYY-MM-DD -->` near the top of the file. Entries **after** that line are the new ones to consolidate. Entries **before** it (or inside `<details>`) are already archived: leave them alone.

If there's no marker, consolidate the entire file.

## Step 3: Distill new entries

Read all new entries (after the marker, outside any `<details>` block). For each group:

- Merge entries that say the same thing
- Rewrite vague entries to be specific and actionable
- Drop entries that describe obvious/temporary things ("updated the README")
- Group by theme (build, testing, patterns, gotchas, etc.)

Target: reduce by 40-70%. If you started with 40 entries, aim for 12-25 distilled ones.

**Good entry:** "Angular signals don't trigger change detection in zone-less mode: call `markForCheck()` after updates"
**Bad entry:** "Be careful with state"

## Step 4: Write the consolidated file

Keep all existing content before the first heading or marker. Then write:

```markdown
# <project> LEARNINGS

<!-- consolidated: YYYY-MM-DD | entries: N → M | global promoted: K | prev: LAST_DATE -->

## <Theme>

- Distilled insight here
- Another insight

## <Theme>

- ...

<details>
<summary>Archive: entries before YYYY-MM-DD (N entries)</summary>

[paste every pre-consolidation bullet point verbatim here, unedited]

</details>
```

Rules:
- The `<!-- consolidated: -->` marker goes right after the title line
- `prev:` should be the date from the previous marker (chain them so history is traceable)
- The `<details>` block contains ALL entries that existed before this consolidation run: both the ones you just distilled AND any from previous `<details>` blocks (merge them)
- Never delete entries, only move them to the archive

## Step 5: Check global promotion

Read `~/.cortex/global/LEARNINGS.md`. For each distilled insight, ask: does this appear in 3+ projects, or does it extend an existing global entry?

If yes, add or update the global entry (include project names in parentheses).

Don't remove the entry from the project file. Global promotion is additive.

## Step 6: Commit

```bash
cd ~/.cortex
git add <project>/LEARNINGS.md global/LEARNINGS.md
git commit -m "<project>: consolidate learnings (N → M entries)"
git push 2>/dev/null || true
```

## Step 7: Report

```
/cortex-consolidate: ogrid

Before: 97 entries (since 2025-12-01)
After:  28 active entries
Archived: 97 entries in <details> block
Global promoted: 3 patterns

Patterns promoted to global:
  - Headless core + framework adapters (ogrid, m4l-builder, cortex)
  - FTS5 query sanitization: strip column filters before passing to MATCH
  - path.join + user input: always resolve and prefix-check against base

Committed: ogrid: consolidate learnings (97 → 28 entries)
```

## What not to do

- Don't delete entries: archive them in `<details>`
- Don't consolidate CLAUDE.md, summary.md, or backlog.md
- Don't invent patterns: if two entries use the same word but describe different problems, they're not a pattern
- Don't promote to global unless 3+ projects confirm it
- Don't touch entries already inside a `<details>` block
