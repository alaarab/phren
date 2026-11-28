---
name: fanout
description: Delegate independent, bounded implementation or review work to headless agent workers using phren fanout.
---

Fan out when independent pieces of work can make progress alongside the lead's work.
Give each writer a separate worktree and a concrete output to validate. A brief
should name the goal, the forge issue it serves, owned files, constraints,
tests, and completion report: post ONE summary comment on the issue when you
finish, and make the PR say `Closes <repo>#N`.
Include relevant findings and exact review issues; avoid sending the whole chat.
It also says that owner-only actions (merge, release, login, token, root step,
decision) go to the owner inbox as one line plus a paste-able command, linked
to the issue and PR: `phren owner-inbox add <title> --command <cmd> --pr
<url>`. They resolve themselves when the PR merges or the owner
runs the paste.

Start every worker through `phren fanout run`, never with `opencode run`,
`codex exec` or `claude -p` of your own (directly, in a loop, or from a script
with nohup). `phren fanout run` writes the job manifest that ties the worker to
your conversation; a worker without one is invisible to the phone, the
conductor and `phren fanout list`, and nothing can resume, review or archive it.

Enable Hook and fanout, then use `phren fanout run --tier narrow|wide|review
--label LABEL --worktree PATH < brief.txt`. The command chooses an eligible
provider using current usage, errors and concurrency. Use `phren fanout usage`
to inspect it, and `--provider`/`--model` for an explicit choice subject to caps.
A Codex agent that wants a Claude worker or reviewer runs `phren fanout run
--provider claude --model opus` (add `--tier review` for a read-only one); it
shows under the Codex conversation like any other worker.

Use `phren fanout list` to inspect jobs, `phren fanout resume JOB < feedback.txt`
to send a bounded follow-up, and `phren fanout review JOB` for a review round.
Codex resumes inherit their original sandbox; ask a resumed author to review
without edits. Use a fresh review-tier worker for an enforced read-only sandbox.
Archive completed jobs with `phren fanout archive`.

## Sharing one computer

Workers share the computer's memory, CPU, git state and processes with every
other agent on it. On a 31 GB Linux box, 5 to 10 agents with full test runs
ran it out of memory three times in a day.

- `phren fanout run` waits for this computer's worker budget (about one worker
  per 7 GB, set in `~/.config/phren/budget.yaml`) and says on stderr when it
  queued and why. `--priority release` goes first; `--wait 0` fails at once.
- Run every heavy job (a full test suite, a Gradle or Xcode build) as
  `phren heavy -- <command>`, with `--priority release` for release work. It
  allows N at once (about one per 12 GB) and replaces any lock of your own.
  `phren heavy status` shows who runs and who waits.
- Stop what you started before you finish: dev servers, watchers, browsers,
  build daemons (`./gradlew --stop`) and test database clones (`dropdb`).
  `phren reap` lists what agents left running with the command that stops
  each; it stops nothing, and the owner says which to stop.
- Never wait with `until ! pgrep -f <text>`: `pgrep -f` matches the waiting
  shell's own command line, so the loop never ends (26 were found running
  hours after their agents finished). Wait on a PID or a file, with a
  deadline: `for i in $(seq 360); do kill -0 "$pid" 2>/dev/null || break; sleep 5; done`,
  or poll the job's `exit.txt`.
- Commit in small steps, each one building, so a usage-limit stop loses
  nothing that is not in a commit.
- `git stash` and the rerere cache belong to the repository, not the
  worktree: every worktree sees the same stash list and replays the same
  recorded resolutions. Never `git stash pop` (one agent's pop applied
  another session's old stash); commit work in progress on your own branch
  instead. After a merge that rerere resolved, read the diff before you commit.

For work tracked in a forge issue, include its reference in the brief. Use `dispatch` with `issue` for issue-bound Hook workers. Send owner-only actions to the owner Inbox.
