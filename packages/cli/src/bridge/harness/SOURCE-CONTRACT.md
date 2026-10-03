# Harness source contract — UNRUN

This slice is source for integration. No provider, SDK, SSH, installer, service,
build or test was run. Phone adoption and native compatibility are unverified.
It requires the frozen lead harness snapshot recorded in the handoff manifest;
the integrator must combine the other lead-owned dependencies separately.

## Ownership and capabilities

`HarnessAdapter` covers direct Codex app-server, direct OpenCode, PaneTyping,
Claude subscription SDK and explicitly configured ACP v1 executables. A brand
name alone does not prove ACP support. PaneTyping exposes terminal interaction
without structured chat, request IDs or delivery acknowledgment. ACP thread
reads return the observed event window with `partial: true`; there is no ACP v1
arbitrary historical thread-read method. ACP user questions remain unsupported.

The module manifest declares the harness routes, capabilities and state files.
Health capabilities mean an API is present; they do not establish installed
SDK/ACP availability, successful subscription authentication or native maturity.
Configured ACP launches check their owner-configured executable with `X_OK`,
accept only supervised worker permissions, and do not depend on a separate
`@phren/agent` installation. Phren-specific mode/resume fields and named accounts
are refused for ACP rather than silently applied to another provider.

SDK terminal takeover is disabled in both adapter capabilities and runner IPC.
There is no resumed CLI spawn: account continuity, SDK child shutdown and TUI
readiness must be established before this operation can be enabled. SDK resume
replay correlation remains unverified; an old result arriving after a fresh
turn must not be claimed safe until the exact native behavior is validated or
submission identity is correlated. Codex request IDs exposed by the shared
adapter encode the native type and value, retaining session scoping; numeric
`1` and string `"1"` cannot select each other's approvals or questions.

`/v1/harness/session?target=<encoded JSON pane Target>` returns the actual
provider, native session, binding and capabilities. The existing pane Target
retains its server, workspace, tab, pane, source and session identity. Herdr and
tmux aggregation and terminal type identity already exist in public source;
this slice does not replace discovery or invent local panes for remote agents.

Worker IPC is under a private directory, with a private Unix socket and regular
0600 registry. Every operation binds `ownerId`, native session, public session
alias and process ID. The Hook and worker both verify the current terminal and
foreground runner process. Cached adapters are invalidated on owner change.
Hook restart reconstructs the adapter and outstanding request cards from the
still-running worker. Closing a Hook observer does not close that worker.
Stale registries are refused; elapsed time never authorizes socket replacement.
An exclusive ownership lock is acquired before native adapter construction and
held for the runner's lifetime, so concurrent runner starts cannot spawn a second
owned agent. An abandoned lock requires explicit owner repair, never age clearing.

Structured worker turns require a stable 8–64 character ASCII `deliveryId`
matching `[A-Za-z0-9_-]+`. Same ID and same text join or replay one worker-owned
submission; changed text is rejected. No native acknowledgment means `queued`.
A failed/lost native response remains `uncertain` and is never resubmitted by a
retry. Capacity is 1024 receipts; fresh submissions are refused at capacity.
Receipts survive Hook restart while the runner lives, **not runner death**.
Native resume after runner death requires a new owner registration and human
reconciliation; it does not reconstruct a durable exactly-once native ledger.

GET `/v1/harness/delivery?target=<encoded JSON>&deliveryId=<id>` reads a worker
receipt. Existing `/v1/prompt/status` also uses this receipt for structured
workers. Thread/events reads stay capability-gated; event windows report gaps.
Closed journals drain their final events before ending the consumer.

## Paired owner proof

Every POST below `/v1/harness/` requires these headers, in addition to the
existing paired-device transport. The same proof is required for conductor
configure/grant/revoke and computer-enrollment prepare/review/confirm. A
computer's dispatch SSH key is insufficient.

