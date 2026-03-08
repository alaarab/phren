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

## Global (cross-project tier)

**Location:** `~/.cortex/global/`

Patterns that apply across all projects: coding conventions, workflow preferences, tool configuration, shared skills. Global findings are indexed and searchable from any project context.

When to use: a pattern confirmed in 3+ projects (the `/cortex-consolidate` skill promotes these automatically), personal workflow preferences, or shared skills.

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
| Does this pattern apply to 3+ projects? | Global |
