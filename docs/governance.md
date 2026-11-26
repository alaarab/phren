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

Each finding has a confidence score that falls with age, linearly between these points (`content/citation.ts`):

| Age | Confidence |
|-----|------------|
| 0–30 days | 1.0 |
| 60 days | 0.85 |
| 90 days | 0.65 |
| 120 days and older | 0.45 |

A finding with no date counts as 0.45. Past its age limit a finding is stale and is not injected. The limit is set by its tag, or by the retention policy's `ttlDays` (default 120) when it has none:

| Tag | Age limit | Extra multiplier |
|-----|-----------|------------------|
| `[decision]` | never | 1.0, and never below 0.6 |
| `[pattern]`, `[pitfall]` | 365 days | 1.0 |
| `[workaround]` | 60 days | 0.85 |
| `[bug]` | 30 days | 0.8 |
| `[context]` | 30 days | 0.75 |
| no tag | `ttlDays` | 1.0 |

A finding whose citation names no repo, file or symbol gets a further 0.8×: one with no citation, or with only the `created_at` time every new finding gets. A cited line that drifted, or a cited file changed since the finding was written, gives 0.7×, and a citation that no longer resolves drops the finding.

The threshold `minInjectConfidence=0.35` suppresses low-confidence findings from being injected into context automatically. They remain in storage. They just stop contaminating your AI's working knowledge.

Configure via `phren config policy`.

### Feedback and retrieval ranking

Only explicit feedback changes the feedback multiplier used in retrieval ranking: `memory_feedback` (also `revise_finding action=feedback`), CLI `quality-feedback`, and a CI failure tied to a finding. Helpful feedback adds 0.15, reprompt feedback subtracts 0.2, and regression feedback subtracts 0.4, starting at 1 and clamped to 0.2–1.5. Without explicit feedback the multiplier is 1, including for older score records.

Impressions, usage timestamps, and heuristic helpful or reprompt counts are still recorded for diagnostics and other features. They do not boost or penalize this multiplier. Trust decay and citation confidence checks still apply separately.

### Citation validation

Findings can cite the source file and line number that motivated them:

```
- [pattern] Use exponential backoff for all external API calls.
  <!-- phren:cite {"file":"src/api/client.ts","line":47} -->
```

When the cited file changes significantly or disappears, phren penalizes the finding's confidence. This creates a feedback loop: as code evolves, outdated findings naturally decay out of injection range without manual curation.

Each computer checks a citation against its own disk and gets one of four states. **Valid**: everything named checks out. **Drifted**: the cited line changed since the cited commit, or is past the end of the file; the finding may still be right, so its confidence drops by 0.7×, like a cited file that changed since the finding was written. **Broken**: the repo is on this computer but the cited file is gone; the finding is not injected. **Unverifiable**: the citation names no repo or file, the repo is not on this computer, git could not run, or the repo does not know the cited commit while the file is still there (a squash-merged or unfetched commit); nothing changes. Daily governance records the states it checks, for `FINDINGS.md`, topic files and `.older.md` splits, in the machine-local `.runtime/citation-states.json` (at most 300 git calls per run; the rest wait for the next run), and only the store's maintenance lease holder files broken citations under `## Conflicts`.