| Header | Wire value |
| --- | --- |
| `x-phren-owner-time` | 13 decimal digits, Unix milliseconds, within ±120 s |
| `x-phren-owner-nonce` | Fresh UUID, never reused for a different body |
| `x-phren-owner-key` | Base64 of the 51-byte OpenSSH Ed25519 public-key wire blob |
| `x-phren-owner-signature` | Base64 of the 64-byte raw Ed25519 signature |

Sign these six UTF-8 lines, joined by LF, with **no final LF**:

```text
phren-owner-v1
<time header>
<nonce header>
POST
<pathname, excluding query>
<lowercase hex SHA-256 of canonical JSON request body>
```

Canonical JSON recursively sorts object keys by JavaScript UTF-16 code units,
preserves array order, and uses JSON.stringify representation for keys and
scalar values, with no whitespace. This is a specific wire algorithm, not a
claim of RFC 8785 compliance. Native clients must produce identical UTF-8 bytes;
ASCII field names and integral values used by these controls avoid number/key
ordering ambiguity. The independent ASCII fixture is in owner-controls.test.ts.

The matching key must currently be in the owner's public authorized_keys as a
restricted forced-command `phren-iphone` or `phren-android` entry. Revoked keys,
computer keys, stale signatures, changed method/path/body and duplicate nonces
are refused. Nonces are stored privately across Hook restarts for 240 s; the
1024-row fresh ledger refuses overflow. `origin` must be absent but its absence
does not establish ownership. Failed controls may consume a nonce; retry the
owner decision with a new proof after refreshing its current state.

## Fixed store conductor lease

All lease routes use the one registered store identity, canonical
`.config/conductor-authority.json` and `.runtime/conductor-lease.json` ledger.
The competing `/v1/harness/lease` HTTP routes are retired (404). Distribute the fixed configuration to every
participating checkout. Public identity configuration may be Git mode 0644;
private runtime state and admissions remain mode 0600.

| API | Body or result |
| --- | --- |
| GET `/v1/conductor/lease` | `{ok, config, state}`; canonical version, store, authority, generation and holder |
| POST `/v1/conductor/lease/configure` | `{authorityComputerId, confirm:true}`; fixed registered authority, distribution required |
| POST `/v1/conductor/lease/grant` | `{expectedGeneration, computerId, launchId, confirm:true}`; signed owner, empty holder only |
| POST `/v1/conductor/lease/revoke` | `{expectedGeneration, holder, confirm:true}`; exact reviewed holder, signed owner |
| POST `/v1/conductor/lease/authority` | Peer read/admit/bind only; peers cannot acquire, revoke or replace a grant |

Grant and exact-holder revoke go directly to the paired authority computer. The holder
has no expiration. An unreachable authority blocks every new launch, including
schedules and workers. A conductor consumes one durable admission at the fixed authority for the
owner-granted launch ID; failed or uncertain launches retain that reservation.
Existing sessions and thread reads remain available. Stopping a role does not
release its grant, and no timeout or silence authorizes replacement.

The reservation protects conductor ownership, not every ordinary worker slot.
An ordinary worker or schedule checks configured authority reachability but does
not require an empty holder, contact the holder's process, or consume its grant.
An existing conductor must still match its current grant before dispatching.
Holder-process liveness is not authority reachability and cannot authorize
replacement. This describes current source behavior, not runtime acceptance.
Both configuration and subsequent reads compare the configured store ID with
the checkout's registered canonical identity; a signed arbitrary ID is refused.

`phren conductor make --launch-id <owner-granted UUID>` consumes that grant.
Interactive owner-terminal configure/revoke operate on the local canonical
store; HTTP controls require the paired signature. Unconfigured stores allow
ordinary workers but refuse new conductors. Interrupted lock directories
require owner reconciliation.

Native source signs controls with the existing device key and routes owner
changes to the exact paired authority. Its explicit conductor move reviews the
holder/generation before revocation; uncertain launches never automatically
start a replacement on the old machine. All native/runtime checks remain UNRUN.

