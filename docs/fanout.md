# Fan-out workers

Enable `hook`, then `fanout`. Fresh stores enable memory only.

```sh
phren modules enable hook
phren modules enable fanout
phren fanout run --tier narrow --label parser --worktree /home/sam/work/parser < brief.txt
phren fanout usage
phren fanout list
phren fanout resume JOB < review.txt
phren fanout review JOB --model gpt-5.6-terra
phren fanout archive --dry-run
```

The launcher reads the local Hook's `/v1/usage`, including OpenCode Go. Without
Hook it uses the same account readers directly. Ordered candidates are selected
from `<store>/.config/fanout.yaml`. A printed reason is stored in the manifest.
Usage at or above the threshold is skipped. Recent OpenCode log errors saying
Go usage limit exceeded or Rate limit exceeded exclude that provider for 30
minutes. Unknown usage is reported explicitly and does not invent headroom.

```yaml
threshold: 80
computerCap: 6
providerCap: {codex: 3, claude: 2, opencode-go: 4}
swiftBuildCap: 2
tiers:
  narrow:
    - {provider: opencode, model: opencode-go/mimo-v2-flash}
    - {provider: codex, model: gpt-5.6-terra}
  wide:
    - {provider: codex, model: gpt-6-astra}
    - {provider: claude, model: opus}
  review:
    - {provider: codex, model: gpt-5.6-terra}
    - {provider: claude, model: sonnet}
```

