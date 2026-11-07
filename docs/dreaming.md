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
phren dream status --project my-app           # enabled, cadence, last run, next eligible time, last outcome
phren dream log --project my-app --limit 20   # the journal
```

The same are available to agents as the `phren_admin` actions `dream_run`, `dream_apply`, `dream_status` and `dream_log`.

Only one dream runs per project at a time. A second one started while the first is running returns `busy`.

All prompt inputs (including memory, page summaries, journal and commit subjects) are redacted with the shared secret scanner before interpolation, and the completed prompt is scanned before invoking the helper. Notes, diagnostics and rejection reasons are sanitized before persistence or return.

OpenCode plugin transcripts use session directory metadata when available. Sessions without a resolvable directory are skipped and reported; the transcript watermark is held back so they can be collected later. The last-run marker has one writer inside the engine's project lock, including its completion time (`at`) and manual/scheduled trigger.

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

In **propose** mode (the default) nothing in memory changes. Only `add_finding` changes become review items in `review.md`; approving them saves the finding. Review additions like any other queue item:

```bash
phren review                           # show the queue
phren review approve <project> <text>  # accept it
phren review reject  <project> <text>  # drop it
```

Every other operation stays in `dreams/<runId>.json`, with its zero-based index and `proposed` outcome. Inspect the changes and evidence in that file, then apply all pending structured proposals or select indices:

```bash
phren dream apply <runId> --project my-app
phren dream apply <runId> --project my-app --only 0,2,4
```

The MCP admin action `dream_apply` takes `project`, `runId`, and optional `only: [0, 2, 4]`. Adds stay in the review queue. Apply rechecks each target finding against the stored bullet and citation version under the findings write lock, refusing missing or changed targets. Completed operations are never replayed. Each outcome is saved back to the run record and appended to the journal; `status` and `log` report the remaining pending structured proposal count. Old run records without target versions cannot safely apply finding operations; create a fresh dream instead.

In **apply** mode the changes are applied straight away and logged.

## Where the output goes

- `<store>/<project>/dreams/<runId>.json`: the full changeset, its inputs (how many transcripts, findings, truths and pages it read) and each change's outcome, including the ones validation dropped and why.
- `<store>/<project>/dreams/journal.md`: one line per dream. Later dreams read it, so they see what earlier ones did.
- `<store>/<project>/dreams/last-run.json`: when the last dream ran, for scheduling.
- `review.md` for proposed additions; other proposed operations stay in the run record until explicitly applied.

## Reviewing and undoing

Start with `phren dream log` and open the run's `dreams/<runId>.json` to see each change and its evidence.

To undo an applied dream:

- A superseded, retracted or edited finding keeps its history. Restore it from the run record, or revert the store commit if the store is synced with git.
- A demoted truth's text is in the run record; pin it again with `phren_admin`/`revise_finding` `pin`.
- A page is a file; delete it or restore it from git.
- If a project's dreams keep going wrong, set its `mode` back to `propose`, or turn `enabled` off for that project.

## Evaluating a dream

`phren dream eval` builds a small fixture project in a temporary directory and runs a dream on it. The fixture has a finding a later transcript contradicts, two duplicate findings, a decision stated in a transcript and never saved, truths over the budget, and a correct finding that must be left alone. The run is scored on whether it corrected, merged, captured and demoted, and on precision: the correct finding untouched, recently cited truths kept, and evidence on every claim.

By default the eval uses a scripted model, which only answers a situation when the prompt carries the evidence for it. `--real` runs the project's helper model instead and costs a model call. The harness lives in `packages/cli/src/dream/eval/`.