## Existing-peer repair and canonical two-sided enrollment

`GET /v1/harness/peers` returns existing routing and repair scope. Signed
`POST /v1/harness/peers/repair` takes `{name, expectedHostKey,
expectedComputerId, backPeer}`. It verifies existing restricted enrollment,
unchanged host pin and pinned remote identity before updating local routing under
the same hooks.yaml lock used by enrollment. Missing enrollment is refused.

New enrollment uses only `/v1/computers/enrollment/prepare`, `/review`, `/confirm`
and `/verify` under the conductor module. Prepare takes `{name,
confirmKeyCreation:true}`; review takes `{peer}` from the other authenticated
Hook. The flattened review has a required ISO-8601 string `expiresAt`. Confirm
relays `{reviewId, confirm:true, peerComputerId, hostFingerprint, keyFingerprint}`.
`key-accepted-awaiting-verification` with `linked:false` is partial trust, not a
successful link. After reverse confirmation, retry the same unexpired review
explicitly, then verify both saved directions. Verify takes `{name, computerId,
hostFingerprint}` and returns `state:"verified"` without a `linked` field.
Q's alternative peer-enroll and leaseId phone protocols are not exposed.

All these owner writes use the paired-phone Ed25519 proof. Native health gating
requires `canonicalOwnerControls:"ed25519-v1"` and the relevant conductor
capability. HTTP errors retain status and the full JSON body; optional details
are not coerced into a fixed error enum. No SSH, key, enrollment, service or
lease operation was performed during this source integration.

## One QL agent through Omarchy, without QL enrollment

The owner requires the existing authenticated transport for the one existing
QL agent, including replies and handoffs back to authorized panes. No new SSH
connection, replacement agent, broad Hook tunnel or QL enrollment is authorized.
The current source only sends operations from Omarchy to a private runner socket;
it does not implement the required QL-to-pane return RPC. Generic SDK/ACP support
is not evidence of compatibility with the existing QL Copilot session.

The source runner exposes one token-bound loopback adapter session. Using its
forwarded socket does not itself prove that the current QL client's transport can
carry a return RPC. `peerRequest` cannot be a fallback: it spawns SSH per request
and disables multiplexing. The plan therefore emits no SSH executable/arguments
and reports transport capability unverified and return handoff unavailable.
Existing w7Z owns the read-only live-client capability assessment; no duplicate
probe, connection, forwarding change or reconnect is performed here.

| API | Contract |
| --- | --- |
| POST `/v1/harness/proxy/plan` | `{id, omarchySSHHost:<existing alias>, omarchySocket:<absolute private .../harness/proxies/id.sock>, remotePort, ownerConfirmed:true}`; returns `performed:false`, `code:"existing-transport-capability-unverified"`, `reuseExistingTransport:true`, `newConnectionAllowed:false`, `returnHandoffAvailable:false`, `controlledReconnectRequired:"unknown"`; no executable or argument array |
| POST `/v1/harness/proxies/register` | `{id, originComputer:"QL", label, entry:<RunnerEntry from owner>, token:<64hex>, expectedOwnerId?}`; max one registration; replacement must name the previous owner |
| GET `/v1/harness/proxies` | Separate `{version:1, scope:"one-agent", proxies:[...]}` listing |
| GET `/v1/harness/proxy/session?proxyId=<id>` | Verified provider, native session, capabilities and proxy Target |
| GET `/v1/harness/proxy/thread` | Query `proxyId`, `session`, `ownerId` |
| GET `/v1/harness/proxy/events` | Same query plus `after` cursor |
| GET `/v1/harness/proxy/requests` | Current pending requests from the live runner, including after observer restart |
| GET `/v1/harness/proxy/delivery` | Same query plus `deliveryId` |
| POST `/v1/harness/proxy/turn` | `{target:<ProxyTarget>, text, deliveryId}` |
| POST `/v1/harness/proxy/interrupt` | `{target, turnId}` |
| POST `/v1/harness/proxy/approval` or `/input` | `{target, requestId, response}` |
| POST `/v1/harness/proxy/model` | `{target, model}` |

