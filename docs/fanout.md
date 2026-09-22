# Fan-out workers

A fan-out launches headless agent workers in isolated worktrees so a lead can
delegate bounded tasks. The launcher lives outside this repository at
`~/.phren/global/skills/fanout/scripts/run.sh`; the Hook discovers each job by
reading the job directory it writes.

## Job directory

Each job is a directory under the store's private runtime root:

```
<store>/.runtime/agent-fanouts/<job id>/
  manifest.json    # schemaVersion, id, parent, provider, taskLabel, worktree, eventLog, status, ...
  events.jsonl     # the worker's projected event log
  stderr.log       # bounded tail inspected for OpenCode refusals
  exit.txt         # the launcher's recorded exit code
  blocked.json     # present only when a permission was refused (see below)
```

`<store>` is `PHREN_PATH` when set, otherwise `~/.phren`.

## Environment the launcher sets

| Variable | Meaning |
| --- | --- |
| `PHREN_FANOUT_JOB` | The job id. Its presence tells the opencode plugin it is running headless. |
| `PHREN_FANOUT_DIR` | The absolute job directory. The plugin writes `blocked.json` here. |

When `PHREN_FANOUT_DIR` is unset the plugin falls back to
`<store>/.runtime/agent-fanouts/<PHREN_FANOUT_JOB>`.

## blocked.json

A headless worker has nobody watching the phone's approval queue. The opencode
plugin grants `edit`, `bash` and `webfetch` in the worker's own worktree and
allows `external_directory` only under the worktree's grandparent (the scratch
root). Anything else is refused, which aborts the worker's turn.

When it refuses, the plugin writes `blocked.json` before returning the denial:

```json
{
  "type": "external_directory",
  "pattern": "/private/tmp/elsewhere",
  "message": "external_directory: /private/tmp/elsewhere",
  "at": "2026-09-20T18:04:11.000Z"
}
```

`type` is the opencode permission kind, `pattern` is the joined pattern (empty
when the ask named none), `message` is the human-readable ask, and `at` is when
the denial happened.

The launcher may record exit 0 even though the denied permission aborted the
turn. The Hook treats a job with `blocked.json` as failed regardless of
`exit.txt`. The public `/v1/subagents` state is `completed` for terminal jobs,
with the failure recorded in the reason
`blocked: <type> <pattern>`, and a registered phone receives one push naming the
worker and the reason. Overlapping notification sweeps are coalesced.

## Archiving finished jobs

Job folders do not pile up forever. A sweep the Hook runs at start and then
hourly moves a folder from `<store>/.runtime/agent-fanouts` to
`<store>/.runtime/agent-fanouts-archive/<job id>` when all of these hold:

- the folder contains `exit.txt`. A folder without it is still running, and
  the sweep never touches it, whatever its manifest says;
- its `manifest.json` status is `completed`, `failed` or `cancelled`; and
- its `finishedAt` is more than 24 hours old. When the manifest has no
  `finishedAt`, the modification time of `exit.txt` decides.

A folder with no manifest at all is moved once its `exit.txt` is more than 24
hours old. The sweep writes `{ "status": "failed", "reason": "no manifest" }`
as its manifest in the archive.

The archive holds at most 500 folders; the oldest beyond that are deleted.
Each sweep that moved or deleted anything writes one line to the Hook's log.

Run the sweep by hand with:

```
phren bridge fanouts archive [--dry-run]
```

`--dry-run` reports what would move and what would be deleted without touching
anything.

## OpenCode's own refusals

In `opencode run`, OpenCode rejects some permissions itself (external_directory,
doom_loop) before any plugin sees them and prints `permission requested: <type>
(<pattern>); auto-rejecting` to stderr. The launcher captures stderr into the job
directory, and the Hook reads only the final 16 KiB of `stderr.log` when no
`blocked.json` exists. The last matching refusal becomes the failure reason
`blocked: <type> <pattern>`. Explicit failed or cancelled manifest states are
also preserved internally even when an exit code is absent.
