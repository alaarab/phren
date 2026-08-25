# The phren store format

A phren store is a git repository of markdown. This document specifies that
markdown, because it is a **contract** — the CLI writes it, the iOS app writes
it, and anything else that wants to participate has to agree with both.

Until the iOS app was built, one TypeScript codebase both wrote and read the
store, so the format could be whatever the code happened to do. A second
implementation makes the disagreements visible. This spec exists so a third
implementation does not have to rediscover them by reading regexes.

> **Status.** This describes the format as implemented today, including its
> known rough edges, which are marked ⚠️. Where the code disagrees with itself,
> that is stated rather than smoothed over.

---

## 1. Layout

```
<store>/
  phren.root.yaml          # store manifest — version, installMode, syncMode
  stores.yaml              # optional: registry of additional stores
  machines.yaml            # optional: machine-name -> profile-name
  profiles/<name>.yaml     # which projects a machine loads
  <project>/
    FINDINGS.md            # durable knowledge — the product
    tasks.md               # checkboxes, three sections
    review.md              # queue awaiting human judgement
    truths.md              # pinned entries that never decay
    summary.md             # human-written project overview
    CLAUDE.md              # agent-facing project instructions
    notes/YYYY-MM-DD.md    # dated scratch, never injected
    reference/topics/*.md  # archived findings, by topic
    journal/*.md           # team-store append-only finding ingest
    skills/*.md            # slash commands
  global/                  # cross-project knowledge; same shape as a project
```

Reserved top-level directory names that are **not** projects: `global`,
`profiles`, `scripts`, `templates`, and anything ending `.archived`.

---

## 2. Universal rules

These apply to every file below. They are the rules most likely to be violated
by a well-intentioned reimplementation.

### 2.1 Unknown metadata comments MUST be preserved verbatim

This is the single most important rule in the format.

Entries carry metadata in HTML comments (§3). A writer that does not recognise
a comment **must carry it through unchanged**. Do not parse an entry into a
typed record and re-serialise from only the fields you know — that silently
destroys data written by a newer version or a different implementation.

Both current implementations satisfy this by doing *surgical string editing*:
locate the line, splice the changed part, reattach every comment found on it.
Neither round-trips through a typed model. A structurally "cleaner"
reimplementation that does round-trip is a data-loss bug by construction.

### 2.2 String semantics are JavaScript's

Lengths and slice offsets are counted in **UTF-16 code units**, not Unicode
scalars and not grapheme clusters, because the reference implementation is
JavaScript. This matters wherever text is truncated (§4.3) — an emoji shifts
the boundary, and getting it wrong produces a different string.

The Swift port carries a `JSRegex` shim and explicit `.utf16` counting for this
reason. ⚠️ This is a smell: the grammar is partly defined by V8's behaviour
rather than by anything written down.

### 2.3 Whitespace normalisation is opportunistic, not invariant

Mutation functions collapse 3+ newlines to 2 and end the file with exactly one
newline. This happens as a side effect of a function touching a byte range —
it is **not** enforced end-to-end. Real stores accumulate long runs of blank
lines from concurrent git merges that nothing repairs.

Do not assume a file you read is normalised. Do not assert it in tests against
real data.

### 2.4 Dates

`YYYY-MM-DD`, local time, no timezone suffix. Date headings are `## YYYY-MM-DD`.

---

## 3. Metadata comments

Metadata rides in HTML comments at the end of an entry's line, so the file
stays readable and hand-editable.

| Comment | Meaning |
|---|---|
| `<!-- fid:abcd1234 -->` | Stable finding id, 8 lowercase hex chars |
| `<!-- created: YYYY-MM-DD -->` | Creation date, distinct from the date heading |
| `<!-- phren:status "active" -->` | Lifecycle state — one of `active`, `superseded`, `contradicted`, `stale`, `invalid_citation`, `retracted` |
| `<!-- phren:status_updated "YYYY-MM-DD" -->` | When the status last changed |
| `<!-- phren:status_reason "..." -->` | Why |
| `<!-- phren:status_ref "..." -->` | What it points at |
| `<!-- phren:supersedes "..." -->` | This entry replaces another, referenced by text snippet ⚠️ |
| `<!-- phren:superseded_by "..." [date] -->` | Inverse of the above |
| `<!-- phren:contradicts "..." -->` | Conflicts with another entry, by text snippet ⚠️ |
| `<!-- phren:cite {json} -->` | Provenance: commit, file, line, timestamps |
| `<!-- phren:archive:start -->` / `:end` | Legacy archive block delimiters (§5.2) |
| `<!-- source: ... -->` | Capture origin |

