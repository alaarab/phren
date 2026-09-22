# Conductor on the phone

Status: design for a later worker. The first CLI slice adds enrollment and
placement only. No Swift implementation ships with it. The backend contracts and
worker ownership live in [Conductor](../../../docs/conductor.md).

## Experience

The owner keeps one conductor chat open. Dispatch and return messages are single
lines with computer, brief, harness/model and expected report time, or the test
and merge result. Remote questions appear as Background rows and open the same
answer controls already used by that computer's chat. No implementation details
are added to the owner's dispatch flow.

Agent work and the agents drawer show remote leads under the conductor. Each
remote row has its task label, existing provider/model/status details, and a
computer chip such as `Linuxbox`. Its local fanout children remain nested beneath
it. Keep the existing running-only work sheet; completed work returns in the
chat. A selected transcript can remain open after that row finishes. Use computer
name in accessibility labels; color alone must not convey computer identity.

Example tree:

```text
Desk / Conductor
  Parser checks                 Codex       [Linuxbox]
    Parser fixtures             Codex       [Linuxbox]
    Compatibility               OpenCode    [Linuxbox]
  Navigation checks             Codex       [Desk]
```

Do not also insert a remote child as another local conductor session. Normal
computer/workspace browsing can still show the same remote lead independently.
Selection keys include computer identity and the parent-scoped child ID, so two
machines using the same session or workspace IDs cannot steal each other's row.

## Wire contract and routing

Keep existing local `AgentChild` decoding. New optional fields:

```text
computer: { id: <Hook computer-id UUID>, name: "Linuxbox" }
remote: { target: <full remote session Target>, child?: <remote child ID> }
```

The public row ID is scoped to the conductor; `remote.child` is scoped to the
remote lead. They are not interchangeable. A lead row has no `remote.child`, and
opens ordinary transcript/status/history on `remote.target`. A nested fanout row
opens the remote lead target with that remote `child` parameter, retaining the
Hook's parent validation. Diff, image and answer requests use the resolved remote
connection as well; never use the conductor's host with a remote child ID.

Persist the verified `/v1/health.computer.id` alongside each enrolled `LiveHost`.
`LiveHost.id` is currently a phone-local identifier, so do not compare it directly
to the Hook's ID. Resolve the descriptor through this association, then use that
host's pinned address, fingerprint, mux/server and `DeviceSSHKey`. For a target's
nondefault Herdr server, preserve the target server when scoping requests.
`GatewayConnections` already keys reuse by host, address, port, user, pin and
device key; continue to use it. A child row supplies no new address or credential.

Add a single typed destination resolver used by transcript, history, images,
changes and question navigation. `ChildAgentTranscriptView` currently always
uses the parent session's host, so replace that assumption there and at its
Changes destination. `AgentWorkspaceTree` and `ChatSubagentsView` share the
resolver and chip rendering. Keep provider parsing in PhrenKit and SSH behavior
in PhrenLive. Update fixtures from CLI wire examples, not from a user's store.

## Unavailable connections and questions

An unknown computer keeps its row and offers the existing Add computer flow.
The phone enrolls its own device key; trusting the conductor computer does not
trust the phone on a remote computer. Never enroll or accept a new host pin from
a tree descriptor. Duplicate computer names require identity matching, not a
first-name match. A changed pin uses the existing connection-stopped state.

An offline computer shows its last known worker state with an unavailable label.
Retry reopens reads; it never redispatches work. Starting leads may show Starting
until the backend has a verified session target. Do not synthesize a session ID
or attach to the newest transcript in that folder.

Background returns retain `phrenBackground` and the existing task-notification
allowlist. Report body truncation opens the actual remote transcript for details.
Questions use the same exact Codex call IDs, Claude approval IDs/updatedInput,
or terminal answer keys as an ordinary remote chat. If another device answers,
refresh removes the pending controls. Unknown delivery remains visible; an answer
button must not automatically resend. The phone does not mark a turn-complete
worker's changes merged unless the conductor reports verified integration.

## Worker D acceptance

Own AgentChild models/fixtures/tests in PhrenKit; descriptor resolution and SSH
tests in PhrenLive; Agent work/drawer/navigation changes under
`Phren/Features/Agents`. Develop against optional-field fixtures independently
of report delivery. Coordinate only the wire fixtures with backend worker C.

Required checks:

- Old local children decode and navigate unchanged; old Hooks need no upgrade
  for their existing local tree.
- Same session/child IDs on Desk and Linuxbox remain distinct and stable through
  refresh, disappearance, and return. Nested descendants route with the remote
  lead's child ID and target server.
- A two-server `ChatRelaySSH` fixture proves transcript/history/diff use the
  remote phone key and pin, and refuse an unknown host or changed key. Follow
  `PhrenHookEndToEndTests` for an opt-in inert receiver test.
- Offline/unknown computer, startup waiting, completed selected transcript,
  question answered elsewhere, and uncertain answer all remain understandable.
