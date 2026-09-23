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

The `id` is eight lowercase hexadecimal characters and does not change. Names are 1 to 80 characters, prompts are 1 to 8000 characters, and a project may have at most 64 schedules. `model` is optional; without it, the selected harness uses its default. `notify` is an optional list containing `start`, `finish`, and `failure`. When it is absent, Phren notifies on finish and failure.

`every` selects one timing form:

| `every` | Required fields | Example |
| --- | --- | --- |
| `interval` | `interval` | `interval: 6h` (`m`, `h`, and `d` are supported) |
| `daily` | `at` | `at: "07:30"` |
| `weekly` | `at`, `days` | `days: [mon, wed, fri]` |
| `once` | `once` | `once: 2026-09-21T09:00:00` |
| `cron` | `cron` | `cron: "0 7 * * 1-5"` |

Times have no zone in the file. The Hook evaluates them in the assigned computer's local time zone. A nonexistent wall-clock time during a daylight-saving transition is skipped. A once schedule disables itself after its run is recorded.

The `computer` value names a key in `machines.yaml`. Matching is case-insensitive and ignores a trailing `.local`, so `Desk`, `desk`, and `desk.local` identify the same computer. There is no `any` computer mode.

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

`add` also accepts `--prompt-file <path>`. Weekly schedules use `--days mon,tue`; interval, once, and cron schedules use `--interval 6h`, `--once 2026-09-21T09:00:00`, and `--cron "0 7 * * 1-5"` respectively.

`run` and `history` call the local Phren Hook. They report a clear error when the Hook is not running. The other commands edit the store file directly.

## Execution and local state

The Hook checks schedules every 30 seconds. It records a run before launching, so a restart cannot launch the same due occurrence twice. A schedule with a `launched`, `running`, or `blocked` record cannot start again.

When Herdr is available, the Hook creates a workspace or tab in the project source directory, starts the selected harness, waits for it to accept input, and sends the prompt. Without Herdr, it starts the harness headlessly and writes a fanout manifest and JSON event log under the store's private runtime directory. Scheduled Codex jobs use workspace-write sandboxing.

Headless launches pass the flags that skip each harness's own startup prompts where the harness has them, so a scheduled run does not stop on a prompt nobody is there to answer. Claude runs headlessly from the project directory with `--settings` pre-answers; that approves project `.mcp.json` servers without a prompt. Claude has no settings key for the `Allow external CLAUDE.md file imports?` dialog: in `-p` mode Claude drops those imports instead of blocking, and a Herdr-launched interactive run is covered by the blocked-at-startup detection below. Codex runs with `--skip-git-repo-check`, and before the launch the Hook writes a quoted `[projects."<dir>"]` `trust_level = "trusted"` entry into `config.toml` (a dotted project path is handled; a flat `-c projects.<dir>.trust_level` key is not). OpenCode needs no flags.

A Herdr launch that does stall anyway is recorded rather than left silent. The Hook watches only the run's first 90 seconds, open for classification until 95 seconds: when that window shows no transcript activity (a transcript that first appears more than 30 seconds in counts as activity, so a slow first response is not misread) and the pane status is `blocked` or `waiting` on input, the Hook reads the pane's last 40 rendered rows through Herdr's `pane.read` `recent` source, keeps the trailing prompt-shaped lines, sets the run to `blocked` with that visible prompt text in `blockedStartupPrompt`, and pushes a `scheduleBlocked` notification whose reason is `Blocked at startup: <prompt text>`. The pane is read at most three times inside the window; an empty or prompt-less read is abandoned rather than polled for the rest of the run. Every schedule notification uses its own APNs collapse id per run and kind, and a run whose blocked alert was delivered sends no second finished/failed alert, so the blocked alert is not replaced. The run stays in `blocked` until the pane finishes or exits, so the same schedule cannot launch a second copy over it.

A Herdr run ends when its pane reports `idle` or `done` (Herdr shows a finished turn as `done` until someone looks at it). The Hook then reads the end of the run's transcript: when the turn finished (Claude's `end_turn` reply or `turn_duration` record, Codex's `task_complete`, opencode's `end_turn`) and its last reply ends by asking the owner something, a closing question or numbered options introduced as a choice, the run is recorded as `needs-you` with that question's first line as its reason and notified as a finish. Otherwise it is `finished`. A pane that closes, or a status Herdr does not use for a live agent, is `failed`.

Run history is local to the computer in the Hook runtime as `schedule-runs.jsonl`; it is never stored or synced with the project. Each line is one run, and only the newest 2000 runs are retained. A run records its schedule and project, timestamps, status (`launched`, `running`, `blocked`, `finished`, `needs-you`, `failed`, or `skipped`), reason when present, `blockedStartupPrompt` when it was recorded blocked at startup, `blockNotified` when that blocked alert was delivered, notification delivery result, and either its Herdr destination or headless job directory. If APNs is not configured, a requested notification records `notified: false` and `notifyReason: "no push config"`, writes the reason to the Hook service log, and never interrupts the run.

## Hook routes

The iPhone can also register a local reminder for each schedule's next known
run, using Hook's `nextRun` and the assigned computer's time zone. This path
needs no APNs key or relay and has its own Settings > Notifications switch.
It is separate from `notify` run-event preferences and does not prove a prompt
launched. A tap checks fresh history and opens that run's session when available,
otherwise its schedule history. Background refresh is scheduled by iOS and may
not run in time. See [phone notifications](../apps/ios/design/notifications.md).


All schedule routes are JSON `POST` requests on the authenticated Hook connection:

| Route | Result |
| --- | --- |
| `/v1/schedules` | All store schedules with project, local `nextRun`, latest local run, and running state. `nextRun` is null for schedules owned by another computer. |
| `/v1/schedules/run` | Runs `{ project, id }` now. Returns 404 for an unknown schedule and 409 if it is already running or belongs to another computer. |
| `/v1/schedules/history` | Returns newest-first local runs. Accepts optional `project`, `id`, and `limit` (default 50, maximum 500). Each row carries its status (including `needs-you` with the owner question as `reason`) and, when the run was recorded blocked at startup, the `blockedStartupPrompt` text the pane showed. |