`ProxyTarget` is `{proxyId, session, ownerId}`. It is **not** a local pane Target
and never enters `/v1/computers` or the regular workspace/pane listing. Each
operation checks the private forwarded socket, token and live runner owner,
native session, process and provider. Views omit the token. A changed or missing
owner becomes `offline`, not an invented local agent. Unsupported chat becomes
`terminal-only`, with no chat target. Session creation, terminal takeover,
arbitrary commands and machine administration are unavailable through the proxy.
Each live identity check also refuses session creation, takeover, or any enabled
capability absent from the owner's registration. A changed endpoint cannot widen
the displayed capability set without explicit owner registration.

Native source now lists this one agent separately, uses only its proxy target,
signs owner controls, retains uncertain delivery IDs on the phone, and shows
partial text history and current pending requests. It never enrolls QL or
reconstructs a local pane. **No phone or runtime acceptance is claimed.**
Existing transport reuse, actual Copilot session support and phone
interaction remain integration and RC gates. An overview row marked working
without a chat Target is not evidence of a routable chat or return channel.

### Required bidirectional return channel — not implemented

The selected implementation must provide only `handoff` and `receipt` RPCs over
the same authenticated live connection, or a verified existing SSH mux channel
that cannot fall back to opening a connection. If the actual client cannot add
such a channel, report that a controlled reconnect is needed and leave it blocked
until separately authorized. A reconnect is not authorized by this source plan.

