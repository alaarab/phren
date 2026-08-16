# Phren Governance

> A local memory governance stack: RBAC, audit trail, trust decay, citation validation, and approval workflows.

## Why AI memory governance matters

Unmanaged AI memory degrades over time. A finding written in January about an API that no longer exists will still inject into context in July, confidently and wrongly. Without an audit trail, you cannot see what your AI knows, who taught it, or when. Without access control, any agent can overwrite shared memory. Without a human review interface, you cannot inspect what the AI will consume before it does.

These are not theoretical problems. They are operational realities for any team using AI memory at scale.

## What phren provides

### Git-backed audit trail

Every memory write is a git commit. You can:

```bash
# Who wrote this finding and when?
git log --oneline --follow ~/.phren/myproject/FINDINGS.md

# What changed in the last 30 days?
git diff HEAD~30 ~/.phren/myproject/FINDINGS.md

# Revert a bad batch import
git revert <commit-sha>

# Full history of a specific finding
git log -p -S "authentication" ~/.phren/myproject/FINDINGS.md
```

Managed API memory systems such as Mem0, Zep, and Supermemory expose different audit surfaces than a git-native history. Phren records memory changes as ordinary commits, which makes review, rollback, and inspection work through standard developer tools.

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

The threshold `minInjectConfidence=0.35` suppresses low-confidence findings from being injected into context automatically. They remain in storage. They just stop contaminating your AI's working knowledge.

Configure via `phren config policy`.

### Citation validation

Findings can cite the source file and line number that motivated them:

```
- [pattern] Use exponential backoff for all external API calls.
  <!-- phren:cite {"file":"src/api/client.ts","line":47} -->
```

When the cited file changes significantly or disappears, phren penalizes the finding's confidence. This creates a feedback loop: as code evolves, outdated findings naturally decay out of injection range without manual curation.

### Role-based access control

Three roles, enforced on mutating operations:

| Role | Add / edit findings, tasks, notes | Delete findings, tasks, notes | Change config |
|------|-----------------------------------|-------------------------------|---------------|
| `admin` | ✓ | ✓ | ✓ |
| `contributor` | ✓ | ✓ | — |
| `reader` | — | — | — |

Configure with `phren config access set --admins=… --contributors=… --readers=…`.
When every list is empty (the default), the store is in **open mode** and all
actions are permitted.

**Contributors can delete.** `remove_finding`, `remove_task` and `remove_note`
are all in the contributor action set, so granting contributor on a shared store
also grants permanent deletion of team knowledge. Only `manage_config` is
admin-only.

**Scope of enforcement.** Roles are checked in the MCP tool layer, which is how
agents reach the store. Reads are not gated — there is no read action — and the
actor is self-declared through the `PHREN_ACTOR` environment variable. Treat this
as a coordination boundary between cooperating teammates, not as a security
boundary against a motivated local user.

### The review queue: what approve and reject actually do

`review.md` is a quarantine, not a notification list. Two producers write to it:

- **Extraction.** Candidates mined from git history that score below `autoAcceptThreshold` (default 0.75, `PHREN_MEMORY_AUTO_ACCEPT`) are queued **instead of** being written to `FINDINGS.md`. The queue line is the only copy.
- **Governance.** `phren maintain govern` and TTL enforcement queue findings that already live in `FINDINGS.md` under `## Stale` and `## Conflicts`, asking you to confirm they are still true.

So a queue line can point at three different realities, and the verbs behave accordingly.

#### Approve

`approve` means "this belongs in memory". It makes that true, then removes the line:

| The item's content is… | What approve does | Reported outcome |
|---|---|---|
| not in `FINDINGS.md` | **writes it as a finding**, then dequeues | `promoted` |
| already a live finding | keeps it as-is, dequeues | `already_present` |
| only in `reference/topics/` (auto-archived) | leaves the archive untouched, dequeues | `already_archived` |

Promotion goes through the same code path as `add_finding`, so a promoted finding is indistinguishable from one you added by hand: it gets a `fid`, a `created` stamp, citation metadata, it participates in duplicate detection, and it counts against the findings cap (triggering auto-archive if the project is over it). The entry's type tag is preserved, its capture provenance (source commit, repo, session) is carried over from the queue line, and the date it was originally queued is recorded as `<!-- phren:queued "YYYY-MM-DD" -->` — the finding is written today, but you can still see when the observation was captured.

If the write fails — a secret detected in the text, a locked file — the queue line **stays**. Approve never destroys an item it could not promote.

#### Reject

`reject` means "this is wrong, get rid of it". It destroys the content wherever it actually lives, then removes the line:

