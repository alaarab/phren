# Scheduled prompts

Scheduled prompts let Phren run an agent on a chosen computer at a local time. The git-synced store is the source of truth for definitions. Each Phren Hook keeps its own run history and only runs schedules assigned to its computer.

## Store format

Each project may contain `schedules.yaml` beside `tasks.md`:

```yaml
version: 1
schedules:
  - id: 7f3a2c1d
    name: Nightly test sweep
    enabled: true
    computer: Desk
    harness: codex
    model: gpt-5.6-sol
    notify: [finish, failure]
    every: weekly
    at: "07:30"
    days: [mon, tue, wed, thu, fri]
    prompt: |
      Run the full test suite and summarize the result.
    createdAt: 2026-09-20T21:00:00Z
    updatedAt: 2026-09-20T21:00:00Z
```

The `id` is eight lowercase hexadecimal characters and does not change. Names are 1 to 80 characters, prompts are 1 to 8000 characters, and a project may have at most 64 schedules. `model` is optional; without it, the selected harness uses its default. `account` is optional: a Claude account id (`default` or a slug) the run uses; a Herdr run launches under it and a headless Claude run gets its `CLAUDE_CONFIG_DIR`. `phren schedule add ... --account <id>` sets it. `notify` is an optional list containing `start`, `finish`, and `failure`. When it is absent, Phren notifies on finish and failure.

`session` is optional: `new` (the default) starts a fresh agent session for every firing; `reuse` continues the schedule's last session instead (see [Continuing one session](#continuing-one-session)). `phren schedule add ... --session reuse` sets it.

`every` selects one timing form:

| `every` | Required fields | Example |
| --- | --- | --- |
| `interval` | `interval` | `interval: 6h` (`m`, `h`, and `d` are supported) |
| `daily` | `at` | `at: "07:30"` |
| `weekly` | `at`, `days` | `days: [mon, wed, fri]` |
| `once` | `once` | `once: 2026-09-21T09:00:00` |
| `cron` | `cron` | `cron: "0 7 * * 1-5"` |
| `event` | `event` (document version 2) | `event: github.workflow_run.completed` |

Times have no zone in the file. The Hook evaluates them in the assigned computer's local time zone. A nonexistent wall-clock time during a daylight-saving transition is skipped. A once schedule disables itself after its run is recorded, provided its timing and revision still match the occurrence that fired. An edit accepted during launch admission is left unchanged.

The `computer` value names a key in `machines.yaml`. Matching is case-insensitive and ignores a trailing `.local`, so `Desk`, `desk`, and `desk.local` identify the same computer. There is no `any` computer mode.

`projects` optionally supplies the complete target set, for example `projects: [api, website]`.
It accepts 1–64 unique project slugs (lowercase letters, digits, hyphens or
underscores, starting with a letter or digit, at most 100 characters each); the owner need not be included. Keep
one schedule definition in the owner's directory. Each target gets an independent
agent with the same settings. Every explicit target must exist and resolve to an
available source directory before any launch; missing or stale sources reject the
whole firing. Without `projects`, the owner is the target, retaining the legacy
store-directory fallback when no source is configured or discovered.

## CLI

```bash
phren schedule list [project]
phren schedule add acme --name "Nightly test sweep" --harness codex --computer Desk \
  --model gpt-5.6-sol --every daily --at 07:30 --prompt "Run the test suite."
phren schedule remove acme 7f3a2c1d
phren schedule enable acme 7f3a2c1d
phren schedule disable acme 7f3a2c1d
phren schedule run acme 7f3a2c1d
phren schedule history [project] [--id 7f3a2c1d] [--limit 100]
```

`add` also accepts `--prompt-file <path>`, `--projects api,website` and `--session reuse`. Enable/disable edits preserve the targets and the session option. Weekly schedules use `--days mon,tue`; interval, once, and cron schedules use `--interval 6h`, `--once 2026-09-21T09:00:00`, and `--cron "0 7 * * 1-5"` respectively.

`run` and `history` call the local Phren Hook. They report a clear error when the Hook is not running. The other commands edit the store file directly.

