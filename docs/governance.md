# Cortex Governance

> The complete memory governance stack — RBAC, audit trail, trust decay, citation validation, approval workflows — fully local, zero vendor cost.

## Why AI memory governance matters

Unmanaged AI memory degrades over time. A finding written in January about an API that no longer exists will still inject into context in July — confidently and wrongly. Without an audit trail, you cannot see what your AI knows, who taught it, or when. Without access control, any agent can overwrite shared memory. Without a human review interface, you cannot inspect what the AI will consume before it does.

These are not theoretical problems. They are operational realities for any team using AI memory at scale.

## What cortex provides

### Git-backed audit trail

Every memory write is a git commit. You can:

```bash
# Who wrote this finding and when?
git log --oneline --follow ~/.cortex/myproject/FINDINGS.md

# What changed in the last 30 days?
git diff HEAD~30 ~/.cortex/myproject/FINDINGS.md

# Revert a bad batch import
git revert <commit-sha>

# Full history of a specific finding
git log -p -S "authentication" ~/.cortex/myproject/FINDINGS.md
```

Managed API memory systems (Mem0, Zep, Supermemory) have no equivalent. Zep logs API calls for 7 days on their $475/month tier. Cortex logs every write forever, in a format every developer already knows.

### Trust decay and confidence scoring

Each finding has a confidence score that decays over time:

| Age | Confidence multiplier |
|-----|----------------------|
| 0–30 days | 1.0 (full confidence) |
| 30–60 days | 0.9 |
| 60–90 days | 0.75 |
| 90–120 days | 0.5 |
| 120+ days | below 0.35 → suppressed |

A finding with no source file citation gets an additional 0.8× penalty. Findings whose cited `file:line` no longer exists in the codebase are penalized further.

The threshold `minInjectConfidence=0.35` suppresses low-confidence findings from being injected into context automatically. They remain in storage — they just stop contaminating your AI's working knowledge.

Configure via `cortex config policy`.

### Citation validation

Findings can cite the source file and line number that motivated them:

```
- [pattern] Use exponential backoff for all external API calls.
  <!-- cortex:cite {"file":"src/api/client.ts","line":47} -->
```

When the cited file changes significantly or disappears, cortex penalizes the finding's confidence. This creates a feedback loop: as code evolves, outdated findings naturally decay out of injection range without manual curation.

### Role-based access control

Four roles with six action types:

| Role | Read | Write | Delete | Approve | Admin | Export |
|------|------|-------|--------|---------|-------|--------|
| admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| maintainer | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| contributor | ✓ | ✓ | — | — | — | — |
| viewer | ✓ | — | — | — | — | — |

Configure with `cortex config access`.

### Approval workflows

High-risk operations (bulk delete, policy changes, imports from untrusted sources) can require human approval before executing. Configure thresholds via `cortex config workflow`.

### TTL and retention policy

- `ttlDays=120`: findings older than 120 days are flagged for review
- `retentionDays=365`: findings are retained for 365 days before eligible for permanent deletion

Configure via `cortex config policy`.

### The cortex shell: human review before agent consumption

`cortex shell` is a model-free terminal interface for reviewing, approving, and cleaning memories before any agent consumes them. 8 views, 30+ commands, single-key navigation.

A human can inspect every finding, see its confidence score, view its git history, and delete or pin it — all without an AI in the loop. This is operationally essential at team scale: you do not want agents writing to shared memory without a human review step available.

## Comparison

| Feature | Cortex | Mem0 | Zep | Copilot Memory |
|---------|--------|------|-----|----------------|
| Audit trail | Git commits (forever) | None | 7-day API logs ($475/mo) | None |
| Trust decay | Graduated curve | None | Temporal graph | 28-day hard delete |
| Citation validation | File:line + penalty | None | None | File:line, no penalty |
| RBAC | 4 roles, built-in | Enterprise only | Enterprise only | GitHub permissions |
| Approval workflows | Built-in | None | None | None |
| Human review UI | CLI shell (offline) | Cloud dashboard | None | None |
| Data location | Your git repo | Cloud or Docker | Cloud only | GitHub cloud |
| Cost for governance | $0 | $249+/mo | $475+/mo | Copilot subscription |

## Configuration reference

```bash
# Policy (decay, TTL, retention)
cortex config policy get
cortex config policy set ttlDays 90
cortex config policy set retentionDays 365
cortex config policy set minInjectConfidence 0.35

# Access control
cortex config access get
cortex config access set role contributor

# Workflow (approval gates)
cortex config workflow get
cortex config workflow set requireApproval true

# Index (what gets indexed)
cortex config index get
cortex config index set includeGlobs "**/*.md"
```

## Running the governance checks

```bash
cortex doctor          # shows semantic search status, index health, Ollama status
cortex maintain govern # queue stale memories for review
cortex maintain prune  # delete expired entries
cortex shell           # interactive review interface
```
