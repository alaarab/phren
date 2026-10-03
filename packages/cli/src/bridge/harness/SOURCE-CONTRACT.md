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
existing paired-device transport. A computer's dispatch SSH key is insufficient.

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

These routes use the Hook's configured store, not a client-supplied filesystem
path. A fixed authority must be configured consistently on every participating
store checkout. This patch does not migrate or elect authorities.

| API | Body or result |
| --- | --- |
| GET `/v1/harness/lease` | `{configured, authoritative?, computerId?, storeId?, holder?, noAutomaticFailover:true}` |
| GET `/v1/harness/lease?authority=1&storeId=<8hex>` | Must be the named authority and store; refuses redirects |
| POST `/v1/harness/lease/authority` | `{storeId:<8hex>, computerId:<UUID>, peerName?, expectedHostKey?}`; remote authority must already be a verified pinned peer |
| POST `/v1/harness/lease/acquire` | `{computerId:<intended launch computer UUID>, launchId:<UUID>, target?}`; requires no holder |
| POST `/v1/harness/lease/revoke` | `{expectedLeaseId:<current UUID>}` |
| POST `/v1/harness/lease/takeover` | `{expectedLeaseId, computerId, launchId, target?}` |

Lease mutations must be sent to the authority computer with its paired owner's
proof. The holder includes `leaseId`, `computerId`, `launchId`, `createdAt` and
optional pane Target. It has no expiration. An unreachable configured authority
blocks **every new launch**, including schedules and workers. A new conductor
also requires a matching owner-granted lease and consumes one durable admission
reservation before launch. A failed launch retains the reservation for an
explicit owner decision. Concurrent launches cannot reuse that lease. Existing
sessions, thread reads and owner repair do not become new launches.

The existing session launch API carries `launchId`. CLI promotion uses
`phren conductor make --launch-id <owner-granted UUID>`. Stopping a conductor
does not release its lease; only signed owner revoke/takeover does. Unconfigured
stores keep ordinary worker launches but refuse new conductors. Configuration
changes and abandoned lock directories require explicit owner reconciliation;
there is no silence-, age- or timeout-based takeover.

## Existing-peer repair and optional new enrollment

| API | Contract |
| --- | --- |
| GET `/v1/harness/peers` | Existing peer rows and repair scope |
| POST `/v1/harness/peers/repair` | `{name, expectedHostKey, expectedComputerId, backPeer:<existing Peer schema>}` |
| POST `/v1/harness/peers/enrollment-plan` | `{ownerConfirmed:true, name, hostKey}`; returns `performed:false`, manual steps |
| POST `/v1/harness/peers/enroll` | `{ownerConfirmed:true, host:<existing owner SSH alias>, expectedHostKey, name?, as?, backAddress?}` |

Repair verifies an existing `phren-computer:<name>` local enrollment, uses the
existing dispatch identity and supplied unchanged host pin to check the remote
computer UUID, then updates routing under the shared hooks.yaml lock. It never
generates/exchanges keys or silently replaces a stored pin. New enrollment is a
separate explicit owner-confirmed operation: existing owner SSH access, strict
known-host checking and independently verified Ed25519 host key are required
before the existing link workflow may exchange keys. CLI link now requires
`--host-key <verified ssh-ed25519 public key>` and explicit confirmation/`--yes`.
No repair, enrollment, SSH or credential operation was performed in this task.

## One QL Copilot terminal through Omarchy, without QL enrollment

Version 2 narrows the former generic SDK/ACP/Codex proxy contract to the owner's
one existing reverse-SSH-attached Copilot terminal. There is no Copilot runner
API in this source. No native remote session, transcript, turn acknowledgement,
permission transport or phone chat acceptance has been established. The observed
startingToken belongs only to the current Omarchy pane/process; it must never be
used as a native session ID, transcript ID or chat Target.

The source binds one owner-confirmed existing pane. It performs no SSH, remote
launch, machine enrollment, credential discovery, pin change or automatic repair.
QL origin and reverse-SSH transport are owner declarations, not inferred proof.
`identity.remoteSessionVerified` and `identity.remoteTransportVerified` remain
false even while the local pane is verified. An SSH-only/unknown pane cannot be
registered as Copilot: the current local listing must actually name Copilot.