Legacy forms still **read** but no longer written: `<!-- superseded_by: "..." -->`,
`<!-- conflicts_with: "..." -->`.

⚠️ **`supersedes` and `contradicts` reference entries by a 60-character text
snippet, not by `fid`.** Resolution is a normalised prefix match. Editing the
referenced entry's opening words breaks the link silently. `fid` exists and
should be used instead; this is the format's most obvious unfinished migration.

### 3.1 Task metadata

Tasks use a single combined comment rather than several:

```
<!-- bid:abcd1234 rank:7 lastActivity:2026-08-01 created:2026-07-30
     session:abc scope:shared findings:abcd1234 parentFinding:... speculative -->
```

`bid` is the stable task id. All other fields are optional and order-sensitive
in the current regex.

---

## 4. File formats

### 4.1 `FINDINGS.md`

```markdown
# <project> Findings

## 2026-08-01

- [pattern] Findings are one line each. <!-- fid:1a2b3c4d --> <!-- created: 2026-08-01 -->
- Untagged findings are legal and common.
```

- Title line, then date headings newest-first, then `- ` bullets.
- An optional `[type]` prefix tags the finding. See §6 for the vocabulary
  problem.
- One finding is one bullet. Continuation lines are not part of the format.

### 4.2 `tasks.md`

```markdown
# <project> tasks

## Active
- [ ] In progress right now <!-- bid:11112222 rank:1 -->

## Queue
- [ ] Not started [high] <!-- bid:33334444 rank:2 -->

## Done
- [x] Finished <!-- bid:55556666 -->
```

Exactly three sections in this order: `Active`, `Queue`, `Done`. New tasks are
appended to **Queue**. Completion moves the item to the top of `Done` and sets
`[x]`.

⚠️ **Priority and pinned state have two sources of truth.** `[high]`/`[medium]`/
`[low]` and `[pinned]` live as substrings *in the task text* and also as parsed
fields. `updateTask` with new text recomputes both fields from that text — so a
caller that renames a task without re-supplying them silently drops them. A
previous incarnation of this bug appended a duplicate tag on every update
(observed: 48 × `[high]` on one task), which is why the current stripper loops
to a fixed point. Prefer moving these into the `bid` comment.

### 4.3 `review.md`

```markdown
# <project> review queue

## Review
- [2026-08-01] [bug] Candidate awaiting judgement

## Stale
## Conflicts
```

Three sections: `Review`, `Stale`, `Conflicts`. Entries are date-prefixed
bullets.

⚠️ **Entries have no stable id.** They are located by exact line-text equality.
Editing an entry invalidates any cached reference to it, and two clients acting
on the same entry desync silently. Every other file type has stable ids; this
one should too.

⚠️ **Entries are truncated to 500 UTF-16 units at write time**, with `…`
appended, and the original is not stored anywhere. Truncation is the *default*,
not opt-in. A reader must reproduce the exact boundary or its text differs
permanently. This is a display decision leaking into persistence.

### 4.4 `notes/YYYY-MM-DD.md`

Dated bullets with `<!-- nid:... -->` stable ids. Notes are indexed and
searchable but **never** injected into agent prompts — that exclusion is the
entire reason the type exists.

### 4.5 `truths.md`

Pinned entries that do not decay. Same bullet shape as findings.

### 4.6 `reference/topics/<slug>.md`

Archived findings, moved here from `FINDINGS.md` by consolidation when a
project exceeds its findings cap. **Byte-for-byte the same entry format** —
these are not a different kind of knowledge, they are findings that aged out of
the active window.