Herdr's [machine guide](https://herdr.dev/docs/connecting-machines/) and
[CLI reference](https://herdr.dev/docs/cli-reference/) distinguish saved-profile
API routing from a TUI's live connections. `--machine` selects that profile's
remote session; sidebar selection does not retarget commands in existing panes.
The CLI does not route through another TUI's connections. The owner confirms
QL runs WSL with Omarchy: assess its actual SSH client as Linux when it is the
WSL Linux binary. Linux managed ControlMaster reuse is a possible transport;
native Windows OpenSSH limitations are not a blocker for that path. Neither a
working overview row nor a machine profile proves a usable return channel.
Check the installed client and existing control socket before assuming reuse.
No duplicate workspace or QL enrollment is required by this design.

The owner's read-only Mini report identifies Herdr 0.9.1 with `--machine` but
without `machine status`/`machine reconnect`, and an empty local saved catalog.
Those observations do not describe Omarchy's or QL's catalog or capabilities.
Await w7Z's existing read-only assessment of the actual SSH binary, connection
direction, installed protocol and existing control socket/channel. No update, restart, link,
catalog edit or fresh connection is a substitute for that evidence.

The receiver must bind each RPC to the current proxy owner/native session/process
and a revocable owner-approved list of exact destination Targets (computer,
server, workspace, tab, pane, source, session). No wildcard, session-name search,
client-supplied origin impersonation, arbitrary command, arbitrary URL/path,
remote peerRequest forwarding or full Hook exposure is allowed. A destination
on another computer needs its own verified reusable transport; the proxy must
not silently open a peer SSH connection. Recheck ACL and live destination before
admission and before delivery, including after queueing or owner replacement.

Requests require a stable ASCII deliveryId of 8–64 characters, text of at most
32768 characters, bounded serialized frames, bounded pending/receipt counts and
backpressure. Bind ID to exact origin, target and text; reject changed payloads.
Persist admission/attempt state before side effects and retain receipts across
Hook reconstruction. Return queued, delivered, failed or uncertain truthfully;
query uncertain outcomes without resubmission. A transport loss or lost reply
must never trigger a new SSH connection or another native submission. Retention,
overflow and restart behavior must be explicit, without claiming exactly-once
native delivery or receipt survival across runner death without durable proof.

Reuse the receiving Hook's existing handoff queue and live target checks through
a narrow authorized entry, not a public proxy to `/v1/*`. The local agent-facing
client and native transport integration must both exist before this requirement
can be marked source-complete. This section is the acceptance contract, not a
claim that these RPCs or the current QL client's reuse support exist.

## Returns and installer

After 24 h without a terminal return, accepted/uncertain observations including
blocked/stalled become `expired`, retain approvals and do not close the pane or
pretend completion. Terminal states remain unchanged. This is receipt aging,
not conductor failover or approval dismissal.

Linux installer source serializes installs, stages and atomically renames the
bundle, writes the unit atomically, activates the new symlink before one systemd
restart, and restores the prior bundle/fast hook/dispatch/askpass/unit/current
link/install metadata on a caught failure. It avoids stopping the old Linux
Hook before activation. A killed installer cannot execute catch-based rollback;
activation leaves an existing service running until its restart transaction.
Agent-account/plugin/trust/key edits are not claimed to be an all-files atomic
transaction. Fault-injection and actual service readiness remain unrun.


Native structured sessions now discover `GET /v1/harness/session` with the real pane target and receive the runner's `ownerId` and `nativeSession`. Phone reads/controls retain that owner independently of the pane/session; a replaced runner refuses stale controls. `GET /v1/harness/requests` returns the current pending snapshot, including after Hook restart. Native SDK/ACP chat uses actual thread/event responses, displays SDK text deltas separately until history catches up, persists uncertain delivery receipts without resending, and gates interrupt, question, approval, model and explicit SDK-to-terminal takeover on capabilities. QL retains its distinct opaque proxy target. Native, SDK login/resume and provider runtime acceptance remain UNRUN.

SDK/ACP observations feed the existing rich native conversation; controls use a
separate sheet, preserving talk, attachments, tool rows and file links. ACP's
local `user-message` is a submission observation, never a native acknowledgment.
The phone admits its confirming transcript row only after a reply or prompt
completion for that exact turn. Live chunks stay a streamed preview until the
turn ends. Legacy pane keys/model/settings and slash-command paths refuse
structured workers; ordinary prompt submission requires the retained owner.

## Owner-approved 176 remote scope

The required remote path is one existing WSL agent exchanging prompts, replies
and handoffs with authorized Omarchy panes over the existing trusted connection,
with visible connection status and honest delivery/offline receipts. Exact agent
identity, scoped authorization and owner proof remain required. The return RPC
and actual existing-agent binding remain incomplete; this scope change does not
claim they work. No new SSH connection or substitute agent is authorized.

The current owner assignment restores reachable native lease, two-sided computer
enrollment and existing-peer repair source to Astra's scope; R remains task-only.
The conductor module exposes canonical generation/claim controls and the four
`/v1/computers/enrollment/{prepare,review,confirm,verify}` routes. Their POSTs and
peer repair require fresh paired-phone Ed25519 proof plus configuration rights.
`canonicalOwnerControls: "ed25519-v1"` advertises that canonical protection;
`harnessOwnerControls` alone is insufficient. No runtime action is authorized by
this source integration.

The phone uses two existing paired connections, shows exact computer IDs,
connection details and public host/dispatch-key fingerprints, and asks separately
before preparation and each trust confirmation. Partial key acceptance stays
incomplete. Retries and verification are explicit. Existing-peer repair changes
local routing only, with an unchanged reviewed pin and exact remote ID; missing
enrollment never triggers an automatic enrollment fallback. Unknown holder,
config and review fields and full owner-control error bodies are retained.

This is unbuilt source, not phone acceptance. Build-only checks and the full
immutable core+iOS RC remain required; Android is independent. Live enrollment,
lease changes, service operations and task metadata activation remain unauthorized.
