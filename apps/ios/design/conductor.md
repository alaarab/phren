# Conductor on the phone

Conductor launch, grants, remote worker navigation and Siri controls are
implemented. Placement still requires Herdr; headless report and question
adapters are separate backend components and are not wired into placement.
See [Conductor](../../../docs/conductor.md) for that boundary and
[controls.md](controls.md) for the shared phren controls.

## Launch and identity

Open **Agents** and tap **Start a conductor**, pinned above session search. It
opens the launch sheet with **Conductor** selected and restores the store's last
harness, model, effort and successfully used computer. With several stores the
row names its destination store and the sheet's **Store** choice changes it. A
running conductor's card replaces that row in the same slot, and its chat
header carries **Grants** as its own control.

The launch sheet puts Role above Harness, with Agent as the default and
Conductor as the other choice. Computer, harness and model remain explicit.
Conductor effort is low, medium or high, defaulting to medium. The phone
remembers its conductor harness, model and effort per store.

`POST /v1/workspaces/launch` accepts `role: "conductor"` and `effort`, attaches
the shipped conductor brief, and records the role in Herdr's
`conductor-<label>` agent name. The overview reports that role to the phone.
Hook checks its own Herdr servers before launching a second conductor and
returns the existing target with 409. The phone also offers the running
conductor it can associate with the store. This is not a distributed lock.

The conductor uses the dispatch mark (`wand.and.rays`) with its provider ring,
is pinned ahead of ordinary working sessions, and retains the same identity
in chat and on the Lock Screen. Computer identity remains text as well as color.

Identifiers: `launch-role`, `launch-role:agent`, `launch-role:conductor`,
`launch-effort`, `launch-effort:<level>`, `conductor-card:<key>` and
`chat-conductor-mark`.

## Agent work across computers

Agent work and the agents drawer show a conductor's remote leads and their
nested workers. Each row retains its task, provider, model, status and computer
chip. Running work comes first. Failures stay for one hour with their age and
can be dismissed; dismissals persist. Header counts use the visible rows.
A refused permission says Permission refused, shows its type and pattern,
and carries a FAILED badge in the warning color, including in the child chat.
This display policy does not change the Hook's 24-hour archive policy.

```text
Desk / Conductor
  Parser checks                 Codex       [Linuxbox]
    Parser fixtures             Codex       [Linuxbox]
    Compatibility               OpenCode    [Linuxbox]
  Navigation checks             Codex       [Desk]
```

Rows carry optional `computer: {id, name}` and
`remote: {target, child?}` descriptors. The public row ID is scoped to the
conductor; `remote.child` is scoped to the remote lead. A lead opens ordinary
transcript/status/history on `remote.target`; a nested worker adds its remote
child ID. Changes, images and questions use the same remote destination.

The phone matches the verified Hook computer ID to its enrolled connection,
then uses that connection's key, pinned address and fingerprint. A worker row
cannot supply new credentials or enroll a computer. Preserve a target's Herdr
server when routing, and include computer identity in row and selection keys.
Identical session IDs on Desk and Linuxbox must stay distinct.

## Unavailable connections and answers

An unknown computer keeps its row and offers Add computer. The phone enrolls
its own device key separately from the conductor's peer enrollment. An offline
computer keeps its last known state with an unavailable label. Retry repeats
reads, never dispatch. A changed pin uses the connection-stopped state.

A starting lead waits for its verified session target. A selected transcript
can remain open after its work finishes. Questions retain exact Codex call
IDs, Claude approval IDs and updated input, or terminal answer keys. Refresh
removes questions answered elsewhere. Uncertain answer delivery stays visible
and does not automatically resend. A finished worker is not called merged
unless the conductor reports verified integration.

## Grants

Grants opens from the conductor chat's phren action sheet. Rows show scope,
action chips, computers or Any computer, and an expiry or Until revoked.
Add grant opens a PhrenScreen editor for scope, actions, optional computers
and an optional PhrenDateField expiry. A failed save leaves the editor open.
Revoke uses PhrenDialog, then sends both the row index and expected grant;
a stale list returns 409 instead of deleting a different grant.

The routes are GET, POST and DELETE `/v1/conductor/grants`; grants remain in
private `conductor.yaml` on the computer. They authorize dispatch or hand-off,
not arbitrary commands or peer enrollment.

Permission cards keep the provider header, asking sentence and ordered
PhrenOptionRow choices. Arguments are folded under Action details through
PhrenDisclosure, and terminal access stays in the header. When supported,
Allow for this project and Allow everywhere approve the pending call and save
the matching grant. The fallback order is Approve, Allow for this project,
Allow everywhere, Deny; unavailable grant scopes are disabled.

Identifiers: `conductor-grant:<n>`, `conductor-grant-add`,
`conductor-grant-revoke:<n>`, `conductor-grant-add-cancel`,
`conductor-grant-add-save`, `chat-approval-allow-project` and
`chat-approval-allow-everywhere`. `--conductor-grants-fixture` supplies a global
dispatch grant and a project dispatch/hand-off grant on Desk with an expiry.

## Siri and the Action button

Three App Intents find the first live conductor across connected computers.
They use the ordinary Hook prompt and transcript paths without opening the app.

| Intent | Behavior |
| --- | --- |
| Tell my conductor | Sends a spoken line and names the receiving computer. |
| Ask my conductor | Sends a question, waits up to 20 seconds and speaks the next assistant line's first 300 characters. If it is still thinking, points to chat. |
| What is Phren doing | Speaks working, waiting and idle counts and the conductor's current step when present. |

Tell and Ask explain that a conductor must be started in Phren when none is
running. Settings > Siri and the Action button lists the phrases and opens
Shortcuts, where the Action button can run them. The settings identifiers are
`settings-conductor` and `settings-conductor-siri`.

The shortcut provider is at iOS's ten-shortcut limit. Waiting sessions, open
terminal and start agent remain available in Shortcuts without their former
provider phrases; session status keeps What is happening in Phren.

## Verification

PhrenKit fixtures cover optional remote descriptors, stable child identities
and grants. PhrenLive fixtures cover destination resolution and pinned SSH
routing. App fixtures cover conductor lookup, reply extraction and counts.
Simulator checks cover launch identity, grants, remote chips, unavailable
computers, exact answer actions and a selected transcript after completion.
Run affected tests locally; automatic iOS CI remains disabled.