The move stamps `<!-- consolidated: YYYY-MM-DD -->` into the source
`FINDINGS.md`.

---

## 5. Archive semantics

### 5.1 Current: move to `reference/topics/`

Consolidation deletes bullets from `FINDINGS.md` and appends them to a topic
file. The entries remain live for retrieval; they are simply no longer in the
active window.

### 5.2 Legacy: `<details>` blocks

`<details>` / `<!-- phren:archive:start -->` blocks inside `FINDINGS.md` are
recognised by both readers and **written by neither**. Parsers must continue to
read them; nothing should emit them.

⚠️ Dead-write, live-read surface: the least-exercised part of the parser,
because the fixture generator only runs current code paths.

---

## 6. Finding types

⚠️ **Three disjoint vocabularies exist.** This is the format's clearest
inconsistency:

| Source | Set |
|---|---|
| Offered to users (`FINDING_TYPES`) | decision, pitfall, pattern, tradeoff, architecture, bug |
| Given decay behaviour (`FINDING_TYPE_DECAY`) | pattern, decision, pitfall, anti-pattern, observation, workaround, tooling, context, bug |
| Written by auto-detection | decision, bug, workaround, pattern, pitfall, context |

Consequences: `[tradeoff]` and `[architecture]` are offered everywhere and have
no decay rule; `[workaround]` and `[context]` are written by phren itself and
cannot be filtered for. The intersection — **decision, pattern, pitfall, bug** —
is the only set that behaves consistently.

Readers should accept **any** `[a-z][a-z0-9_-]*` tag and not assume the offered
set.

---

## 7. Conformance

A second implementation is correct when:

1. Parsing a CLI-written file yields the same logical entries.
2. Mutating it produces **byte-identical** output to what the CLI would produce.
3. Unknown metadata comments survive a full read-modify-write cycle (§2.1).
4. Truncation boundaries match under UTF-16 counting (§2.2).

Fixtures generated by the real CLI live in
`apps/ios/PhrenKit/Tests/PhrenKitTests/Fixtures/`, produced by
`apps/ios/scripts/generate-fixtures.mjs`.

The five rough edges above each have a dedicated fixture pair asserted from
**both sides** — `FormatGapsTests.swift` and
`packages/cli/src/__tests__/conformance-format-gaps.test.ts` read the same
committed bytes:

- a file containing an unrecognised metadata comment (§2.1)
- a legacy `<details>` block (§5.2)
- a `[bracket]` that is not a recognised type tag (§6)
- a pinned/prioritised task edited by text only (§4.2)
- text long enough and Unicode-rich enough to hit the 500- and 60-character
  boundaries (§2.2, §4.3)

Conformance testing is **bidirectional**: the Swift port reads what TypeScript
writes (the fixture suites above), and TypeScript reads what Swift writes —
`SwiftWritesFixtures.swift` commits PhrenKit-mutated files to
`Fixtures/swift-writes/` (regenerate with `PHREN_REGENERATE_SWIFT_FIXTURES=1`),
and `conformance-swift-writes.test.ts` parses those exact bytes with the CLI's
own readers.

`generate-fixtures.mjs` is deterministic: it patches `crypto.randomBytes` and
freezes `Date` before importing the CLI's dist, so the same inputs produce the
same bytes.

⚠️ Fixture **regeneration is still not a CI gate**: fixtures are committed, so
if the CLI's writer format changes and nobody reruns `generate-fixtures.mjs`,
both suites keep passing against stale bytes. Until a regenerate-and-diff job
exists, treat any CLI change under `content/`, `data/`, `finding/`, `core/`,
or `task/` as a prompt to regenerate.

---

## 8. Versioning

⚠️ None of the markdown file types carry a version marker, even though every
governance JSON config does. With two independent writers, a reader cannot
detect "written by a grammar I do not fully know" and will silently mis-parse
instead. A low-ceremony `<!-- phren:v 2 -->` on the title line, bumped only on
grammar-breaking changes, would close this.