Explicit `--provider` and `--model` choices still respect quotas and caps.
Reservation and concurrency checks share a store lock. Swift briefs check
running xcodebuild processes against a cap of two. All workers run at nice 15.
Codex, OpenCode and Claude own their argv and resume semantics in adapters.
Claude uses `claude -p --output-format stream-json`. OpenCode runs under
`opencode serve` and the launcher drives its session over HTTP (see
[permission asks](#permission-asks-reach-the-phone)). A fresh review uses the
provider's read-only or planning mode. Codex resumes retain their original
sandbox and worktree; a review prompt cannot change that inherited sandbox.

Every 30 seconds, the watchdog checks the last 60 OpenCode tool calls. Two or
fewer distinct inputs produce `looped.txt` and `blocked.json` and stop the worker.
Signals finalize cancellation; refusals override an otherwise successful exit.
The existing external store scripts remain usable and are not removed.

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
| `PHREN_FANOUT_APPROVALS` | `1` for an OpenCode worker the launcher drives: the plugin leaves an ask it would refuse to the phone. |
| `OPENCODE_SERVER_PASSWORD` | A random password for this worker's `opencode serve`, so only the launcher can answer its asks. |

When `PHREN_FANOUT_DIR` is unset the plugin falls back to
`<store>/.runtime/agent-fanouts/<PHREN_FANOUT_JOB>`.

## blocked.json

A headless worker has nobody watching the phone's approval queue. The opencode
plugin grants `edit`, `bash` and `webfetch` in the worker's own worktree and
allows `external_directory` only under the worktree's grandparent (the scratch
root). Anything else is refused, which aborts the worker's turn. With
`PHREN_FANOUT_APPROVALS=1` it goes to the phone instead (next section), and
OpenCode 1.18 does not call this plugin hook at all.

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
`blocked: <type> <pattern>`. Rows also expose `failed` and `finishedAt` so the
phone can distinguish failure and show its age. The worker row and chat header
read Permission refused with the refused type and pattern and a FAILED badge.

Agent work puts running jobs first, keeps failures for one hour and remembers
dismissed failures. Header counts match those visible rows. This phone policy
does not change the archive rules below or delete the job directory.

With direct APNs configured and a phone registered, the Hook sends one push
naming the worker and reason. Overlapping notification sweeps are coalesced.
The phone's local approval and schedule reminders are a separate path; see
[phone notifications](../apps/ios/design/notifications.md).

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
phren fanout archive [--dry-run]
```

`--dry-run` reports what would move and what would be deleted without touching
anything.

`phren bridge fanouts archive` runs the same sweep and also takes
`--parent <session-id>`, which moves only the jobs that parent chat started,
and `--older-than <minutes>`, which replaces the 24 hours (`0` moves every
finished job). A job without `exit.txt`, with a `message-lock` or with queued
messages stays put either way; with `--parent`, a folder without a manifest is
left alone too.

The phone's agent tree folds finished workers into one "N finished" row and
offers Clear finished, which calls `POST /v1/subagents/archive-finished` with
`{ target }`: the Hook validates the live parent and archives that parent's
finished jobs at any age under the same checks, returning `{ ok, archived }`.

## Permission asks reach the phone

`opencode run` answers every permission ask itself: it prints `permission
requested: <type> (<pattern>); auto-rejecting` and rejects it, before any plugin
or phone can answer. So `phren fanout run` starts an OpenCode worker with
`opencode serve --hostname 127.0.0.1 --port 0` in the worktree, under a random
`OPENCODE_SERVER_PASSWORD`, and drives it over HTTP: it creates the session with
the rules `opencode run` gives one (`question`, `plan_enter` and `plan_exit`
denied), sends the brief with `prompt_async`, and follows `/event`, writing the
same `tool_use`, `step_start`, `step_finish`, `text` and `error` lines to
`events.jsonl` that `opencode run --format json` prints. The worker is done when
its session goes idle; the launcher then stops the server.

Routine reads never ask: a worktree's own `opencode.json` `permission` rules
decide those inside OpenCode. `doom_loop` is allowed, because the watchdog above
stops a real loop with a clearer reason. Any other ask for the worker's session
or one of its subagents is relayed, one at a time:

1. The launcher writes `<store>/.runtime/approvals/opencode-<worker session>.request.json`,
   the file the Phren plugin writes for a pane, with `id` (the OpenCode
   permission id), `type`, `title` (`Allow <type> for <label>?`), `message`
   (`<type>: <patterns>`), `fanout` (the job id), `createdAt` and `expiresAt`
   (one hour later; `PHREN_FANOUT_APPROVAL_MS` overrides it).
2. The Hook holds it once the named job's manifest confirms the worker session,
   a running status and a parent. It pushes it to registered phones and shows it
   as the pending approval of the parent conversation, so the phone's existing
   approval card answers it; the action id has the parent's shape (a UUID, or 32
   hex characters for an opencode parent). The worker row in `/v1/subagents`
   stays `running` with `reason: "needs-you: <type>: <patterns>"`, never blocked
   or finished.
3. The answer, from the card or the push, lands in
   `opencode-<worker session>.answer.json`. Allow replies `once` and the same
   session carries on to completion. Deny replies `reject` with a message telling
   the worker not to retry and to report what it could not do, which OpenCode
   hands the model as feedback instead of ending the turn, so the worker finishes
   and says so. With no answer before `expiresAt`, the same happens with a
   message saying nobody answered.

Each decision is also recorded in `events.jsonl` as a `phren/permission` line.
A denied ask leaves no `blocked.json`; the job ends `completed` unless the
session itself failed.

Workers started by older launchers with `opencode run` still refuse on their
own. The Hook reads only the final 16 KiB of their `stderr.log` when no
`blocked.json` exists, and the last matching refusal becomes the failure reason
`blocked: <type> <pattern>`. Explicit failed or cancelled manifest states are
also preserved internally even when an exit code is absent.

## Continue a worker from chat

The child tree publishes `fanout.resumable` for Codex and OpenCode jobs with a
saved session id. `POST /v1/subagents/resume` accepts `{ target, child, text }`:
the live parent target, opaque child id from that tree and a message. The Hook
checks the parent, child relationship and canonical store containment. The
client cannot supply a job path, worktree, worker session or another store.

A finished worker resumes its own session in the original worktree using the
fan-out provider adapter, with the prompt on stdin. Its original job and event
log stay in place. Each continuation records a prompt under `rounds/<id>`;
the current `prompt.txt` and manifest describe the latest round. Running jobs
keep messages under `messages/` until their manifest reaches a terminal state.
A per-job lock prevents overlapping continuation rounds. Archive maintenance
leaves queued or locked jobs in place.

`GET /v1/subagents/messages` takes the same target query and `child`, returning
receipts with `id`, `text`, `createdAt` and `status`: `queued`, `running`,
`completed` or `failed`. Queued receipts survive Hook restarts; running receipts
are never automatically replayed. The phone polls those receipts and follows
the existing child transcript stream. Pane-backed children open their full
session chat, while in-process children send a labeled message to the parent.
