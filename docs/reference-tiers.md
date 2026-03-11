# Reference Tiers

cortex organizes reference material into three tiers, each suited for different kinds of information.

## Findings (default tier)

**Location:** `<project>/FINDINGS.md`

Patterns, pitfalls, decisions with reasoning, and things that save time next session. Written as bullet points grouped by date. These are the most dynamic entries: they accumulate during work, get consolidated periodically, and decay over time based on confidence scoring.

When to use: an insight you just discovered, a bug workaround, a convention that is not obvious from reading the code.

## Reference (deep reference tier)

**Location:** `<project>/reference/`

Long-form reference docs: API specs, architecture decisions, data model documentation, integration guides. Files in this subdirectory are indexed separately with type `reference` in FTS5. They do not decay or get consolidated like findings.

When to use: documentation too long or structured for a bullet point in FINDINGS.md. Reference material the agent should find when searching for specific technical details.

### Project-owned topic archives

Auto-archived findings now live under `reference/topics/<slug>.md` instead of being mixed into the root of `reference/`. These topic docs are machine-managed buckets for archived findings, while the rest of `reference/` remains available for hand-written docs.

- `topic-config.json` at the project root defines the topic list for that project.
- If `topic-config.json` does not exist yet, cortex falls back to built-in starter topics.
- `general` is the required fallback topic and cannot be removed.
- Each topic doc includes a small `cortex:auto-topic` marker so the UI can distinguish managed archive buckets from hand-written reference docs.

Example `topic-config.json`:

```json
{
  "version": 1,
  "topics": [
    {
      "slug": "rendering",
      "label": "Rendering",
      "description": "Graphics, shaders, frame pacing, and visual systems.",
      "keywords": ["shader", "frame", "render", "materials"]
    },
    {
      "slug": "general",
      "label": "General",
      "description": "Fallback bucket for uncategorized findings.",
      "keywords": []
    }
  ]
}
```

Search still treats these topic docs as normal reference material, so moving machine-managed archives into `reference/topics/` does not remove them from lexical lookup.

## Global (cross-project tier)

**Location:** `~/.cortex/global/`

Patterns that apply across all projects: conventions, workflow preferences, tool configuration, shared skills. Global findings are indexed and searchable from any project context.

When to use: a pattern confirmed in 2+ projects (the `cortex-consolidate` skill promotes these automatically), personal workflow preferences, or shared skills.

## How search works across tiers

FTS5 search traverses all three tiers by default. Filter to a specific tier:

```bash
cortex search "api auth" --type reference    # reference tier only
cortex search "rate limit" --project my-app  # one project's findings + reference
```

In MCP, use the `type` parameter on `search_knowledge`:

```
search_knowledge(query: "api auth", type: "reference")
```

## Decision guide

| Question | Tier |
|----------|------|
| Did I just discover this? Will it fit in one bullet? | Findings |
| Is this a reference doc I will look up repeatedly? | Reference |
| Does this pattern apply to 2+ projects? | Global |
