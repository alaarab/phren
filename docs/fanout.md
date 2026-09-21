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
`exit.txt`: `/v1/subagents` reports the child with the reason
`blocked: <type> <pattern>`, and a registered phone receives one push naming the
worker and the reason.
