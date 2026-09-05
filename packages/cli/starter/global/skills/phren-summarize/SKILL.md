---
name: phren-summarize
description: Write the "what we know" paragraph for each topic archive yourself, from the bullets phren hands you, using the model you are already running as. No API key, no local model.
---
# /phren-summarize

Findings age out of `FINDINGS.md` into `reference/topics/<topic>.md`, hundreds of bullets per topic. phren keeps a `## Now` block at the top of each file saying what the topic amounts to, and a `What phren knows` block in `summary.md` that the prompt hook injects once per session. phren can write those structurally (counts, tags, newest headlines). This skill has *you* write the prose version, with the model you are already running as.

## What to do

1. Pick the scope: one project (`/phren-summarize <project>`), or every project in this machine's profile (`phren_admin(action: "list_projects")`).
2. For each project, `phren_admin(action: "get_topic_summaries", project)`. You get every topic archive with its bullet count, the current `## Now` text, and whether it is structural or already prose.
3. For each topic that is structural (or `--force`), `phren_admin(action: "get_topic_summaries", project, topic, bullets: 60)` returns the newest sixty bullets. Read them. Write **one paragraph of four to six plain sentences** saying what is currently known: standing decisions, pitfalls that still apply, patterns in use.
   - Use only facts stated in the bullets. Do not name a language, library, file or component unless a bullet names it, spelled as the bullet spells it. If the bullets do not support a sentence, leave it out.
   - No preamble, no bullet points, no headings. Concrete beats general.
4. `phren_admin(action: "set_topic_summary", project, topic, text)`. phren checks every identifier in your paragraph against the bullets and refuses one that names something they do not; fix the paragraph rather than arguing with the check. On success phren also refreshes the project's `What phren knows` block.
5. Report per project: topics written, topics skipped (already prose or empty), any refusals and what you changed.

## Notes

- Topics with no archived bullets are hand-written reference docs. Leave them alone; phren skips them too.
- This is idempotent: a topic keeps your paragraph until its bullets change (phren fingerprints the file), then falls back to structural until you run this again.
- Machines with a GPU and a local model can do the same unattended with `phren maintain summarize --llm`; the same identifier check applies.
