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
The `/v1/harness/lease` routes are compatibility views over that ledger; they
never create a second authority. Distribute the fixed configuration to every
participating checkout. Public identity configuration may be Git mode 0644;
private runtime state and admissions remain mode 0600.

| API | Body or result |
| --- | --- |
| GET `/v1/conductor/lease` | `{ok, config, state}`; canonical version, store, authority, generation and holder |
| POST `/v1/conductor/lease/configure` | `{authorityComputerId, confirm:true}`; fixed registered authority, distribution required |
| POST `/v1/conductor/lease/grant` | `{expectedGeneration, computerId, launchId, confirm:true}`; signed owner, empty holder only |
| POST `/v1/conductor/lease/revoke` | `{expectedGeneration, holder, confirm:true}`; exact reviewed holder, signed owner |
| POST `/v1/conductor/lease/authority` | Peer read/admit/bind only; peers cannot acquire, revoke or replace a grant |
| GET `/v1/harness/lease` | Compatibility holder with `leaseId` mapped to canonical `claimId`, plus generation |
| GET `/v1/harness/lease?authority=1&storeId=<8hex>` | Must be the named authority and registered store; refuses redirects |
| POST `/v1/harness/lease/authority` | `{storeId:<8hex>, computerId:<UUID>}`; same canonical configuration |
| POST `/v1/harness/lease/acquire` | `{expectedGeneration, computerId, launchId}`; signed owner, empty holder only |
| POST `/v1/harness/lease/revoke` | `{expectedGeneration, expectedLeaseId}` |
| POST `/v1/harness/lease/takeover` | `{expectedGeneration, expectedLeaseId, computerId, launchId}`; atomic explicit owner replacement |

Grant/revoke/takeover go directly to the paired authority computer. The holder
has no expiration. An unreachable authority blocks every new launch, including
schedules and workers. A conductor consumes one durable admission at the fixed authority for the
owner-granted launch ID; failed or uncertain launches retain that reservation.
Existing sessions and thread reads remain available. Stopping a role does not
release its grant, and no timeout or silence authorizes replacement.

`phren conductor make --launch-id <owner-granted UUID>` consumes that grant.
Interactive owner-terminal configure/revoke operate on the local canonical
store; HTTP controls require the paired signature. Unconfigured stores allow
ordinary workers but refuse new conductors. Interrupted lock directories
require owner reconciliation.

Native source signs controls with the existing device key and routes owner
changes to the exact paired authority. Its explicit conductor move reviews the
holder/generation before revocation; uncertain launches never automatically
start a replacement on the old machine. All native/runtime checks remain UNRUN.

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

## One QL agent through Omarchy, without QL enrollment

This is an optional tunnel, independent of machine enrollment. QL owns one
runner/agent. The source runner binds HTTP only on `127.0.0.1:<port>` with a
64-hex-character private bearer token; it exposes one adapter session. A future
owner-run reverse SSH connection forwards one owner-private Omarchy Unix socket
to that loopback listener. Neither side runs another Hook on QL or enrolls QL
as a computer. Codex stdio starts an explicitly installed Codex app-server
child; Claude SDK and configured ACP are other source options. Downloads,
credential discovery and automatic SSH execution are absent from the plan.

| API | Contract |
| --- | --- |
| POST `/v1/harness/proxy/plan` | `{id, omarchySSHHost:<existing alias>, omarchySocket:<absolute private .../harness/proxies/id.sock>, remotePort, ownerConfirmed:true}`; returns `performed:false`, `file:"ssh"`, argument array, `enrollmentRequired:false` |
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

Native source now lists this one agent separately, uses only its proxy target,
signs owner controls, retains uncertain delivery IDs on the phone, and shows
partial text history and current pending requests. It never enrolls QL or
reconstructs a local pane. **No phone or runtime acceptance is claimed.**
Native SSH forwarding,
Windows ACLs, SDK subscription/resume and Codex stdio initialization remain RC
runtime gates. The owner must establish existing SSH access and verify Omarchy's
host pin outside this source task; the plan always uses strict host-key checking.

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
