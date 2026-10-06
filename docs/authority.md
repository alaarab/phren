# Release authority

The release authority policy lists, per project, which release-type actions a
conductor may send a worker to do on its own and which need the owner's word
each time. It only restricts. It never widens what a worker may do: lifting a
worker's own permission checks (Claude Code's auto mode, Codex approvals,
OpenCode permissions) is only possible through the owner's own harness
settings, never through phren.

## Lifting permissions

Phren does not install permission rules or auto-mode context into a worker.
When Claude Code's auto mode refuses a merge, release or App Store upload that
the owner wants, the owner changes their own Claude Code settings, for example
with `/permissions` in a session they run themselves. The same goes for Codex
(`~/.codex/config.toml` and its rules) and OpenCode (`opencode.json`). An agent
never edits those files for the owner.

## Design

**Where it lives.** `<bridge>/authority.yaml`, next to `conductor.yaml`: a
private regular file (0600, at most 64 KiB, never a symlink), on the computer
whose Hook places the dispatch. It is not in the synced store, so an agent
editing the store cannot change it, and each computer that conductors dispatch
from keeps its own copy.

```yaml
projects:
  example-project:
    default: ask                  # release actions not listed below
    maxPermissionMode: auto-edits # optional
  my-app:
    actions: { app-store: go }
    note: App Store work approved.
updatedAt: 2026-09-29T17:00:00.000Z
updatedBy: cli
```

Release-type actions are `merge`, `publish`, `deploy`, `app-store` and
`github-admin`. Each is `go` or `ask` per project. A project's `default`
(`go` unless set) covers the actions it does not list. A project not in the file
is `go` for everything: the policy restricts only what it names.

Without a file, nothing is restricted: every project is `go` for every release
action until the first write creates the file.

**Ask-first ceiling.** A project with any `ask` action lowers the #236
permission ceiling for workers an agent dispatches there: its own
`maxPermissionMode`, or `auto-edits` when it names none. The effective ceiling
is the lower of that and the conductor grant's. An agent's dispatch that names
a higher mode is refused with 403. One that names none starts the worker at the
ceiling, not at the receiving computer's default (Copilot included, through its
launch flags). OpenCode takes its
permissions from its own config and cannot be started lower, so an agent's
OpenCode dispatch to an ask-first project is refused.

**Release dispatches.** A dispatch declares the release actions its brief asks
for in `releaseActions`. An agent's dispatch that declares an `ask` action for
its project is refused with 403 unless the owner has confirmed it. The owner
confirms once, for one project and a set of actions, from the phone or with
`phren authority confirm`. A confirmation lasts 30 minutes by default (at most
24 hours) and is used up by the first agent dispatch it covers.

The owner's own dispatches (phone, or the CLI outside an agent pane) are not
checked, as with grants.

**Writes are the owner's.** Reads are open: `GET /v1/authority`,
`phren authority list|show`, and the read-only `authority` MCP tool the
conductor uses to cite the policy in briefs. Writes come from the phone
(`POST`/`DELETE /v1/authority`, `POST /v1/authority/confirm`) or from the CLI,
which asks the owner to type the project name at an interactive terminal and
refuses inside an agent's shell. The Hook refuses a write that carries an agent
pane. No MCP tool writes the policy.

**What this does not stop.** Agents run as the owner's user account, so an
agent that deliberately forges a phone request or edits the file can change it;
the same holds for `conductor.yaml` and approval answers. The policy is a
record of the owner's intent that honest agents follow and cite, backed by each
worker harness's own checks. `releaseActions` is declared by the conductor;
a brief that asks for a release without declaring it is not caught here, but
still meets the ceiling and the worker's own checks. `hand_off` to an existing
session is not checked yet.

## Use

```sh
phren authority list
phren authority show example-project
phren authority set example-project --default ask --max-permission-mode auto-edits
phren authority set my-app --go app-store --note "App Store work approved."
phren authority clear example-project
phren authority confirm example-project merge,deploy --minutes 30
```

`show` prints the project's entry as JSON; its `line` is the sentence a
conductor quotes in a brief, for example:

> Release authority for example-project (owner policy): ask-first for merge, publish,
> deploy, app-store, github-admin; dispatched workers start at most in
> auto-edits.

A dispatch receipt carries the same line as `authority`, plus
`authorityConfirmed` when an owner confirmation was used.

## Hook routes

- `GET /v1/authority` returns `{ source: "file" | "defaults", updatedAt?,
  updatedBy?, projects: [ProjectAuthority], confirmations: [Confirmation] }`.
  `GET /v1/authority?project=<slug>` returns `{ authority: ProjectAuthority }`
  for any slug (an unlisted one is all `go`).
- `POST /v1/authority` with `{ project, default?, actions?, maxPermissionMode?,
  note? }` replaces that project's entry (a field left out is cleared) and
  returns `{ ok, authority }`.
- `DELETE /v1/authority` with `{ project }` removes the entry.
- `POST /v1/authority/confirm` with `{ project, actions, minutes? }` saves a
  one-time confirmation and returns `{ ok, confirmation }`.

`ProjectAuthority` is `{ project, listed, go, ask, maxPermissionMode?, note?,
line }`. A write that carries `origin` (an agent pane) gets 403.
