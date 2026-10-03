# Conductor

A conductor is an agent session that sends bounded work to other sessions.
The optional `conductor` module supplies `dispatch`, `dispatch_returns`,
`hand_off`, `live_sessions`, `account_usage`, standing grants and the shipped
conductor brief.
It requires `memory` and `hook`.

```sh
phren modules enable conductor
phren bridge update
```

Restart Hook and MCP after enabling the module. Full MCP exposes these tools;
core MCP reaches them through `phren_admin`.

## Enroll computers

The Hook connects only to peers already configured in its private
`<bridge>/hooks.yaml`. Enrollment uses a dedicated ed25519 key, pinned SSH host
keys and the restricted `phren-hook v1 pipe` command. The directory holds at
most 32 peers. A peer's name selects its configured address, user, port, pin
and Herdr server; a tool argument cannot supply a new connection.

`phren bridge enroll-computer Desk` prints the enrollment material. The
`--accept <public-key-file>` form installs the supplied restricted computer key
on the receiving computer. Verify the peer and its host key during setup.
Phone connections are enrolled separately and do not come from worker reports.

Most owners already reach their computers over plain ssh. `phren bridge
discover` probes the concrete hosts in `~/.ssh/config` and the names in the
store's `machines.yaml` with your own ssh login (batch mode, 5 s) and lists the
ones that run Phren Hook and are not linked yet. It only reports; a reachable
computer is never treated as linked. `phren bridge link <host>` links one in a
single step after you confirm (`--yes` skips the question): over that same
login it enrolls each side's dispatch key on the other, reads each side's
ed25519 host key (never keyscanned) and pins it in the other's `hooks.yaml`,
then has each side dial the other to check the link. `--name` sets what this
computer calls the host, `--as` what the host calls this computer, and
`--back-address` the address the host dials back (by default, this computer's
address as the host's ssh session saw it). Rerunning `link` is safe: keys and
pins that already match are kept. Link a new computer with every computer
already in the group, so each one reaches the whole group in one hop.

## Launch a conductor

The phone launch sheet offers an Agent or Conductor role, a harness, model and
effort. `POST /v1/workspaces/launch` accepts `role: "conductor"` with Claude,
Codex or OpenCode (not Copilot or phren's own agent, which are refused with 400), loads the shipped brief and gives Herdr an agent name
starting with `conductor-`. Effort is `low`, `medium` or `high`.

The Hook also restores a concise role reminder and the local brief path on
Claude and Codex `SessionStart` and `UserPromptSubmit`. This covers fresh and
resumed sessions, compaction, and the next prompt after **Make conductor**;
changing a model keeps the conversation's context. OpenCode's transcript plugin
adds the reminder when building the current root conversation's system prompt.
The Hook checks its current foreground process and conversation before replying.
Worker callbacks, child sessions and reused terminal IDs receive no conductor
instructions. A role change does not send a message or start work by itself.

### Skill discovery and worker setup

Under the managed preset, `phren init` and `phren link` mirror enabled global
skills into `~/.agents/skills/` for Codex as well as `~/.claude/skills/` for
Claude. The source stays in the store's `global/skills/`; disabling a skill
removes its managed mirrors while preserving user-owned files. Existing mirrors
refresh on store pulls and skill switches. Assisted and manual installs use
`phren snippet` or MCP `read_skill` instead of creating home mirrors.

The conductor and fanout modules are opt-in. Enable `conductor` on each
participating computer and `fanout` on a lead's computer when local parallel
workers are wanted. The Claude marketplace plugin intentionally excludes these
two orchestration skills; the Hook's conductor brief works independently of the
marketplace skill list. An owner-disabled fanout skill stays disabled.

For a conductor → remote lead → local workers → integrator workflow, link the
computers in both directions, dispatch a bounded lead brief naming its project,
branch, tests and delegation limit, and have the lead report verified PRs with
`dispatch_report`. Configure the integrator with `phren conductor integrator`;
read `dispatch_returns` before recording work as complete. A phone-started agent
is a worker unless its role was explicitly set to Conductor. The owner's current
delegation and release restrictions apply at every level.

An agent (not a conductor) can start in a new worktree. The sheet's Work in a
new worktree switch is off by default; turned on, it takes a branch name,
suggested from the task's first line or `phren/<short-id>`. The Hook sends
`worktree: { branch }` to `git worktree add`, from the project's current HEAD
into `<repo>/.claude/worktrees/<name>`, and starts the agent there. It refuses
a folder that is not a Git repository and a branch that already exists, with a
message the phone shows. A Claude or Codex agent's new worktree is marked
trusted for that harness first, so it does not stop on the folder-trust screen
(see [footprint](footprint.md#folder-trust-for-launches-the-hook-places)). The worktree then appears in the session's Changes >
Workers tab, named for the agent working in it.

A computer runs at most one conductor, and a set of linked computers shares
one. Two computers are linked when each one's `hooks.yaml` lists the other
(what `phren bridge link` writes); a set is the computers joined that way.
Before launching a conductor the Hook checks its own record, then asks each
peer's `GET /v1/conductor` over the pinned connection. A live conductor on
this computer or any member refuses the launch with 409, naming the computer
and the existing target. A peer that does not list this computer back is in
another set and does not refuse it. A member that cannot answer (offline, or a
Hook too old to have the route) does not block the launch; its name comes back
in the launch result's `unchecked` list, as does a computer a member links that
this computer does not. The phone also offers an existing conductor it can
associate with the store. Workspace overviews and chat show the conductor role.

The Hook, not the terminal, holds the role. It records the conductor's pane in
`<bridge>/conductor-role.json`, and the role stays with that pane when its
agent restarts or the owner logs in again. The pane closing ends it. The Herdr
agent name (`conductor-*`) or tmux `@phren_agent` is a label for people; a
conductor from before the record is recognized by that name once and recorded.
A worker's name never starts with `conductor`, whatever its label says, and a
worker asked to open in the conductor's workspace gets its own workspace, so it
is never listed under the conductor's name. `live_sessions` names a worker
already in the conductor's workspace by its own tab.

```sh
phren conductor make              # the agent in this pane becomes this computer's conductor
phren conductor stop              # it keeps running, without the role
phren conductor sets              # sets, their computers, reachability and conductors, plus unlinked computers
phren conductor sets name Home    # name this computer's set on every reachable member
```

A conductor dispatches only within its set: a peer that does not link back is
refused by name and skipped by `anywhere`. Design and routes are in
[Conductor sets](conductor-sets.md).

Computers that are not linked can each run their own conductor. They
coordinate through the synced store by claiming tasks: `claim_task` (or
`manage_task` with `action: "claim"`) pulls the store, moves the task to Active
with a line under it in `tasks.md`,

```md
- [ ] Port the parser <!-- bid:aaaa1111 rank:1 -->
  Claimed: Mini 2026-09-25T04:30:00Z session:w22-p1
```

then commits and pushes. A task another computer holds is refused. When two
claims race, the store merge keeps the one that reached the remote first, and
the other call reports it as `heldBy`. `get_tasks` summaries show
`[claimed: <computer>]`; conductors skip tasks claimed elsewhere. Completing a
task clears its claim, `release: true` returns it to the Queue, and `force`
takes over a claim more than a day old. Phren versions older than claims drop
the `Claimed:` line when they rewrite `tasks.md`, so update every computer.

On the phone, hold a project or computer for 0.4 seconds to open the computer
chooser. It lists names, colors, reachability and project session counts, puts
reachable and recently used computers first, and offers the last-used computer.
Long lists are searchable; offline rows explain why they cannot open. The
Open agent accessibility action reaches the same flow. Harness, model and
effort choices follow the computer choice.

`dispatch` and `hand_off` take `account` for Claude accounts (`phren dispatch ... --account work`).
`anywhere` places only on a computer whose reported accounts include it, and lists the rest in
`skipped` with the reason. See [accounts](accounts.md).

## Siri and the Action button

The phone exposes three conductor shortcuts: Tell my conductor sends a line,
Ask my conductor sends a question and speaks the next reply, and What is Phren
doing reports working, waiting and idle sessions plus the conductor's current
step. They use the running conductor across connected computers. If none is
running, they ask the owner to open Phren and start one.

Ask waits up to 20 seconds and speaks up to 300 characters. A longer response
or one that arrives later remains in chat. Settings > Siri and the Action
button lists the phrases and opens Shortcuts, where one can be assigned to the
Action button. These use the existing Hook prompt and transcript paths.

## See what is running

```sh
phren dispatch sessions
```

`live_sessions` (MCP) and `phren dispatch sessions` list every live agent on
this computer and on each computer in this Hook's `hooks.yaml`, with project,
harness, status, role and the target `hand_off` takes. A peer that does not
answer is listed under `unreachable`; a `hooks.yaml` that cannot be read or
parsed leaves only this computer's agents and says why in `peerError`.
Computers in the store's `machines.yaml` with no link come back in `notLinked`.
A registered name is compared by its first DNS label, ignoring case, so
`Desk.local` and `Desk.example.net` are this computer when it is Desk, and a
peer matches through its name, address or the aliases its Hook reports. Names
sharing a first label are one entry with `aliases`.
Enrollment is one-way: a computer sees
only the peers in its own `hooks.yaml`, so a conductor on each computer needs
the others enrolled there too; Settings → Health on the phone and `phren status`
flag a link that runs only one way (see [Phren Hook](phren-hook.md#health-and-the-canary)).
A conductor starts in the phren store and has no
project; its Herdr name is `conductor` (or `conductor-<label>`).

For Codex's shared daemon, a lone pane launched with `codex resume <id>` can
recover a conversation created before the terminal started. Its matching
conversation must still be open in the daemon and have advanced since launch;
competing panes or multiple active older conversations leave it unresolved.
A newer conversation takes precedence over the original launch arguments.

```sh
phren dispatch usage
phren dispatch usage --json
```

`account_usage` (MCP) and `phren dispatch usage` read agent usage from this
computer and each computer in `hooks.yaml`, merged by account: one row per
Claude login, Codex, OpenCode, OpenCode Go, OpenRouter and GitHub Copilot, with
each window's percent used and left and its reset time, `leftPercent` (the least
room on any window), `nearLimit` (under 20% left), `exhausted` (a window at
100% or refusing requests, with `availableIn`), freshness (`age`, `stale`) and the computers where it is signed in. A window
whose reset passed says `reset` with no percent, and a report over 15 minutes
old is stale. Unreachable and unlinked computers are listed apart, as in
`live_sessions`: their usage is unknown, not zero. Fields are in the
[API reference](api-reference.md#account_usage).

### Choosing by usage

Check usage before dispatching. The one hard rule is never to dispatch to an
`exhausted` account (a window at 100%, or refusing requests). Low quota is
information, not a reason to steer away: the owner often wants quota used up
before it resets, so an account with quota left that resets soon is a good
pick. Name the choice in the dispatch line (for example "Codex has the parser
checks, using its last 15% before the week resets tomorrow"). When every
account is exhausted, tell the owner before sending work. The owner's explicit
choice of harness or account always wins. `anywhere` follows the same rule: it
skips a computer whose account for the dispatch is exhausted, and otherwise
ignores quota.

## Dispatch new work

```sh
phren dispatch Desk demo --harness codex --label Checks --prompt 'Run the assigned checks'
phren dispatch status
```

`dispatch` accepts an enrolled computer name, this computer's own name (its
hostname, the hostname's first label, its Bonjour name, or `local`) or
`anywhere`, a project slug, harness (`codex`, `claude`, `opencode`), optional
model, label and prompt. The receiving Hook resolves the project's checkout.
Callers do not pass a checkout path. This computer needs no `hooks.yaml` entry
and no SSH enrollment: its placement goes through its own Hook's socket, and
the returns loop reads its workers in process. `anywhere` chooses the least
busy responding computer, this one included, with names breaking ties. A
computer whose account for the dispatch (Codex's, or the named Claude home,
`default` when none) has no quota left sits out; low quota does not. Capacity preflight requires a compatible Hook and the configured Herdr
server. Peers that fail it sit out and are named with their reason in the
receipt's `skipped` list (and in the error when none is left). Placement
currently requires Herdr.

Each placement writes a private receipt in `<bridge>/dispatches/<id>.json`
without retaining the prompt. States are `launching`, `sending`, `accepted`,
`uncertain` and `failed`. `accepted` confirms first-prompt delivery, not worker
completion; completion arrives as a return (see [Returns](#returns)).

Before a Claude, Codex or Copilot worker starts, the receiving Hook marks the project's
resolved folder trusted for that harness (`PHREN_PRETRUST=off` turns this off;
see [footprint](footprint.md#folder-trust-for-launches-the-hook-places)), so the
folder-trust screen does not appear.

Claude and Codex workers start with the brief as their first prompt, so nothing
is typed into a starting pane. The receiving Hook writes the brief to
`<bridge>/briefs/<dispatch id>/brief.md` (0600) and starts the harness with one
short argument, `Read and follow the brief in <path>`; Claude also gets
`--add-dir` for that folder so reading it needs no permission. The pane's
environment carries `PHREN_DISPATCH_ID=<dispatch id>`, and the worker's
SessionStart and UserPromptSubmit hooks send it back: the receipt turns
`accepted` when the worker's own UserPromptSubmit names that id, never on a
text match. A Codex hook run by its shared app-server daemon ignores the
inherited variable and is matched by the brief path in the prompt instead. A
worker held on a startup screen (Claude's folder trust, a sign-in) keeps the
brief queued as its first prompt: the receipt is `uncertain` with a `needs-you`
return naming the pane, the Hook never answers that screen, and once the owner
does the harness submits the brief itself. An unconfirmed brief is asked about
again on each returns poll, so the receipt turns `accepted` when the worker
confirms it. Briefs are kept for seven days (at most 256).

### Copilot workers

`harness: "copilot"` starts GitHub Copilot CLI in the new pane, the same way the
phone's launch does. `model` goes to `--model` and `effort` to
`--reasoning-effort`. Copilot asks before every tool by default and has no
automatic reviewer, so `permissionMode` maps to its launch flags:

| Mode | Copilot flags |
|------|---------------|
| `supervised` | none (Copilot asks for each tool) |
| `auto-edits` | `--allow-tool=write` |
| `auto` | `--allow-all-tools` (file access stays inside the project folder; URLs still ask) |
| `full-access` | `--allow-all` (tools, paths and URLs) |

The grant and release-authority ceilings apply as they do to Claude and Codex.
Copilot takes no first prompt the Hook can confirm, so its brief is typed into
the pane once it reads ready (`brief: "typed"`), and the folder is pre-trusted
through `trustedFolders` in `~/.copilot/settings.json`. Its returns come from
its session log (`~/.copilot/session-state/<id>/events.jsonl`): the turn is done
at the `assistant.turn_end` that follows the reply marked `final_answer`, failed
on `session.error`, and interrupted on `abort`. Copilot has no accounts in the
Hook, and it cannot be a conductor.

A Codex worker runs on its own Phren-owned `codex app-server` instead (see
[Phren Hook](phren-hook.md#codex-panes-on-a-phren-owned-app-server)). The
receiving Hook starts the server, starts the thread in the project folder with
the dispatch's model and effort, and sends the brief text as the thread's first
turn; the receipt turns `accepted` on the server's acknowledgement of that turn
(its turn id), before the pane has even started. The pane then runs
`codex resume <thread> --remote unix://<socket>` and shows the brief already
running. The worker's approvals reach the phone as ordinary approval cards with
no 55-second hold, and the Hook records each finished turn's status for the
returns loop. When the server cannot start, the worker falls back to the
launch-argument path above.

An OpenCode worker gets its brief over its own HTTP API instead: the receiving
Hook starts it with `--port` and a server password, creates a session, sends the
brief, moves the TUI onto that session, and records the arrival (`accepted`
when the brief's user turn appears), so its receipt confirms like Claude's and
Codex's. If its server never answers, it is typed as below.

Copilot, and a receiving Hook too old to take the brief at launch, get it
typed as before, with a `deliveryId` of `dispatch-<id>` so the receiving Hook
types it at most once. A new agent that has not written a conversation yet
takes it on its starting binding, as the phone's first message does. One held
on a startup screen gets no brief: its receipt is `failed` with a `needs-you`
return naming the pane. An agent that never shows a target is `failed` with the
brief unsent and its pane left open. A typed brief that never shows (the pane
still idle on its starting binding) is typed once more under its own delivery
id, but only after the pane is read again: a conversation, or the agent
working, blocked or waiting, means the first copy landed late, and nothing is
typed twice. After two tries the receipt stays `uncertain` with a `failed`
return, and stays watched, so a brief that lands later still brings the
worker's own return. A lost acknowledgement leaves an uncertain receipt and is
never automatically retried. Receipts survive restart; interrupted placement
states are reported as uncertain. Only one placement (choosing a computer and
launching) runs at a time per service; confirming the brief runs outside it,
and a launch still being confirmed counts toward its computer's load for
`anywhere`.

An optional `parent` and `parentTarget` must be supplied together. The Hook
checks the parent against its own computer and live pane. Receipts retain the
remote computer's immutable ID and target. `/v1/subagents` projects those remote
leads and their local children, bounded to depth four and 128 rows, with public
computer identity and navigation descriptors rather than private checkout paths.
The phone uses its own enrolled connection to open a remote session.

Agent work puts running jobs first. Failed jobs remain visible for one hour
with their age and can be dismissed; dismissals persist on the phone. Counts
follow the visible rows. A refused permission reads Permission refused with
its type and pattern and a FAILED badge. Phone visibility does not change the
Hook's 24-hour archive policy. Remote rows retain their computer identity and
open chat, changes and questions through that computer's enrolled connection.

## Hand work to an existing session

```sh
phren hand-off local --session <session-id> --text 'Continue the review'
phren hand-off Desk --session <session-id> --text 'Review the tests'
```

`hand_off` takes exactly one of a complete `target` or a `session` to resolve
from the selected Hook's workspace overview. Omit `computer` for the local
Hook. A remote target must belong to the configured Herdr server. Delivery uses
the ordinary `/v1/prompt` path and returns `ok`, `delivered`, `target` and an
optional matching grant label. It does not launch a new agent. The MCP input
also accepts `project` for project-scoped grant matching.

`delivered: true` requires the harness to acknowledge the prompt, through its
submission hook or its API. A successful terminal paste and Enter alone leaves
`ok: false`, `delivered: false`, `deliveryUncertain: true`, including when a busy
pane may have queued the text. A Codex `resume --remote` composer can retain the
paste without submitting it. The Hook does not resend that text or press Enter
again for Codex. Inspect the pane before sending another hand-off. If the prompt
route reports `unsubmitted`, hand-off preserves that flag. An older Hook that
returns only `ok` cannot confirm delivery either.

A freshly dispatched session may appear before Herdr accepts prompts for its
named agent. On the explicit `agent_not_ready` refusal, the receiving Hook
retries every half second for up to 20 seconds. Each retry checks the same
conversation and terminal instance, its status and any input reservations.
A changed target or an input screen stops the retry. Once text may have reached
the pane, a lost reply or missing submission acknowledgement is never retried.

## Standing grants

Grants live in private `<bridge>/conductor.yaml`, outside the synced store.
A grant specifies `scope: global` or `project:<slug>`, one or both actions
`dispatch` and `hand_off`, optional computer names and an optional expiry.
Expired grants do not match. A computer restriction does not cover an
unspecified computer or `anywhere` before a peer has been selected.

`computers` accepts any name a computer answers to: its hooks.yaml name, its
hostname or Bonjour name, a peer's address, or a name machines.yaml registers
for it (see `GET /v1/computers` below). A grant for `Squids-Mac-mini.local`
matches a dispatch to `Mac`, the same computer. Adding a grant stores each name
as the computer's canonical one (the hooks.yaml name, or this computer's short
hostname) and keeps names it cannot resolve as written; `grants list` and
`GET /v1/conductor/grants` show canonical names, and grants already in the file
keep matching under their old spelling.

### Computers

`GET /v1/computers` returns one row per real computer:
`{ id?, name, aliases, profile?, local, linked, reachable? }`, this computer
first, then linked peers, then unlinked, alphabetical inside each group and at
most 64 rows. `name` is what `dispatch`, `hand_off` and grants accept. A
machines.yaml name joins a computer when its first label matches any name that
computer has, or when it shares a profile with names already folded into
exactly that one computer; a profile two computers claim folds nothing. Names
left over become unlinked rows, one per label or shared profile, shortest name
first. `reachable` is whether the peer's Hook answered its health read within
8 seconds; it is absent on unlinked rows. `live_sessions` reports the same
unlinked rows as `notLinked`.

The names a peer's own Hook reports about itself only label its row. A
reported name, or its first label, that another computer already answers to is
dropped, and grants match only names the owner wrote: this computer's own
names, hooks.yaml names and addresses, and machines.yaml. A name that two rows
answer to resolves to no computer.

```sh
phren conductor grants list
phren conductor grants add --scope project:demo --actions dispatch,hand_off --computers Desk
phren conductor grants remove --scope project:demo
phren conductor grants add --scope project:demo --actions dispatch --max-permission-mode full-access
```

A grant also caps the permission mode an agent may start a dispatched worker
in (`maxPermissionMode`: `supervised`, `auto-edits`, `auto` or `full-access`).
Without a grant, or with one that names no ceiling, an agent may ask for up to
`auto`; `full-access` needs a grant that names it. A call above the ceiling
fails with 403 before any receipt is saved. The owner, dispatching from the
phone or the CLI without a pane, is never capped. A grant that differs only in
its ceiling is the same grant: remove it and add it again to change the ceiling.

The phone exposes grants from conductor chat options. A conductor permission
card can approve once, allow for its project or allow everywhere. The latter
two save a grant and approve the pending call. Matching grants auto-approve
conductor permission callbacks; they do not enroll peers or grant general shell
access. Dispatch receipts and hand-off responses name the matching grant.

Hook routes are `GET`, `POST` and `DELETE /v1/conductor/grants`. Add sends the
grant object. Delete accepts an index or a scope; the phone includes the
expected grant with the index so a changed list returns 409 instead of removing
the wrong row. Mutations are serialized and locked across local processes.

Failed saves keep the grant editor open. Chat permissions use the provider's
asking sentence and ordered radio options, with action arguments folded under
Action details and terminal access in the header. Conductor grant choices use
the same phren controls as other permissions.

## Release authority

The owner's release authority policy (`<bridge>/authority.yaml`) says per
project which release actions (`merge`, `publish`, `deploy`, `app-store`,
`github-admin`) a conductor may send a worker to do on its own and which are
ask-first. Read it with the `authority` tool or `phren authority show
<project>`, quote its `line` in the brief, and declare the actions in
dispatch's `releaseActions`. An ask-first action is refused with 403 until the
owner confirms it; ask them. An ask-first project also lowers the permission
mode an agent may start its workers in. Only the owner changes the policy.

The policy only restricts. Lifting a worker's own permission checks, such as
Claude Code's auto mode refusing a merge or an App Store upload, is only
possible through the owner's own Claude Code settings (or Codex's and
OpenCode's own config); phren never installs permission rules for a worker.
See [authority.md](authority.md).

## Returns

```sh
phren dispatch returns
```

After placement the dispatching Hook follows each worker and records what
comes back. `dispatch_returns` (MCP) and `phren dispatch returns` list the
unread returns, oldest first, and mark them read. A return is one of:

- `done`: the worker finished its turn. `reply` is its final reply, from the
  harness's Stop hook or its transcript, capped at 4000 bytes (`truncated`
  when cut). `background` counts background tasks it left running (see below);
  a pane with one still running is not closed.
- `needs-you`: the worker finished by asking the owner something, or stopped
  mid-task. `question` is the question line, or why the turn is not done: its
  closing paragraph announced a step it never ran ("Let me install
  dependencies.", "I'll resolve it on the follow-up branch."), it waits on
  something with nothing left running ("Now waiting on CI.", "I'll push once
  it passes."), or it left tracked uncommitted files and reported or named no
  PR. A reply that hands over to the owner ("I'll wait for your review",
  "I'll leave the merge to you") is done. Uncommitted files are counted only in a
  checkout no other pane works in. A turn whose checkout git could not read
  in time is returned `done` but its pane is not closed, and one turn is
  returned once even when a later poll reads it differently.
- `failed`: the harness ended the turn on an error instead of a reply, such
  as Codex's usage limit, or the owner interrupted the turn in the worker's
  terminal. `error` is the message.
- `blocked`: the worker waits on terminal input, such as a permission prompt.
- `gone`: its pane closed or another conversation took the pane over.

Each row names the dispatch ID, computer, project, label and the worker's
`target`, so an answer or follow-up goes back with `hand_off`. A worker that
takes more work and finishes again produces a new return. The receipt keeps
the worker's last observed state in `worker` and the latest return in
`returned`, so `phren dispatch status` shows them too, and a finished lead
reads as completed in `/v1/subagents`.

The dispatch `label` is also the worker's session name: the receiving Hook
keeps it in `<bridge>/briefs/<id>/label` and shows it as the session's title
in place of the harness's own, which for a brief launch is only "Read and
follow the brief...". A session with background work still running is listed
as `working` with `backgroundTasks`, in `live_sessions` and on the phone.
The phone overview reads branch, model, current step and child activity in
separate bounded queues. A slow Git or model read cannot hide running agents.
The overview still answers within its five-second enrichment budget; a child
tree that finishes later is reused by the next read.

How it works: the receiving computer's Hook answers
`POST /v1/dispatch/workers` from what the worker's harness reported about its
own turns. Claude, Codex, Copilot and phren-agent send SessionStart,
UserPromptSubmit and Stop to the Hook, which keeps one small record per pane
(`turns/<server>/<pane>.json` beside the pane bindings): when the last prompt
was submitted, when the turn stopped, the Stop's final message and, from
Claude Code, how many background tasks (shells, subagents, monitors) were
still in flight. phren's OpenCode plugin stamps the same turn start and end
into its per-process status file. From that record:

- a submitted prompt with no Stop after it is `working`, however long the
  pane looks idle. If the pane is idle and the transcript shows the owner
  interrupted the turn (no Stop comes then), the return is `failed`; if the
  transcript shows a finished turn whose Stop never reached the Hook, it is
  `done`.
- a Stop after the prompt is `done` (or `needs-you`, or `failed` when the
  transcript shows the turn ended on an error). When background tasks were
  still in flight the worker stays `working`: the harness wakes it with a new
  prompt when a task ends, and that turn's Stop decides. A task whose
  task-notification the transcript records after the Stop no longer counts,
  even when no new turn follows (a notification can wait in an idle session's
  queue), and the worker is `done` once none is left. A worker still
  waiting on background work two hours after its Stop (a dev server it left
  running) counts as `done`, with `background` set. The tasks waited on are
  shells and monitors the turn started, and any started earlier that the
  agent looked at again since the last prompt (read its output, named its
  id): a dispatcher's message arriving mid-run does not turn the run into a
  leftover. A worker whose reply says it waits on a task ("Now waiting on the
  MacBook rerun.") stays `working` while any non-stream task still runs. The wait is measured from
  the latest Stop and every task that finishes wakes the worker with a new
  Stop, so it only runs out when no task has finished for two hours. The
  dispatching Hook remembers the most background tasks it saw the worker
  waiting on and, when the worker returns with none still running, sets
  `waited` and the notice reads "done (after 7 background tasks finished)". Older Claude Code builds
  leave the count out of Stop; the Hook then counts background tasks the
  transcript started and did not end.
- a conversation with no prompt yet has not taken its brief and stays
  `working`.

Only a record from the dispatched conversation, in the terminal still in the
pane, counts; when the worker's hooks named a `PHREN_DISPATCH_ID`, it must be
this receipt's. With no record (hooks not installed, an older Hook or plugin),
the Hook falls back to the Herdr snapshot it already shares with the phone
and the transcript readers: idle with a finished turn is `done` (or `working` while that turn left background
tasks running, a wait bounded at two hours as well: the dispatching Hook counts it from when it first saw the
worker waiting, and then returns `done` with `background` set), and idle
after being seen working is `done`. There is no time-based guess: a worker
never seen working with no finished turn stays `working` until the receipt's
24-hour watch ends.

The dispatching Hook asks each enrolled computer about all of its open
dispatches in one request, at most every 15 seconds, and follows a dispatch
for 24 hours or until the worker is gone. A computer that does not answer
records nothing; silence is never a transition. The receiving computer needs
the conductor module, as it already does for placement.

When `dispatch` is called by an agent running in a Herdr pane, the receipt
keeps that pane as `origin`. While that agent is idle, the Hook types one line
into it through the ordinary hand-off path, for example:

```text
Return: Linuxbox parser checks done, tests passed (dispatch <id>). Call dispatch_returns.
```

Several waiting returns share one line. The Hook never types into a working
or blocked agent, nor into a pane now running another terminal, and sends at
most one notice per pane every two minutes. A return recorded while the
dispatching agent was working is tried on every activity tick (5 seconds), so
the notice lands as soon as the agent stops rather than on the next poll. A
notice that was not delivered is tried again after the two-minute wait. Every
attempt carries the same `deliveryId`, so a first attempt that did reach the
pane is not typed twice. Returns stay unread until `dispatch_returns`
takes them, so a missed notice loses nothing.

Remote ancestry and phone navigation are wired independently through receipts
and `/v1/subagents`. There is no headless dispatch fallback: placement
requires Herdr on the receiving computer.

See [API reference](api-reference.md#cross-computer-dispatch) for fields and
[Fan-out workers](fanout.md) for the separate local worker manifest protocol.

## Worker approvals

A dispatched worker that hits a permission prompt is no longer stuck until
someone opens its computer. While a dispatching Hook follows a worker, each
poll keeps that pane's permission requests held on the worker's Hook for
about 45 seconds, and the Hook forwards what the worker waits on in its
`POST /v1/dispatch/workers` answer as `approval`: the tool, a short request
line and whether it is a terminal dialog (a trust prompt or a numbered choice
the pane draws itself). The request's full text is not sent.

The dispatching Hook records a new request as a `blocked` return whose
`question` starts with `Approval:`, and the row carries `approval` with its
`actionId`. `dispatch_approve` (MCP, `POST /v1/dispatch/approve`) answers it
with `approve` or `deny`; the answer goes to the worker's Hook through its
`/v1/approvals/answer`, which types the pane's own keys for a terminal dialog.
Your [standing grants](#standing-grants) already answer the `dispatch` and
`hand_off` requests they cover, on the dispatching computer, before any return
is recorded. When this Hook has a paired phone, it also pushes the request
there (unless the worker's Hook already pushed it), and the notification's
answer takes the same path.

Only the dispatching agent (or the owner's phone) can answer, and the call must
name the approval's `actionId`, so one that changed since you read it is
refused. The worker cannot approve itself: a `dispatch_approve` from its own
pane, or from any pane other than the dispatch's origin, fails with 403. A
worker dispatched from the phone or the CLI records no origin pane, so no
agent can answer for it; only the owner, calling without a pane, can. The pane
is the one the caller names, so this keeps agents apart on a trusted computer;
it is not a boundary against code that can already reach the Hook's socket.

A terminal dialog is answered only if the pane's screen, read just before the
keys are typed, still shows the same question and command that was forwarded.

A request that ends in the worker's terminal (answered there, or its hold ran
out) clears `approval`; answering one that is gone returns 409.


## Queued hand-off and stalled workers

`hand_off` uses the receiving Hook's durable queue. A busy worker returns
`{ok:true, queued:true, delivered:false, deliveryId, state:"queued", target}`.
The Hook waits for idle or done in the same conversation and terminal, then
attempts the message once. Keep `deliveryId` on any retry. Query it with
`hand_off(target|session, computer?, deliveryId, status:true)` and no text,
or `phren hand-off local --session <id> --status --delivery-id <id>`.
A local sender receives a queued delivery notice when the outcome changes.

The queue is private to the receiving computer under `<bridge>/hand-offs/`.
It survives service restarts and retains delivery tombstones for 7 days, so a
retried delivery id replays its outcome instead of typing again. Settled
records past that age are pruned, and the directory is capped at 512 records,
oldest settled first; a queued or attempting record is never pruned. The Hook writes
an attempting marker before input. A restart in the acknowledgement gap or
an unconfirmed input yields `state:"uncertain", deliveryUncertain:true` and
is never retried automatically. Only Herdr's `agent_not_ready`, which guarantees
no input was written, is retried at a later idle. A replaced conversation or
terminal produces a retained failed record. An offline worker remains queued.

Working sessions whose visible screen and transcript both stay unchanged for
`PHREN_STALL_MS` (default 300000, zero disables) carry `stalled:true`,
`stalledSince` and `stallFor` in seconds in the overview and `live_sessions`.
Their dispatch produces a `stalled` return with the same fields. Progress resets
the flag. Failed reads do not count as inactivity. Awaited background work
(a build, a running child agent) restarts the clock for at most two hours, so
work that never ends does not hide a stall. A stall is a supervision
signal; it does not interrupt the worker or authorize a replacement.

## Finish cleanup and PR-ready reports

Dispatches default to `closeOnFinish:true`. Pass `closeOnFinish:false` or CLI
`--keep-open` for a worker you will reuse. Reading a done return records a
pending close on the sender's Hook. The worker's Hook rechecks the conversation,
terminal and ended turn before closing only that pane. New work, background
work, queued messages and uncertain hand-offs keep it open. Offline close
requests remain pending across restarts. Intentional pane, tab and workspace
closes are recorded before the terminal action and never produce gone returns.

Before ending its turn, a worker calls `dispatch_report(prs)` or
`phren dispatch report --prs '<JSON array>'`. Each entry has `url` (HTTPS),
`repo` (`owner/name`), `branch`, `tests` (summary) and optional `notes`.
At most 16 PRs and 24000 UTF-8 bytes are accepted. The report belongs to that
submitted turn and terminal. It is evidence supplied by the worker, not a
verification by the Hook.

Configure the default integrator on the dispatching Hook with
`phren conductor integrator --session <id> [--computer <name>]`; show it with
`phren conductor integrator`, or clear with `--clear`. A dispatch can override
it with `integrator:{computer?,target}`. The Hook forwards a done return's `prs`
through the durable hand-off queue, with one stable delivery id. Receipts carry
`integratorDelivery:{deliveryId,state,at,integrator?}`. A saved pending delivery
keeps its original integrator target on retries, even if the default changes.
Queued forwarding is checked until
delivered; uncertain forwarding stays uncertain. A restarted integrator needs
its new target configured. Workers need no direct messaging or GitHub comment.

## Owner inbox

`owner_inbox(operation:"list")` and `phren owner-inbox list` show needs-you returns,
blocked prompts and manual items across the linked computers. The owning Hook
persists each item. An item's `inboxComputer` tells clients where to resolve it;
its `computer` can instead name the remote worker. Unreachable inboxes are
reported. `add` takes `title`, optional `project` and an optional stable UUID
`id` to keep on retries. `resolve` takes `id`, optional `computer` (the
`inboxComputer`, omitted for local) and optional `resolution`. CLI examples:

```sh
phren owner-inbox add "Restart the router" --project phren
phren owner-inbox list --all
phren owner-inbox resolve <id> --computer <name> --resolution "Restarted"
```

Reading dispatch returns does not resolve inbox items. Sources that disappear
remain open with `live:false` until resolved. Resolving does not approve or
answer an agent, and the same source stays resolved on later polls; a new
question creates a new item. The phone UI is a follow-up using the contract in
[Phren Hook](phren-hook.md#owner-inbox-phone-contract).

Task responsibility and stable-ID prerequisites are independent of Queue/Active/Done. See [the shared task contract](task-responsibility.md) for persistence, MCP/Hook fields, readiness and controls. Conductors select only ready agent tasks.