| API | Version-2 contract |
| --- | --- |
| POST `/v1/harness/proxy/plan` | Registration-shaped input below; returns `performed:false`, `commands:[]`, prerequisites and no native session; describes an existing attachment only |
| POST `/v1/harness/proxies/register` | `{id, originComputer:"QL", viaPlatform:"omarchy", provider:"copilot", transport:"existing-reverse-ssh-terminal", label, terminalTarget, terminal, ownerConfirmed:true, expectedOwnerId?}` |
| POST `/v1/harness/proxies/remove` | `{proxyId, ownerId, ownerConfirmed:true}`; exact current registration owner only; removes routing without stopping SSH or closing the pane |
| GET `/v1/harness/proxies` | `{version:2, scope:"one-agent", proxies:[]}`; max one separate discovery row, never computer enrollment |
| GET `/v1/harness/proxy/session?proxyId=<id>` | Attachment metadata with `session:null`, `nativeSession:null`, `target:null`, `chatTarget:null` and `chatSupported:false` |
| GET `/v1/harness/proxy/screen?proxyId=<id>&ownerId=<uuid>` | Verified visible terminal screen, max 100 lines / 65536 characters, `scope:"terminal-screen"`, `session:null`, `transcript:false`, `truncated` |
| GET `/v1/harness/proxy/thread`, `/events`, `/delivery` | HTTP 409 `proxy-capability-unsupported`; no native reads or receipts |
| POST `/v1/harness/proxy/turn`, `/interrupt`, `/approval`, `/input`, `/model`, `/takeover`, `/start`, `/keys`, `/prompt` | HTTP 409 `proxy-capability-unsupported`; no typing, native delivery, optimistic queue/ack or permission change |

`terminalTarget` is strictly `{server, workspace, tab, pane, source:"copilot",
starting:true, startingToken:<64hex>}`; `terminal` is the independently checked
current terminal identifier as a string. Extra session/nativeSession fields in
registration are rejected. Proxy operation references are `{proxyId, ownerId?}`;
screen requires the exact current ownerId. The registration UUID is routing
ownership only, never a remote session. Supplying a fake session/nativeSession or
using startingToken as a proxy operation reference returns 409
`proxy-no-native-session`. Unknown operations return 404.

All structured harness capabilities plus `sendTurn` and `deliveryReceipts` are
false. `terminalCapabilities` is `{readScreen:<binding valid>, keys:false,
prompt:false}`. Every row includes exact per-operation unsupported explanations.
Its state is `terminal-only`, `binding-changed` or `unavailable`; stale rows retain
null session/chat targets and expose no usable terminalTarget. Screen reads verify
the binding before and after the read, then verify the registration owner again.

State is private `<bridge>/harness/copilot-proxy-v2.json`, separate from the old
runner registry. No old entries or starting rows are silently migrated. One
attachment is persisted under an atomic owner-state lock; replacement must name
the prior ownerId and receives a new UUID. Hook restart retires startingToken;
existing state becomes binding-changed and requires explicit owner registration
against a fresh listing. No timeout takeover or automatic reconstruction occurs.

All proxy POSTs use the existing paired-owner Ed25519 route/body proof; a body
confirmation alone is insufficient. GETs use the existing authenticated Hook
transport. `harnessProxyContract` advertises version 2, Copilot, terminal-screen
support and false chat/nativeSession/terminalWrites; other local providers'
computer-wide capabilities must not be applied to this row.

iOS discovery must query the separate proxy list, keep the row as a terminal
attachment, deduplicate its terminal address if also shown locally, and never
open `/v1/transcripts`, normal chat routes or approval UI for this row. It may
show the guarded screen. No native app source or phone request was exercised.

The owner must establish or confirm the single existing reverse-SSH attachment,
using existing access and independently verified host pins outside this task.
The source cannot verify the actual tunnel from a startingToken. Remote terminal
writes, Copilot native conversation discovery, transcripts, acknowledgements,
permissions, resume and full phone chat remain explicit gaps. General donor
computer enrollment and conductor lease source are separate and untouched.

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
