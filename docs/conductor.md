# Conductor

A conductor is an agent session that sends bounded work to other sessions.
The optional `conductor` module supplies `dispatch`, `hand_off`, standing
grants and the shipped conductor brief. It requires `memory` and `hook`.

```sh
phren modules enable conductor
phren bridge update
```

Restart Hook and MCP after enabling the module. Full MCP exposes both tools;
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

The Hook checks its Herdr servers for an existing conductor before launching
another and returns 409 with the existing target when one is found. This is a
check on that computer's Hook; it is not a distributed lock across computers.
The phone also offers an existing conductor it can associate with the store.
Workspace overviews and chat show the conductor role.

## Dispatch new work

```sh
phren dispatch Desk demo --harness codex --label Checks --prompt 'Run the assigned checks'
phren dispatch status
```

`dispatch` accepts an enrolled computer name or `anywhere`, a project slug,
harness (`codex`, `claude`, `opencode`), optional model, label and prompt. The
remote Hook resolves the project's checkout. Callers do not pass a checkout
path. `anywhere` chooses the least busy responding peer, with names breaking
ties. Capacity preflight requires a compatible Hook and the configured Herdr
server. Placement currently requires Herdr.

Each placement writes a private receipt in `<bridge>/dispatches/<id>.json`
without retaining the prompt. States are `launching`, `sending`, `accepted`,
`uncertain` and `failed`. `accepted` confirms first-prompt delivery, not worker
completion. A lost acknowledgement leaves an uncertain receipt and is never
automatically retried. Receipts survive restart; interrupted placement states
are reported as uncertain. Only one placement runs at a time per service.

An optional `parent` and `parentTarget` must be supplied together. The Hook
checks the parent against its own computer and live pane. Receipts retain the
remote computer's immutable ID and target. `/v1/subagents` projects those remote
leads and their local children, bounded to depth four and 128 rows, with public
computer identity and navigation descriptors rather than private checkout paths.
The phone uses its own enrolled connection to open a remote session.

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

## Implemented adapters that are not wired into placement

The repository includes tested headless receiver, report/outbox and question
relay components. The running Hook does not currently connect these adapters
to dispatch placement. There is no live headless fallback or automatic report
return to the parent through those components. Remote ancestry and phone
navigation are wired independently through receipts and `/v1/subagents`.

See [API reference](api-reference.md#cross-computer-dispatch) for fields and
[Fan-out workers](fanout.md) for the separate local worker manifest protocol.
