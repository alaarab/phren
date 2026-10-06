# Conductor role and linked computer sets (design note)

Status: implemented in the Hook and CLI. The phone screens are a follow-up
(contract at the end).

## Problem

Until now the Hook read the conductor role from the multiplexer: a pane whose
Herdr agent name (or, on tmux, its `@phren_agent` pane option) was
`conductor` or `conductor-*` was the conductor. When the owner logged out of
Claude and back in, Herdr registered the restarted agent without that name and
the phone dropped the badge. Linked computers also shared exactly one
conductor, although the owner runs several separate groups of computers.

## Decisions

1. **The Hook owns the role.** `<bridge>/conductor-role.json` (0600) holds this
   computer's conductor as `{ server, pane, terminal, source, session?,
   workspace, tab, since, by }`. `by` is `launch`, `owner` or `migrated`.
   Nothing else decides the role: the overview's `role: "conductor"`,
   `GET /v1/conductor`, `live_sessions` and the launch refusal all read it.
2. **The role follows the pane, not the process.** A pane is its server, pane
   id and terminal id (`terminal_id`: Herdr's terminal instance, on tmux the
   pane id plus its shell's pid). When the agent in that pane exits and a new
   one starts (a restart, `/login`, a new conversation), the role reattaches
   and the new session id is recorded. A pane that is gone from its server's
   snapshot, or whose terminal id changed (a reused id), ends the role. A
   server that is not running keeps the record until it answers again.
3. **One conductor per computer.** A computer belongs to one set, and a set has
   one conductor, so one record per Hook is enough.
4. **The mux name is a label.** Launches still name a conductor `conductor-*`
   and never give a worker such a name, so a person reading Herdr or tmux, and
   an older Hook, see the same thing as before. Make and stop do not rename
   anything.
5. **Migration.** While `conductor-role.json` does not exist the Hook behaves
   as before: a live pane with a conductor name is the conductor, and the first
   time the Hook sees one it writes the file (`by: "migrated"`). From then on
   names are ignored. A launch, make or stop also writes the file.
6. **A link is two-way.** Computer A links B when B is in A's `hooks.yaml`.
   `phren bridge link` writes both sides; a one-way entry is a broken link
   (returns and permission requests cannot come back).
7. **A set is a connected group of two-way links.** The Hook builds its view
   from itself and one hop: each `hooks.yaml` peer answers `GET /v1/conductor`
   with its conductor, its own peer names, whether it lists the caller, and
   the set name it holds. A member known only through a peer is listed with
   `link: "indirect"` and a hint to link it directly. A peer that does not
   list this computer back (`link: "one-way"`) is shown in its own set. A peer
   that cannot be reached, or whose Hook is too old to say, is treated as a
   member (`link: "unknown"`), as before. When a peer uses a friendly name
   for this computer (for example, `Devbox` for hostname `workstation`), the
   Hook resolves unresolved names through that peer's `/v1/computers`
   directory. A matching computer id folds the name into the `self` row,
   which displays the friendly name and never carries a link hint. Name
   similarity alone does not establish that identity.
8. **One conductor per set.** Launching or making a conductor is refused (409)
   when this computer or a member already has a live one. One-way peers are
   outside the set and do not refuse. A member that cannot answer, or an
   indirect member this Hook cannot ask, does not block; it is named in
   `unchecked`, as the launch result already did.
9. **A conductor dispatches only within its set.** When the dispatching pane is
   this computer's conductor, each candidate's capacity answer says whether it
   lists this computer back. A named computer that does not is refused with a
   message naming `phren bridge link`; `anywhere` skips it and lists it in
   `skipped`. Hooks too old to say are allowed.
10. **Set names are shared by every member.** `POST /v1/sets/name` stores the
    name with a timestamp and sends it to each reachable member; a Hook keeps
    the newest name it has seen, and the view shows the newest among members.
    The set id is `set:` plus the smallest computer id among its members.
11. **Linking stays with `phren bridge link`.** The set view points to it; it
    does not link or unlink.

## Hook routes

All under the `conductor` module.

| Route | Purpose |
|---|---|
| `GET /v1/conductor?name=&hostKey=` | This computer's live conductor (`conductor`), plus `computer`, `peers` (its `hooks.yaml` names), `knowsCaller` when asked with the caller's name or host key, and `set` (`{ name, namedAt }`). Peers ask this. |
| `GET /v1/sets` | `{ sets, unlinked }`, described below. |
| `POST /v1/conductor/make` | `{ workspaceId?, tabId?, paneId }` (and `?mux=`): make that live agent pane this computer's conductor. 409 with `computer` and `target` when the set already has one; making the current conductor again is a no-op. |
| `POST /v1/conductor/stop` | Ends this computer's conductor role. Optional `{ paneId }` must match. Returns `{ ok, stopped }`. |
| `POST /v1/sets/name` | `{ name }` (1 to 60 characters, or `null` to clear). Returns `{ ok, name, told, unreachable }`. |

`GET /v1/sets`:

```json
{
  "sets": [{
    "id": "set:1c1f...",
    "name": "Home",
    "local": true,
    "computers": [
      { "name": "Workstation", "id": "...", "local": true, "reachable": true, "link": "self" },
      { "name": "Mini", "id": "...", "reachable": true, "link": "two-way", "conductor": { "target": { "server": "default", "workspace": "w1", "tab": "w1:t1", "pane": "w1:p1", "source": "claude", "session": "..." } } },
      { "name": "Desk", "reachable": false, "link": "unknown", "error": "..." },
      { "name": "Old", "reachable": true, "link": "unknown", "hint": "Its Hook cannot say whether it links back. Update it with phren bridge update." },
      { "name": "Server", "reachable": true, "link": "indirect", "hint": "Link it with phren bridge link Server." }
    ],
    "conductor": { "computer": "Mini", "target": { "...": "..." } },
    "conductors": 1
  }, {
    "id": "set:9ab0...",
    "local": false,
    "computers": [{ "name": "Laptop", "reachable": true, "link": "one-way", "hint": "Laptop does not link back. Run phren bridge link Laptop." }]
  }],
  "unlinked": [{ "name": "server.example.com", "aliases": [], "profile": "server" }]
}
```

`conductors` above 1 means two conductors were started before the sets met
(for example, two groups linked later); the view shows both and the owner
stops one.

### Who may change the role

`/v1/conductor/make` and `/v1/conductor/stop` trust their caller the way every
other Hook route does: anything that reaches this computer's Hook socket, and a
linked computer over its verified SSH pipe, acts as the owner. They do not
check that the caller is the pane it names, and a stop with no `paneId` ends
whichever role is held. So the role keeps agents from mistaking one another for
the conductor. It is not a boundary against code that can already reach the
socket.

`conductor-role.json` has one writer, the Hook, and every read-modify-write of
it runs one at a time, so a poll that notes a moved pane cannot bring back a
role a stop just ended. The file is read only when it is a regular file of at
most 64 KiB; anything else counts as no conductor.

## CLI

```sh
phren conductor status            # this computer's conductor and its set
phren conductor make [--pane <id>] [--mux herdr:<name>|tmux:<name>]   # defaults to the current pane
phren conductor stop
phren conductor sets [--json]     # every set, its computers, reachability and conductor, plus unlinked computers
phren conductor sets name "Home"    # or --clear
```

## Phone contract (follow-up)

- Feature check: `GET /v1/health` `capabilities.conductorSets === true`.
- Computers screen: group rows by `GET /v1/sets`. Show the set name (or the
  computers' names when unnamed), each computer's reachability and `link`
  state with its `hint`, and the conductor badge on the computer that has one.
  Put `unlinked` last with the hint to run `phren bridge link` on a computer.
- Computer identity: use `id` when present; `name` is a display label and can
  change from a hostname to the friendly name its peers use. The local row
  keeps `local: true`, `reachable: true` and `link: "self"`, with no `hint`.
  Its conductor and the set's `conductor.computer` use the same display name;
  folding an alias does not add to `conductors`. The response shape is
  unchanged. Shared example:
  `packages/cli/fixtures/conformance/sets-local-friendly-name.json`.
- Loading: unresolved peer names may require a second parallel SSH round to
  `/v1/computers` (up to 12 seconds after the conductor replies, themselves
  bounded by 8 seconds). Known names skip this round. A missing or offline
  identity directory retains the name-only view.
- Rename set: `POST /v1/sets/name` on any reachable member of that set.
- Session menu: "Make conductor" posts `/v1/conductor/make` to the session's
  computer with its workspace, tab and pane ids; a 409 shows the message and
  offers to open the existing conductor from `target`. "Stop being conductor"
  posts `/v1/conductor/stop` with the pane id.
- The overview's `role: "conductor"` keeps its shape and now survives a
  restart in the same pane.