New citations name their repo by its `origin` remote (`github.com/owner/repo`) with a repo-relative file, so a finding written on one computer checks on any other with a clone of that repo ([store-format.md](store-format.md#3-metadata-comments)). Phren finds the clone the way the code index finds a project's checkout: the project's registered folder for this computer (or the repository it is inside, for a monorepo package), then a folder named after the repo or the project under `$PROJECTS_DIR`, `~`, `~/Projects` and the other usual roots, and uses it only when its `origin` is the same remote. A clone other than the one the citation was written in may be behind, ahead or on another branch, so it says something about a cited file only when the cited commit is in the history it has checked out: then a changed line is drifted and a file that was in the commit and is gone is broken. Anything else is unverifiable, and the answer is asked again after the clone moves to another commit. The daily check also tries an older citation's absolute repo path from another computer (a `/Users/...` path on Linux) against a same-named checkout here, and uses that checkout only when it has the cited commit. A remote this computer has no clone of stays unverifiable.

Finding a clone scans folders and may start git, and so does checking a repo path, so only the daily check does either. The prompt hook and `search_knowledge` check no citation themselves: every citation, whether it names a remote or a repo path, takes the state the daily check last recorded on this computer, and one not checked yet changes nothing. They start no git process.

Daily store health (`.runtime/store-health.jsonl`) reports citation coverage: per project the active findings whose citation this computer last checked to valid, drifted or broken, how many of those name a file, and per store the share of active findings that is.

### Role-based access control

Three roles, enforced on mutating operations:

| Role | Add / edit findings, tasks, notes | Delete findings, tasks, notes | Change config |
|------|-----------------------------------|-------------------------------|---------------|
| `admin` | ✓ | ✓ | ✓ |
| `contributor` | ✓ | ✓ | — |
| `reader` | — | — | — |

Configure with `phren config access set --admins=… --contributors=… --readers=…`.
When every list is empty (the default), the store is in open mode and every
action is permitted.

Contributors can delete: `remove_finding`, `remove_task` and `remove_note` are
contributor actions, so granting contributor on a shared store also grants
permanent deletion. Only config changes are admin-only.

Roles are checked in the MCP tool layer, which is how agents reach the store.
Reads are not gated, and the actor is self-declared through the `PHREN_ACTOR`
environment variable. Treat this as a coordination boundary between cooperating
teammates, not a security boundary against a local user.

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

- `ttlDays=120`: untyped findings older than 120 days are flagged for review. A finding tagged with a type lives as long as its type allows instead (`[bug]` and `[context]` 30 days, `[workaround]` 60, `[pattern]` and `[pitfall]` 365, `[decision]` with no limit), whatever `ttlDays` is set to. Injection and the nightly TTL review use the same limit.
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
| RBAC | 3 roles, built-in | Enterprise only | Enterprise only | GitHub permissions |
| Human review queue | Built-in | Not surfaced in reviewed materials | Not surfaced in reviewed materials | Not surfaced in reviewed materials |
| Human web UI | CLI shell (offline) | Cloud dashboard | Not surfaced in reviewed materials | Not surfaced in reviewed materials |
| Data location | Your git repo | Cloud or Docker | Cloud only | GitHub cloud |
| Cost for governance | $0 | $249+/mo | $475+/mo | Copilot subscription |

## Configuration reference

Every `set` value is passed as `--key=value`. Anything else (`set ttlDays 90`,
`set --ttlDays 90`) is rejected with exit 1 and nothing is written. Add
`--project <name>` to a `get` or `set` to read or write one project's override.

```bash
# Policy (decay, TTL, retention)
phren config policy get
phren config policy set --ttlDays=90 --retentionDays=365 --minInjectConfidence=0.35
phren config policy set --project my-app --retentionDays=3650   # per-project override
phren config policy set --decay.d30=1 --decay.d60=0.85 --decay.d90=0.65

# Access control: admins, contributors, readers
phren config access get
phren config access set --admins=alice --contributors=bob,carol --readers=dave

# Workflow (review-queue routing)
phren config workflow get
phren config workflow set --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts

# Index (what gets indexed)
phren config index get
phren config index set --include="**/*.md" --exclude="**/node_modules/**"
```

Include globs are matched inside each project folder. A pattern that is
absolute, or holds `..` or a backslash, is refused, and one already stored is
ignored.

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

## Summaries and the weight of the store

Findings age out of `FINDINGS.md` into `reference/topics/<topic>.md`, and a store a year old carries hundreds of thousands of words there, reachable only by keyword. `phren maintain summarize [project] [--llm] [--force]` writes a `## Now` block at the top of each topic file — structural by default (how many findings, which tags, what keeps being mentioned, the newest headlines) or a prose paragraph when an LLM is configured and `--llm` is passed — and a `What phren knows` block at the end of `summary.md`. A model's paragraph is kept only if every identifier it names appears in the findings; a small local model will otherwise invent the stack, and a summary that adds facts is worse than none, so such a paragraph is dropped for the structural one. Hand-written documents that live under `reference/topics/` (no archived bullets) get no block. Most people run phren inside an agent that already is a capable model: the `/phren-summarize` skill has that agent write the paragraphs through `get_topic_summaries` and `set_topic_summary`, under the same identifier check, with no API key or local model involved. The prompt hook injects that block once per session for the project at hand, before any individual bullets. Both blocks live between markers and are replaced, never accumulated; the archive's own bullets are not rewritten. A topic file past 400 bullets is split, oldest sections first, into `<topic>.older.md`, which stays indexed.

Daily background maintenance (scheduled by the stop hook) covers the primary store and writable attached team stores. It queues stale, conflicting and low-value findings in each project's own `review.md`, consolidates findings, prunes dead memories using that store's retention policy, refreshes structural topic summaries, and moves done tasks past thirty into that store's `.config/task-archive/<project>.md`. The primary's profile filters only primary projects; attached stores use their own project subscriptions.

Background maintenance also prunes local session files in the primary store's `.sessions/` and logs in `.runtime/` older than 30 days (never the mirrored agent conversations in `.runtime/sessions/`), at most once every 24 hours. It preserves audit and telemetry files, directories and symlinks. Pruning failures are logged and do not stop other maintenance. `phren maintain gc [--dry-run]` runs Git garbage collection and the same pruning by hand, preserving commit history. Background pruning does not run Git garbage collection.

Each store has its own `.config/maintenance-writer.json` lease. The holder renews daily; another computer can take over after three days without renewal. An attached store is maintained only by its lease holder, including journal compaction, review queues and consolidation. A primary-store lease grants no authority over an attached store. Read-only, missing and non-Git attachments are skipped with a debug message. Primary-store behavior stays the same: only its lease holder tidies tasks, summarizes and prunes; other computers still fold their local finding journals in and run governance. Maintenance markers and runtime health stay in the primary store. Tasks are injected into prompts only when the prompt is about building or asks about the work itself.

`phren status` prints the store's weight by kind, and `phren doctor`'s `context-cost` check warns when the global AGENTS.md passes 600 words, the MCP profile is `full`, or the median hook injection passes 1,500 tokens.