| The item's content is… | What reject does | Reported outcome |
|---|---|---|
| a live finding | removes it from `FINDINGS.md` | `removed` |
| in `reference/topics/` (auto-archived) | removes it there too | `removed_from_archive` |
| nowhere — an extraction candidate that was never written | nothing to remove; dequeuing *is* the rejection | `discarded` |

Reject reaches into the archive tier on purpose. `autoArchiveToReference` moves findings out of `FINDINGS.md` into `reference/topics/*.md` once a project exceeds the findings cap, without reconciling the queue lines that point at them — and archived content is still retrieved and injected. A reject that left it in place would be a lie.

Three situations make reject **fail** rather than report success, leaving the queue line in place so you can act:

- the content sits in a `FINDINGS.md` archive block (`<!-- phren:archive:start -->` / `<details>`), which is read-only history everywhere else in phren;
- several *different* bullets match, so removing one would be a guess;
- the match is in a `reference/` file phren does not auto-manage (anything outside `reference/topics/`), which is yours to edit.

#### The queue is never injected

`review.md` is indexed — `search_knowledge` can find it, which is how you answer "why is this in my queue?" — but doc type `review-queue` is excluded from the automatic injection path. Unreviewed content does not reach an agent's prompt, and it is not subject to trust filtering there because it never gets there. `notes` is excluded the same way.

Both verbs write to the audit log (`review_approve` / `review_reject`, with the outcome), so the queue's history is inspectable like every other memory write.

### TTL and retention policy

- `ttlDays=120`: findings older than 120 days are flagged for review
- `retentionDays=365`: findings are retained for 365 days before eligible for permanent deletion

Configure via `phren config policy`.

### The phren shell: human review before agent consumption

`phren shell` is a model-free terminal interface for reviewing, approving, and cleaning memories before any agent consumes them. 8 views, 30+ commands, single-key navigation.

A human can inspect every finding, see its confidence score, view its git history, and delete or pin it, all without an AI in the loop. This is operationally essential at team scale: you do not want agents writing to shared memory without a human review step available.

## Comparison

| Feature | Phren | Mem0 | Zep | Copilot Memory |
|---------|--------|------|-----|----------------|
| Audit trail | Git commits (forever) | Service-specific logs/documentation | 7-day API logs ($475/mo) | Platform-managed history |
| Trust decay | Graduated curve | Not surfaced in reviewed materials | Temporal graph | 28-day hard delete |
| Citation validation | File:line + penalty | Not surfaced in reviewed materials | Not surfaced in reviewed materials | File:line, no penalty |
| RBAC | 4 roles, built-in | Enterprise only | Enterprise only | GitHub permissions |
| Approval workflows | Built-in | Not surfaced in reviewed materials | Not surfaced in reviewed materials | Not surfaced in reviewed materials |
| Human web UI | CLI shell (offline) | Cloud dashboard | Not surfaced in reviewed materials | Not surfaced in reviewed materials |
| Data location | Your git repo | Cloud or Docker | Cloud only | GitHub cloud |
| Cost for governance | $0 | $249+/mo | $475+/mo | Copilot subscription |

## Configuration reference

Every value is passed as `--key=value`. A bare positional (`set ttlDays 90`) is
rejected rather than silently applying nothing. Add `--project <name>` to any
`get`/`set` to read or write a per-project override instead of the global default.

```bash
# Policy (decay, TTL, retention)
phren config policy get
phren config policy set --ttlDays=90 --retentionDays=365 --minInjectConfidence=0.35
phren config policy set --project my-app --retentionDays=3650   # per-project override
phren config policy set --decay.d30=1 --decay.d60=0.85 --decay.d90=0.65

# Access control — roles are admins / contributors / readers
phren config access get
phren config access set --admins=alice --contributors=bob,carol --readers=dave

# Workflow (review-queue routing and capture behavior)
phren config workflow get
phren config workflow set --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts
phren config task-mode auto            # auto | manual
phren config finding-sensitivity balanced   # minimal | conservative | balanced | aggressive

# Index (what gets indexed) — note the flags are --include / --exclude
phren config index get
phren config index set --include="**/*.md" --exclude="**/node_modules/**"
phren config index set --includeHidden=false
```

## Running the governance checks

```bash
phren doctor          # shows semantic search status, index health, Ollama status
phren maintain govern # queue stale memories for review
phren maintain prune  # delete expired entries
phren shell           # interactive review interface
```

Working the review queue:

```bash
phren review                          # show the queue
phren review approve <project> <text> # promote (or keep) the item, then dequeue
phren review reject  <project> <text> # delete the content wherever it lives, then dequeue
```