- Simulator checks cover chips, VoiceOver labels, drawer selection, Background
  returns and exact answer actions. Run affected Swift package and simulator
  tests on the authorized worker. Do not enable automatic iOS CI.

## Conductor as a role you launch (owner, September 21)

Owner's words: "I want to be able to choose which provider my conductor is
set to, or model or whatever", "how do I distinguish it from the rest".

### Launching

The launch flow gains a **Role** row above Harness: a `PhrenSingleSelect`
with two values, "Agent" (default) and "Conductor". Harness, computer and
model stay free choices for both roles, so a conductor can be Claude Opus,
Codex Sol or an OpenCode Go model. Under Conductor the model row shows an
**Effort** drop-down when the harness supports one (Claude `--effort
low|medium|high`, Codex reasoning through `-c model_reasoning_effort`,
OpenCode `--variant`), default medium. Ids: `launch-role`,
`launch-role:agent`, `launch-role:conductor`, `launch-effort`,
`launch-effort:<level>`.

The phone remembers the last conductor choice (harness, model, effort) per
store so the next launch is one tap; the row reads "Conductor · Claude Opus
· medium" until changed.

### What the Hook does with it

`/v1/workspaces/launch` accepts `role: "conductor"` and `effort`. For a
conductor it starts the harness with the conductor brief attached and the
concise voice on: Claude gets `--append-system-prompt <brief> --effort
<level>`, Codex gets the brief as its first system message through
`-c` developer instructions plus the effort config, OpenCode gets
`--agent conductor` (a generated agent file under
`~/.config/opencode/agents/conductor.md` the Hook writes from the same
brief) plus `--variant`. The brief is the shipped
`starter/global/skills/conductor/SKILL.md` body. The Hook records the role
in the pane's Herdr agent name (`conductor-<label>`) and reports
`role: "conductor"` on the tab in the overview, so nothing depends on the
harness's own session files.

### Telling it apart

- **Agents list**: the card's glyph is the dispatch mark (a baton:
  `wand.and.rays` in PhrenTheme accent) inside the provider ring, the title
  line reads "Conductor" before the session title, and the card is pinned
  first in Working. Remote leads nest under it with computer chips.
- **Lock screen line**: the same glyph replaces the provider glyph; the
  step column reads "N leads on M computers".
- **Chat**: the header shows the baton and "Conductor"; replies stay the
  one-line dispatch log the skill prescribes.
- One conductor per store at a time; launching a second offers to open the
  running one instead.

### Ids and tests

`conductor-card:<key>` on the card marker, `chat-conductor-mark` in the
header, `launch-role*` and `launch-effort*` above. One UI test: launch a
conductor with the fixture, see the card pinned with the mark, open its
chat, see the header mark. No accessibility-size tests.

## Grants

Standing conductor authorizations live in the Hook's `conductor.yaml` and are
reached from the conductor chat's ellipsis sheet: a **Grants** link, shown only
for a conductor session, opens a list of rows. Each row reads the scope
("Everywhere" or the project name), one PhrenChip per action ("Dispatch",
"Hand off"), the computers (or "Any computer") and the expiry, or "Until
revoked". An **Add grant** row opens a PhrenScreen editor with scope (Everywhere
or a project), actions, optional computers and an optional `PhrenDateField`
expiry; Save posts to `/v1/conductor/grants`. Each grant's **Revoke** button
opens a confirm dialog before DELETE by list index.

Ids: `conductor-grant:<n>` on each row, `conductor-grant-add` on the add row,
`conductor-grant-revoke:<n>` on each revoke button, and
`conductor-grant-add-cancel` / `conductor-grant-add-save` from
`PhrenSheetHeader`'s identifier prefix.

A conductor approval card whose Hook payload carries `conductor` also shows
**Allow for this project** (`chat-approval-allow-project`, hidden when the
call has no project) and **Allow everywhere**
(`chat-approval-allow-everywhere`) above Approve and Deny. Both approve this
call and write the grant through the Hook's `answer` path.

Fixture: `--conductor-grants-fixture` supplies two grants (one global
dispatch, one `project:phone` dispatch + hand off on Desk with an expiry).

### Siri and the Action button (owner, September 21; stage three)

One App Intent, `TellConductorIntent`, with a spoken `message` parameter:
Siri phrase "Tell my conductor …", also exposed in Shortcuts so the Action
button on the side of the phone can run it. It sends the message to the
running conductor's session through the Hook (`/v1/prompt`), launching one
with the remembered choice when none runs, and speaks back the conductor's
first line (the dispatch log line) through the intent's dialog. When the
conductor asks a question, the intent returns it as the dialog and the next
"Tell my conductor …" answers it. No new screens; Settings gains one row
"Conductor" with the remembered harness, model, effort and a "Add to Siri"
button (`SiriTipView` is Apple's; use phren's own row that opens the
Shortcuts app deep link). Ids: `settings-conductor`, `settings-conductor-siri`.