## Execution and local state

The Hook checks schedules every 30 seconds. It atomically records all child runs before launching any of them, so a restart cannot launch the same due occurrence twice. A schedule with any `launched`, `running`, or `blocked` child cannot start again. Concurrent Run now calls are refused while a batch is dispatching. Each launch is attempted independently; one failure does not cancel the other targets. A once occurrence is consumed by the durable batch even if the Hook restarts before launching it.

When Herdr is available, the Hook creates a workspace or tab in the project source directory, starts the selected harness, waits for it to accept input, and sends the prompt. Without Herdr, it starts the harness headlessly and writes a fanout manifest and JSON event log under the store's private runtime directory. Scheduled Codex jobs use workspace-write sandboxing.

Headless launches pass the flags that skip each harness's own startup prompts where the harness has them, so a scheduled run does not stop on a prompt nobody is there to answer. Claude runs headlessly from the project directory with `--settings` pre-answers; that approves project `.mcp.json` servers without a prompt. Claude has no settings key for the `Allow external CLAUDE.md file imports?` dialog: in `-p` mode Claude drops those imports instead of blocking, and a Herdr-launched interactive run is covered by the blocked-at-startup detection below. Codex runs with `--skip-git-repo-check`, and before the launch the Hook writes a quoted `[projects."<dir>"]` `trust_level = "trusted"` entry into `config.toml` (a dotted project path is handled; a flat `-c projects.<dir>.trust_level` key is not). OpenCode needs no flags. Copilot runs as `copilot --prompt=<prompt> --allow-all-tools --output-format json`: its non-interactive mode needs every tool allowed up front, and file access stays inside the project folder. A Herdr launch trusts the project folder the same way for Claude (`hasTrustDialogAccepted` in Claude's config), Codex and Copilot (`trustedFolders` in `~/.copilot/settings.json`) before the agent starts; `PHREN_PRETRUST=off` turns all of them off (see [footprint](footprint.md#folder-trust-for-launches-the-hook-places)).

A Herdr launch that does stall anyway is recorded rather than left silent. The Hook watches only the run's first 90 seconds, open for classification until 95 seconds: when that window shows no transcript activity (a transcript that first appears more than 30 seconds in counts as activity, so a slow first response is not misread) and the pane status is `blocked` or `waiting` on input, the Hook reads the pane's last 40 rendered rows through Herdr's `pane.read` `recent` source, keeps the trailing prompt-shaped lines, sets the run to `blocked` with that visible prompt text in `blockedStartupPrompt`, and pushes a `scheduleBlocked` notification whose reason is `Blocked at startup: <prompt text>`. The pane is read at most three times inside the window; an empty or prompt-less read is abandoned rather than polled for the rest of the run. Every schedule notification uses its own APNs collapse id per run and kind, and a run whose blocked alert was delivered sends no second finished/failed alert, so the blocked alert is not replaced. The run stays in `blocked` until the pane finishes or exits, so the same schedule cannot launch a second copy over it.

## Continuing one session

With `session: reuse`, a firing first looks for the schedule's session among the Herdr panes this computer's history records for the target (the last eight distinct panes, newest first). A pane whose conversation id was never recorded is asked for it. Nothing else is stored; a run that continued a session, or skipped because it was busy, records that same pane, so the chain carries on.

- **Still open and idle** (the newest of those panes that still exists and still runs the schedule's harness, Herdr shows `idle` or `done`): the prompt goes to it through the Hook's hand-off queue, the same path `hand_off` takes, with the run id as its delivery id. The run gets its own history row with `launch.reused: true` and is followed to its end as any Herdr run is (`finished`, `needs-you` or `failed`). The pane still shows the previous turn's idle right after the send, so idle counts as the end only once Herdr showed the pane busy or the transcript grew; a session that has not taken up the prompt after two minutes is `failed`. A Claude `/clear` in the same terminal is followed to the new conversation. Before typing into a Claude pane the Hook looks at its screen: Claude's optional "Teach auto mode about your environment?" dialog would take the prompt as its answer, so the Hook sends Esc and checks again; a pane where the dialog stays passes the firing to the next older pane. Once a pane has taken the firing, the schedule's older panes that are `idle` or `done` are closed (working ones are left alone).
- **Busy** (`working`, `starting`, or `blocked`/`waiting` on the owner): the firing is recorded as `skipped` with the reason (`The session this schedule continues is still working, so this firing was skipped.`), nothing is typed, and the next occurrence is computed from it as usual. Prompts never stack up behind each other.
- **Gone** (no pane is left: they closed, the agents exited, the conversations were replaced, or the hand-off refused every target): a new session starts exactly as for `session: new`, and the next firing continues that one.

The overlap rule still applies first: while the schedule's own run is `launched`, `running` or `blocked`, the schedule does not fire at all. Reuse needs Herdr; a headless run always starts fresh. The continued session keeps the model and account it started with, so a schedule edit to either takes effect once that session is gone.

A continued session's context grows with every firing. Claude Code and Codex compact a long conversation on their own, so an hourly schedule keeps working, but each turn carries the summary of earlier ones. To start fresh, close the session's pane (or `/clear` it); the next firing starts a new session.

A Hook restart or crash in the middle of a run (`phren bridge update`, a reboot) does not strand it. On its first check the new Hook process takes every run still recorded as `launched`, `running` or `blocked` that it did not start itself: a Herdr run is followed again from its recorded pane to its real end, a headless run is settled from its job manifest when the job recorded how it ended, and anything else is recorded `failed` with the reason (`Phren Hook restarted before this run finished launching.`, or `... so its end was not observed.`). A run whose schedule was removed meanwhile fails with that reason. Either way the run is closed and notified as usual, so the schedule can run again.

A Herdr run ends when its pane reports `idle` or `done` (Herdr shows a finished turn as `done` until someone looks at it). The Hook then reads the end of the run's transcript: when the turn finished (Claude's `end_turn` reply or `turn_duration` record, Codex's `task_complete`, opencode's `end_turn`, Copilot's `assistant.turn_end` after its `final_answer` reply) and its last reply ends by asking the owner something, a closing question or numbered options introduced as a choice, the run is recorded as `needs-you` with that question's first line as its reason and notified as a finish. A turn the harness ended on an error instead of a reply (Codex's `task_complete` carrying an `error`, such as its usage limit) is `failed` with that message as its reason. Otherwise it is `finished`. A pane that closes, or a status Herdr does not use for a live agent, is `failed`.

Run history is local to the computer in the Hook runtime as `schedule-runs.jsonl`; it is never stored or synced with the project. Each line is one run, and the newest 2000 runs plus any older open runs are retained, along with every sibling in their batches. A run records its schedule and actual target `project`, owning `scheduleProject`, shared firing `batchId`, timestamps, status (`launched`, `running`, `blocked`, `finished`, `needs-you`, `failed`, or `skipped`), reason when present, `blockedStartupPrompt` when it was recorded blocked at startup, `blockNotified` when that blocked alert was delivered, notification delivery result, and either its Herdr destination (with `reused: true` when it continued an earlier session) or headless job directory. If APNs is not configured, a requested notification records `notified: false` and `notifyReason: "no push config"`, writes the reason to the Hook service log, and never interrupts the run.

Old rows without `scheduleProject` use `project` as the owner. History filters and
restart recovery use the owner, even when it is not a target.

## Hook routes

The iPhone can also register a local reminder for each schedule's next known
run, using Hook's `nextRun` and the assigned computer's time zone. This path
needs no APNs key or relay and has its own Settings > Notifications switch.
It is separate from `notify` run-event preferences and does not prove a prompt
launched. A tap checks fresh history and opens that run's session when available,
otherwise its schedule history. Background refresh is scheduled by iOS and may
not run in time.


All schedule routes are JSON `POST` requests on the authenticated Hook connection:

| Route | Result |
| --- | --- |
| `/v1/schedules` | All store schedules with project, local `nextRun`, aggregated latest batch as `lastRun`, its child rows as `lastRuns`, and running state across all children. `nextRun` is null for schedules owned by another computer. `problems` (when present) says why a schedule can never fire: a computer that is not in `machines.yaml`, or, on the owning computer, a target project with no source directory or one that is gone. `phren schedule list` prints them with `!`, and `phren schedule add` refuses a schedule with one. |
| `/v1/schedules/update` | Merges `{ project, id, expectedUpdatedAt, changes }` under the schedule file lock. Returns `{ ok: true, schedule }`; 409 returns `{ error, schedule }` with the current stored schedule; 400 rejects invalid edits; 404 means the project or schedule is missing. |
| `/v1/schedules/run` | Runs `{ project, id, expectedUpdatedAt? }` now. Returns `{ ok, run, runs }`, with `run` the first child for older clients and `runs` in target order. HTTP 200 with `ok: false` exposes partial or total launch failures through each child's `status` and `reason`. Returns 404 for an unknown owner/schedule/target and 409 for overlap, another computer, or unavailable sources. |
| `/v1/schedules/history` | Returns newest-first local runs. Accepts optional `project`, `id`, and `limit` (default 50, maximum 500). Each row carries its status (including `needs-you` with the owner question as `reason`) and, when the run was recorded blocked at startup, the `blockedStartupPrompt` text the pane showed. |

The Hook advertises `capabilities.scheduleProjects: true` when the schedules
module is enabled. Clients should require this capability before offering
multiple targets. The `project` in schedule rows, Run now requests and history
filters is the owner. `lastRun` represents the latest batch with priority
`blocked`, `running`, `launched`, `failed`, `needs-you`, `finished`, `skipped`;
its finish time is the latest child finish, only when all children have ended.
Use `lastRuns` for individual targets and their session destinations.

After saving a schedule, clients can pass its `updatedAt` as `expectedUpdatedAt`
in `/v1/schedules/run`. This optional ISO 8601 timestamp must include a time zone;
fractional seconds and offsets are accepted. The Hook compares exact revision strings
inside schedule admission, before recording or launching any child. A mismatch
waits up to 30 seconds for the store to sync the edit (a copy older than the app's, or none yet) and then returns
HTTP 409 with a wait-for-store-sync message, leaving the schedule and run
history unchanged. A copy newer than the app's is refused at once. This prevents an immediate Run now from firing an older
single-target definition while a multi-target edit is still syncing. Send the
stored `updatedAt` unchanged, including its offset and every fractional digit;
omitting the field retains legacy behavior.

Clients should check `capabilities.scheduleUpdate: true` before using
`POST /v1/schedules/update`; older Hooks omit it and require the client's legacy
edit path. Send the owner's `project`, schedule `id`, and the per-schedule
`updatedAt` returned by `/v1/schedules` as `expectedUpdatedAt` (an ISO 8601
timestamp with a zone; the exact stored string must match). For example:

```json
{"project":"acme","id":"7f3a2c1d","expectedUpdatedAt":"2026-09-20T21:00:00Z","changes":{"name":"Morning sweep","model":null}}
```

`changes` accepts only `name`, `prompt`, `enabled`, `computer`, `harness`,
`model`, `account`, `notify`, `projects`, `session`, `every`, `at`, `days`,
`interval`, `once`, `cron`, `event`, `filters`, and `coalesceSeconds`. Omitted keys, including fields unknown to this
Hook, are preserved. Set an optional field to `null` to remove it; required
fields (including the selected timing form's fields) cannot be removed.
`id`, `createdAt`, and `updatedAt` cannot be edited. Unknown body or change
keys and wrong types return 400 with an error message. The merged schedule
uses the existing store validation; invalid results return 400 with the
validation message. Conflicts and rejected edits leave the file unchanged.
A successful merge gets a new `updatedAt` in canonical UTC form
(`YYYY-MM-DDTHH:mm:ss.sssZ`) and an atomic write under the same
lock as CLI schedule edits. The existing YAML serializer preserves values
and unknown keys, but may reformat comments, quoting, or whitespace.

## Event schedules (Hook capability `scheduleEvents`)

The schedules module advertises `capabilities.scheduleEvents: true` in Hook
info. Require it before showing event schedule creation/editing or sending
`POST /v1/schedules/events`. Event schedules have `nextRun: null`; do not
register local time reminders for them. They retain the ordinary computer,
harness, targets, session and notification settings.

A file with an event schedule needs this event-capable Hook version on **every
computer that reads the file**, including computers assigned only its timed
schedules. Upgrade every such computer before adding an event schedule.
Files containing event schedules require `version: 2`. This Hook reads versions
1 and 2; writers upgrade to 2 on the first event schedule and preserve 2 on
subsequent edits. Version 1 files without events retain their format. Older
Hooks reject version 2 and skip the **whole file**, including timed siblings,
in their scheduler; their CLI may report an unsupported-version error. Older
phones must not edit version 2 files. Upgrade every reader/writer of a shared
file before enabling events. Unknown future document versions are refused.

```yaml
version: 2
schedules:
  - id: 7f3a2c1d
    name: Repair failed main CI
    enabled: true
    computer: Desk
    harness: codex
    every: event
    event: github.workflow_run.completed
    filters:
      - path: repository.full_name
        equals: alice/app
      - path: workflow_run.head_branch
        equals: main
      - path: workflow_run.conclusion
        equals: failure
    coalesceSeconds: 120
    prompt: "Repair CI for {{payload.repository.full_name}} on {{payload.workflow_run.head_branch}}."
    createdAt: 2026-11-01T12:00:00Z
    updatedAt: 2026-11-01T12:00:00Z
```

`every: event` requires `event`, a case-sensitive name matching
`[A-Za-z][A-Za-z0-9_.:-]{0,127}`. Built-in GitHub names are
`github.workflow_run.completed` and `github.check_run.completed`; generic names
such as `deploy.failed` use the same syntax. `filters` defaults to `[]`, has at
most 16 entries, and every entry must be `{ path, equals }` with no extra keys.
All filters must match. Equality is exact and type-sensitive; `equals` is a
string (at most 1024 characters), finite number, boolean, or null. Missing
paths do not equal null. Paths are relative to `payload`, at most 200
characters, with dotted identifier segments (`[A-Za-z_][A-Za-z0-9_]*`) and
numeric array indices after the first segment. `__proto__`, `prototype` and
`constructor` segments are forbidden. Only own properties are traversed.
There are no expressions, operators, coercion, globbing or code evaluation.
`coalesceSeconds` is an optional integer from 0 to 86400, default 0.

Prompts substitute `{{payload.a.b}}` in one pass. Missing paths, null, objects,
arrays and invalid paths become empty strings. Strings, booleans and numbers
become plain text, credential detection runs before truncation, each value is
capped at 1024 characters, disallowed control characters are removed, and the
final prompt is capped at 8000 characters. Detected credentials become a
redaction marker. Replacement text is never evaluated or recursively expanded.
The worker still receives external text as part of its prompt; write prompts
that treat event values as data.

`POST /v1/schedules/events` uses the same authenticated Hook connection and
module route gate as other schedule writes. The exact JSON body is:

```json
{"event":"deploy.failed","deliveryId":"deploy-123","payload":{"environment":"production"}}
```

The body has no extra keys. `payload` must be a JSON object. `deliveryId` is
1–200 ASCII letters, digits, underscores, dots, colons or hyphens. The entire
UTF-8 JSON request is capped at 262144 bytes (413); malformed JSON, missing
fields, invalid types or names return 400 without consuming the delivery ID.
A successful request returns HTTP 200 with
`{ "ok": true, "duplicate": false, "runs": [...] }`. `duplicate` reports
Hook-wide delivery identity; `runs` contains child runs for accepted schedules
and one decision row for each non-accepted schedule. An unmatched event returns
an empty array. `ok` acknowledges ingestion, not worker success: inspect each
run's `status`. Acknowledgement waits for durable admission and run reservations,
not external worker startup. Accepted response rows initially have
`status: launched`; poll history for startup success or failure. Each schedule's
preparation failure is recorded separately as `status: failed`,
`outcome: accepted`, with a capped, credential-redacted `reason`, and processing continues
with the remaining schedules. Its row identifies the owning project because no
target worker was launched. Events run only schedules owned by the receiving computer;
they are not forwarded to other computers.

On the existing optional `/gitboy/push` HTTP listener, GitHub deliveries use
`X-GitHub-Event: workflow_run` or `check_run`, `X-GitHub-Delivery`, and
`X-Hub-Signature-256` (HMAC-SHA256 over the raw body). Existing private
`gitboy-webhooks.json` store secrets authenticate the delivery, and
`payload.repository.full_name` must match a repository associated with a
verified secret. Only `action: completed` reaches schedules; other actions
return 200 without ingestion. Configure repository and branch filters on the
schedule; the configured store branch is only a push/pull filter. This path
retains its loopback-only Host/browser guards and 1 MiB transport cap; schedule
events additionally have the 256 KiB cap above. Successful completions return
202 after ingestion, including replays (inspect schedule history for decisions).
Existing gitboy pushes still use the original pull/nudge path.

Admission checks, in order: a previously seen delivery ID is `duplicate`;
a disabled schedule or filter mismatch is `ignored`; a matching event strictly
less than `coalesceSeconds` after its last accepted event is `coalesced`;
a schedule with an open run is `ignored`; otherwise it is `accepted`.
Receipt time is captured before queuing admission and is used for coalescing
and event rows' `startedAt`. Worker startup never holds the admission queue.
Coalescing drops the new event, does not queue it, and does not extend the
window. At the exact window boundary it can be accepted. Failed launches still
count as accepted. Run now remains available, bypasses event filters and
coalescing, and uses the stored prompt literally without event substitution.
Timed ticks never launch event schedules.

Delivery IDs are global to this Hook, across event names and schedules; use
unique IDs across producers. The private file
`schedule-runs.jsonl.deliveries.json` stores SHA-256 hashes of the last 1000
new IDs, oldest first, and survives restart. Replays do not extend retention.
Evicted IDs may be accepted again. The ledger is persisted before schedule
admission and all child rows are recorded before external launch, providing
at-most-once attempts: a crash between recording delivery identity and launch
can drop a firing; it is not replayed automatically. A corrupt/unwritable ledger
fails ingestion rather than disabling dedupe.

Existing `/v1/schedules/history` rows, `/v1/schedules` `lastRun` and `lastRuns`
add optional `trigger: { event, deliveryId }`, `outcome` (`accepted`, `ignored`,
`duplicate`, `coalesced`) and `fields` (a map from payload paths to strings).
Accepted child rows keep normal launch status and destinations; non-accepted
rows use `status: skipped`, equal start/finish timestamps and a placeholder
`launch: { mode: headless }` which does **not** identify a launched worker.
Timed/manual rows omit these event fields. `fields` contains only referenced
filter/template scalar fields (at most 64 distinct paths, 1024 characters per
value, credential-redacted); no raw payload or rendered prompt is written to
schedule history or the ledger. Missing/non-scalar referenced values are empty
strings. Launchers and the worker's own transcripts may retain the rendered
prompt as for any scheduled worker. Non-accepted rows are limited to the newest
50 per owning project/schedule, within the existing global 2000-row retention
plus open batches and the latest accepted event batch per schedule within
24 hours of the newest recorded run (retained to preserve coalescing). The newest decision can be `lastRun` while an earlier
accepted run remains active; use `running` for overlap state.

`/v1/schedules/update` additionally accepts `event`, `filters` and
`coalesceSeconds` in `changes`, with `null` removing an optional field. The
merged form must validate; switching to `every: event` requires `event` and
upgrades the document to version 2. CLI listing prints the event, equality
filters and coalescing window. CLI creation accepts `--every event --event
<name> [--filters '<JSON filter array>'] [--coalesce-seconds <integer>]` along
with the ordinary required name, harness, computer and prompt options.
