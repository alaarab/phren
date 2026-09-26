---
name: fanout
description: Delegate independent, bounded implementation or review work to headless agent workers using phren fanout.
---

Fan out when independent tasks can make progress alongside the lead's work.
Give each writer a separate worktree and a concrete output to validate. A brief
should name the goal, owned files, constraints, tests, and completion report.
Include relevant findings and exact review issues; avoid sending the whole chat.

Start every worker through `phren fanout run`, never with `opencode run`,
`codex exec` or `claude -p` of your own (directly, in a loop, or from a script
with nohup). `phren fanout run` writes the job manifest that ties the worker to
your conversation; a worker without one is invisible to the phone, the
conductor and `phren fanout list`, and nothing can resume, review or archive it.

Enable Hook and fanout, then use `phren fanout run --tier narrow|wide|review
--label LABEL --worktree PATH < brief.txt`. The command chooses an eligible
provider using current usage, errors and concurrency. Use `phren fanout usage`
to inspect it, and `--provider`/`--model` for an explicit choice subject to caps.

Use `phren fanout list` to inspect jobs, `phren fanout resume JOB < feedback.txt`
to send a bounded follow-up, and `phren fanout review JOB` for a review round.
Codex resumes inherit their original sandbox; ask a resumed author to review
without edits. Use a fresh review-tier worker for an enforced read-only sandbox.
Archive completed jobs with `phren fanout archive`.
