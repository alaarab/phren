# Dreaming

Dreaming is an offline pass that reorganizes one project's memory between sessions. It reads what actually happened in recent agent sessions, checks the project's findings and truths against that evidence, and proposes (or applies) a small set of changes: correct a wrong note, merge duplicates, save a decision nobody wrote down, move a subject onto its own page, and keep the always-injected layer small.

It is off by default. Turn it on per store or per project with `phren config`.

## Why

Phren's memory grows one finding at a time, written mid-task by whichever agent was working. Over weeks that produces notes that were true once, the same lesson saved twice, and decisions that were made in conversation but never recorded. Dreaming follows the lessons in Anthropic's [components of agent memory](https://www.anthropic.com/research/components-of-agent-memory):

- **Read transcripts, not only saved memory.** The transcripts are what happened; findings are what someone thought worth writing down at the time.
- **Correct wrong notes against evidence.** Every change that asserts something cites a transcript turn, a file and line, a commit, or another finding. Changes without evidence are dropped.
- **Keep the injected layer small.** Truths and the "What phren knows" block go into every session, so an error there spreads everywhere. Dreaming keeps that layer under a byte budget and demotes the truths least recently cited first.
- **One page per subject beats big shared files.** Dreaming can write `reference/pages/<slug>.md`, one subject per page, linked to each other.
- **Describe the purpose, not a procedure.** The prompt explains what memory is for and lets the model judge what is worth keeping. Rules like "record only failures" make memory worse.
- **Store what the environment can't show.** The reasons behind a decision, a pitfall's cause, a constraint from outside the repo. Not state an agent can read off the screen or the file tree, which goes stale.
- **Budget the pass.** A dream reads a capped amount of transcript text and makes at most `maxChanges` changes.

## Configuration

Dreaming is the `dreaming` config domain. Set it for the whole store or override it for one project, the same way as the other domains:

```bash
phren config dreaming set --enabled=true                  # store-wide
phren config dreaming set --project my-app --mode=apply   # one project
phren config dreaming get
```

The MCP `get_config` / `set_config` actions take `domain: "dreaming"`.

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Dreams run on their cadence only when this is on. A manual `phren dream run --force` runs regardless. |
| `mode` | `propose` | `propose` queues additions for review and stores other indexed proposals in the run record; `apply` applies changes and logs them. |
| `cadence` | `nightly` | `nightly`, `idle`, `weekly` or `manual`. See below. |
| `window` | `"02:00-05:00"` | Local time range that nightly and weekly dreams may start in. |
| `idleMinutes` | `45` | For the `idle` cadence: start after this many minutes with no live agent session in the project. |
| `lookbackHours` | `24` | How far back to read transcripts. A dream reads from the last run's marker when there is one, otherwise this many hours. |
| `maxChanges` | `25` | The most changes one dream may make. Extra changes are dropped and recorded. |
| `injectBudgetKB` | `8` | Cap on truths plus always-injected context, in KB. The dream demotes truths to stay under it and refuses a promotion that would go over without a matching demotion. |
| `phases` | `["capture","correct","organize","prune"]` | Which kinds of work the dream may do. Unknown values are ignored. |
| `model` | `""` | Model for the dream. Empty uses the project's helper model. |

The phases:

- **capture**: save decisions, pitfalls and patterns that the transcripts show and memory lacks.
- **correct**: supersede, edit or retract findings the evidence contradicts.
- **organize**: merge duplicates, move findings to the right topic, write pages, link findings to fragments.
- **prune**: demote truths to stay under the injected budget and retire notes that no longer help.

## Cadences

When the Phren Hook is running, a dreaming check runs every 10 minutes and looks at each project with dreaming enabled. It runs one dream at a time, at low priority, and never while an agent is working in that project.

- `nightly`: once a day, starting inside `window`.
- `weekly`: once a week, starting inside `window`.
- `idle`: once the project has had no live agent session for `idleMinutes`.
- `manual`: never on its own; only `phren dream run`.

The Hook uses effective session status, including unanswered prompts, held asks, background work and running children. Unknown status prevents a dream.

The time of the last run is kept in `dreams/last-run.json`. Without the Hook, dreams only run when you start them.

## Running and checking

```bash
phren dream run --project my-app              # uses the configured mode
phren dream run --project my-app --dry-run    # show the changeset, change nothing
phren dream run --project my-app --propose    # or --apply, overriding the config
phren dream run --project my-app --force      # run even though dreaming is disabled
phren dream status --project my-app --limit 20 # timing, last outcome and proposal acceptance
phren dream log --project my-app --limit 20   # the journal
```

The same are available to agents as the `phren_admin` actions `dream_run`, `dream_apply`, `dream_status` and `dream_log`.

Only one dream runs per project at a time. When a scheduled run returns `busy` because the project lock is held, the Hook retries on its next eligible tick.

All prompt inputs (including memory, page summaries, journal and commit subjects) are redacted with the shared secret scanner before interpolation, and the completed prompt is scanned before invoking the helper. Notes, diagnostics and rejection reasons are sanitized before persistence or return.

OpenCode plugin transcripts use session directory metadata when available. Sessions without a resolvable directory are skipped and reported; the transcript watermark is held back so they can be collected later. The last-run marker has one writer inside the engine's project lock, including its completion time (`at`) and manual/scheduled trigger.

## Stale tasks and the weekly task audit

Before it collects anything, a scheduled dream returns the project's stale
Active tasks (untouched for 24 hours) to the Queue, releases their claims and
notes why in their context. It does this without the model and even when there
is nothing to dream about; a manual or dry-run dream leaves tasks alone. The
result's `requeued` counts them. `PHREN_TASK_STALE=off` turns it off. See
[settling tasks](task-responsibility.md#settling-tasks).

The Hook also runs a weekly task audit for every project whose dreaming is
enabled, inside the same window and only when no agent works in the project. It
sends at most 40 open tasks to the project's helper model with the
`phren-task-audit` skill's rules, the ones not audited longest first, and asks
for one verdict per task. A `done` verdict with evidence closes the task with a
`Weekly audit <date>: done: <evidence>` note; `partial` and `obsolete` add a
dated note; `valid` and `unresolved` change nothing. No task is ever removed.
Runs are recorded under `<project>/task-audits/`. `PHREN_TASK_AUDIT=off` stops
the ticker.

```bash
phren task audit --project my-app --dry-run   # the verdicts, nothing changed
phren task audit --project my-app             # apply them now
```

## What a dream can change

Each change in a dream's changeset is one of:

| Change | What it does |
|--------|--------------|
| `add_finding` | Saves a new finding, optionally typed and filed under a topic. |
| `supersede` | Marks a finding superseded and links it to the corrected text. |
| `retract` | Marks a finding retracted, with the reason. |
| `edit` | Rewrites a finding in place, keeping its history. |
| `merge` | Folds several findings into one. |
| `move_topic` | Files a finding under another topic. |
| `promote_truth` | Pins a finding as a truth (refused if it would break the injected budget). |
| `demote_truth` | Removes a truth from the always-injected layer. |
| `write_page` | Writes `reference/pages/<slug>.md`. |
| `link` | Links a finding to a fragment (a library, tool or concept). |

Changes go through the same APIs as the MCP tools, so finding history, metadata, locks and citations are kept.

## Pages

A page is one subject: `<store>/<project>/reference/pages/<slug>.md`. A slug is lowercase letters, digits and dashes, at most 64 characters. A page has frontmatter with a `title`, a one-line `summary` and an `updated` date, then the body. It links other pages as `[[slug]]` and cites findings as `fid:xxxxxxxx`.

```markdown
---
title: Rate limiter
summary: Postgres advisory locks back the limiter on every install.
updated: 2026-11-06
---

The limiter takes a Postgres advisory lock per key (fid:3fa1c09b). Redis is not
available on-prem, so there is one code path. See [[database]].
```

Pages are capped at 16 KB; a bigger subject should be split. Links to pages that do not exist are written anyway and reported. Pages are ordinary reference documents, so `search_knowledge` finds them; they are not injected into every session.

## Propose or apply

In **propose** mode (the default), `add_finding` changes go to the ordinary review queue in `review.md`. A full review queue ([Budgets](governance.md#budgets)) can defer an addition. Use `phren dream apply` on its run to retry publication when the queue has room.

Additions approved through the review queue are not counted. The acceptance trial covers the `correct` and `prune` phases.

Every other operation stays in `dreams/<runId>.json`, with its zero-based index and `proposed` outcome. Inspect the changes and evidence in that file, then apply all pending structured proposals or select indices:

```bash
phren dream apply <runId> --project my-app
phren dream apply <runId> --project my-app --only 0,2,4
phren dream apply <runId> --project my-app --only 1 --reject --reason "Needs more evidence"
```

The MCP admin action `dream_apply` takes `project`, `runId`, optional `only: [0, 2, 4]`, and optional `reject: true` with a `reason`. Rejection applies to structured proposals. Apply rechecks each target finding against the stored bullet and citation version under the findings write lock. Missing or changed targets leave the proposal pending. To apply ideas from an old run without target versions, create a fresh dream. If the mutation succeeds and saving its decision fails, retry the same proposal on the same computer. The local receipt lets the retry finish recording the decision without applying the change again.

In **apply** mode the changes are applied straight away and logged.

## Proposal acceptance

`phren dream status --limit <n>` and the `dream_status` action summarize the latest recorded runs for each project. The default is 20 runs and the range is 1–500. The counts combine structured proposals with their decision files. Pending, conflicted and skipped proposals have separate counts and are excluded from the acceptance rate, `applied / (applied + rejected)`. With no applied or rejected proposals, CLI text shows a dash and JSON returns `acceptRate: null`. Status lists every unresolved conflict with its run and index, including conflicts outside the summary window.

A 0.3.97 client writes structured decisions into the run file itself. In propose-mode runs, legacy `applied` outcomes count as approvals and `skipped` outcomes count as completed skips. Legacy approvals have no decision timestamp. Review-queue activity on any client stays outside these counts.

## Where the output goes

- `<store>/<project>/dreams/<runId>.json` contains the full changeset, input counts, validation drops, and initial outcomes. Structured decisions leave this file unchanged. A retry of a deferred addition still records its publication outcome there.
- `<store>/<project>/dreams/decisions/<runId>/<index>-<decisionId>.json` is an immutable structured decision. The random UUID in the filename is the decision ID. Each file contains `runId`, `index`, `op`, `outcome` (`applied` or `rejected`), `decidedAt` (UTC ISO 8601), and `computer`. It may contain a `reason` and a `supersedes` array of IDs. `legacy-applied` refers to a 0.3.97 approval for the same proposal. Normal store sync carries decision files between computers. Agreeing decisions count once, using the earliest known timestamp and retaining every reason. Opposing active decisions produce `conflicted` until superseded.
- `<store>/.runtime/dream-receipts/<project>/<runId>/<index>.json` is the local recovery receipt for an applied structured proposal. It is cleared after the decision file is saved.
- `<store>/<project>/dreams/journal.md` has one summary per run. Later dreams read it. Proposal decisions are recorded only in the decision files.
- `<store>/<project>/dreams/last-run.json`: when the last dream ran, for scheduling.
- `review.md` contains proposed additions tagged with their run and proposal index. Other proposals stay in the run record until resolved.

## Reviewing and undoing

Start with `phren dream log` and open the run's `dreams/<runId>.json` to see each change and its evidence.

If status reports a conflict, inspect the proposal and reconcile its memory changes. For `applied`, keep the corresponding change. For `rejected`, undo only the changes caused by that proposal and preserve independently saved findings. Then record the chosen outcome as a new decision. This command changes the decision history only.

```bash
phren dream apply <runId> --project my-app --only 1 --resolve rejected --reason "Insufficient evidence"
```

The MCP equivalent is `dream_apply` with `only: [1]` and `resolve: "rejected"`. Resolution supersedes the active decision IDs seen on that computer. A later sync can introduce another opposing decision and reopen the conflict.

To undo an applied dream:

- A superseded, retracted or edited finding keeps its history. Restore it from the run record, or revert the store commit if the store is synced with git.
- A demoted truth's text is in the run record; pin it again with `phren_admin`/`revise_finding` `pin`.
- A page is a file; delete it or restore it from git.
- If a project's dreams keep going wrong, set its `mode` back to `propose`, or turn `enabled` off for that project.

## Evaluating a dream

`phren dream eval` builds a small fixture project in a temporary directory and runs a dream on it. The fixture has a finding a later transcript contradicts, two duplicate findings, a decision stated in a transcript and never saved, truths over the budget, and a correct finding that must be left alone. The run is scored on whether it corrected, merged, captured and demoted, and on precision: the correct finding untouched, recently cited truths kept, and evidence on every claim.

By default the eval uses a scripted model, which only answers a situation when the prompt carries the evidence for it. `--real` runs the project's helper model instead and costs a model call. The harness lives in `packages/cli/src/dream/eval/`.
