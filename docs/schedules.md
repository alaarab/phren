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
    every: weekly
    at: "07:30"
    days: [mon, tue, wed, thu, fri]
    prompt: |
      Run the full test suite and summarize the result.
    createdAt: 2026-09-20T21:00:00Z
    updatedAt: 2026-09-20T21:00:00Z
```

The `id` is eight lowercase hexadecimal characters and does not change. Names are 1 to 80 characters, prompts are 1 to 8000 characters, and a project may have at most 64 schedules. `model` is optional; without it, the selected harness uses its default.

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

The Hook checks schedules every 30 seconds. It records a run before launching, so a restart cannot launch the same due occurrence twice. A schedule with a `launched` or `running` record cannot start again.

When Herdr is available, the Hook creates a workspace or tab in the project source directory, starts the selected harness, waits for it to accept input, and sends the prompt. Without Herdr, it starts the harness headlessly and writes a fanout manifest and JSON event log under the store's private runtime directory. Scheduled Codex jobs use workspace-write sandboxing.

Run history is local to the computer in the Hook runtime as `schedule-runs.jsonl`; it is never stored or synced with the project. Each line is one run, and only the newest 2000 runs are retained. A run records its schedule and project, timestamps, status, failure reason when present, and either its Herdr destination or headless job directory.

## Hook routes

All schedule routes are JSON `POST` requests on the authenticated Hook connection:

| Route | Result |
| --- | --- |
| `/v1/schedules` | All store schedules with project, local `nextRun`, latest local run, and running state. `nextRun` is null for schedules owned by another computer. |
| `/v1/schedules/run` | Runs `{ project, id }` now. Returns 404 for an unknown schedule and 409 if it is already running or belongs to another computer. |
| `/v1/schedules/history` | Returns newest-first local runs. Accepts optional `project`, `id`, and `limit` (default 50, maximum 500). |

