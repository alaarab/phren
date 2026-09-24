# Conductor

A conductor is an agent session that sends bounded work to other sessions.
The optional `conductor` module supplies `dispatch`, `dispatch_returns`,
`hand_off`, `live_sessions`, standing grants and the shipped conductor brief.
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

## Launch a conductor

The phone launch sheet offers an Agent or Conductor role, a harness, model and
effort. `POST /v1/workspaces/launch` accepts `role: "conductor"` with Claude,
Codex or OpenCode, loads the shipped brief and gives Herdr an agent name
starting with `conductor-`. Effort is `low`, `medium` or `high`.

An agent (not a conductor) can start in a new worktree. The sheet's Work in a
new worktree switch is off by default; turned on, it takes a branch name,
suggested from the task's first line or `phren/<short-id>`. The Hook sends
`worktree: { branch }` to `git worktree add`, from the project's current HEAD
into `<repo>/.claude/worktrees/<name>`, and starts the agent there. It refuses
a folder that is not a Git repository and a branch that already exists, with a
message the phone shows. The worktree then appears in the session's Changes >
Workers tab, named for the agent working in it.

The Hook checks its Herdr servers for an existing conductor before launching
another and returns 409 with the existing target when one is found. This is a
check on that computer's Hook; it is not a distributed lock across computers.
The phone also offers an existing conductor it can associate with the store.
Workspace overviews and chat show the conductor role.

On the phone, hold a project or computer for 0.4 seconds to open the computer
chooser. It lists names, colors, reachability and project session counts, puts
reachable and recently used computers first, and offers the last-used computer.
Long lists are searchable; offline rows explain why they cannot open. The
Open agent accessibility action reaches the same flow. Harness, model and
effort choices follow the computer choice.

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
busy responding computer, this one included, with names breaking ties. Capacity preflight requires a compatible Hook and the configured Herdr
server. Peers that fail it sit out and are named with their reason in the
receipt's `skipped` list (and in the error when none is left). Placement
currently requires Herdr.

Each placement writes a private receipt in `<bridge>/dispatches/<id>.json`
without retaining the prompt. States are `launching`, `sending`, `accepted`,
`uncertain` and `failed`. `accepted` confirms first-prompt delivery, not worker
completion; completion arrives as a return (see [Returns](#returns)). A lost acknowledgement leaves an uncertain receipt and is never
automatically retried. Receipts survive restart; interrupted placement states
are reported as uncertain. Only one placement runs at a time per service.

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

## Standing grants

Grants live in private `<bridge>/conductor.yaml`, outside the synced store.
A grant specifies `scope: global` or `project:<slug>`, one or both actions
`dispatch` and `hand_off`, optional enrolled computer names and an optional
expiry. Expired grants do not match. A computer restriction does not cover an
unspecified computer or `anywhere` before a peer has been selected.

```sh
phren conductor grants list
phren conductor grants add --scope project:demo --actions dispatch,hand_off --computers Desk
phren conductor grants remove --scope project:demo
```

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

## Returns

```sh
phren dispatch returns
```

After placement the dispatching Hook follows each worker and records what
comes back. `dispatch_returns` (MCP) and `phren dispatch returns` list the
unread returns, oldest first, and mark them read. A return is one of:

- `done`: the worker finished its turn. `reply` is its final reply, read from
  its transcript and capped at 4000 bytes (`truncated` when cut).
- `needs-you`: the worker finished by asking the owner something. `question`
  is the question line.
- `failed`: the harness ended the turn on an error instead of a reply, such
  as Codex's usage limit. `error` is its message.
- `blocked`: the worker waits on terminal input, such as a permission prompt.
- `gone`: its pane closed or another conversation took the pane over.

Each row names the dispatch ID, computer, project, label and the worker's
`target`, so an answer or follow-up goes back with `hand_off`. A worker that
takes more work and finishes again produces a new return. The receipt keeps
the worker's last observed state in `worker` and the latest return in
`returned`, so `phren dispatch status` shows them too, and a finished lead
reads as completed in `/v1/subagents`.

How it works: the receiving computer's Hook answers
`POST /v1/dispatch/workers` from the Herdr snapshot it already shares with the
phone and its activity tick, and reads a stopped worker's final reply through
the transcript readers. It keeps no state about the dispatch. The dispatching
Hook asks each enrolled computer about all of its open dispatches in one
request, at most every 15 seconds, and follows a dispatch for 24 hours or
until the worker is gone. A computer that does not answer records nothing;
silence is never a transition. The receiving computer needs the conductor
module, as it already does for placement.

When `dispatch` is called by an agent running in a Herdr pane, the receipt
keeps that pane as `origin`. While that agent is idle, the Hook types one line
into it through the ordinary hand-off path, for example:

```text
Return: Linuxbox parser checks done, tests passed (dispatch <id>). Call dispatch_returns.
```

Several waiting returns share one line. The Hook never types into a working
or blocked agent, nor into a pane now running another terminal, and sends at
most one notice per pane every two minutes. A notice that was not delivered
is tried again after that wait. Returns stay unread until `dispatch_returns`
takes them, so a missed notice loses nothing.

Remote ancestry and phone navigation are wired independently through receipts
and `/v1/subagents`. There is no headless dispatch fallback: placement
requires Herdr on the receiving computer.

See [API reference](api-reference.md#cross-computer-dispatch) for fields and
[Fan-out workers](fanout.md) for the separate local worker manifest protocol.
