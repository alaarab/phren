# Canonical lease correction, source only

This isolated correction starts at frozen donor
`1f8dfdf5bc527a9ab012a6b65b6712f86db0cd78`. It does not import later donor
commits wholesale. The pinned `1f8dfdf5..42688bbd` supplemental diff was reviewed
against Q's correction; its target shape, public review record, conditional Stop
flag and truthful result fields were reconciled here. No inherited core commits
were replayed. Q's older inherited `5aca1ecb` snapshot and harness
commits remain separate. The two owner-proof helper files originate in Q's
source; `owner-controls.ts` now adds read-only signature preflight while
`private-state.ts` remains an exact dependency copy. This correction adopts
the donor's canonical generation/claim format,
not Q's older competing `leaseId` format.

The owner requested lease, linking and expired returns. Fixed authority, no
expiry and exact explicit takeover are conductor design judgments. Stop ends
the local conductor role and retains its lease, including while the authority
is offline. No silence, elapsed time or failed reply revokes a holder. Existing
work continues; a lost lease blocks new dispatch from the old conductor.

## Native API

`GET /v1/conductor/lease` stays `{ok,config|null,state|null}`. State remains
`{version:1,storeId,authorityComputerId,generation,holder|null}`, with holder
`{computerId,claimId,since,place?}`. `since` is an ISO datetime string. Keep the
complete raw holder for review. JSON property order is immaterial; every field,
including `since` and optional `place.session`, must match.

Config is `{version:1,storeId,authorityComputerId}`: an eight-hex registered store
ID and one fixed authority computer UUID. Configure returns
`{ok:true,config,distributionRequired:true}` and refuses to replace an existing
authority. Distribute it to all participating compatible Hooks before adoption.
Revoke returns `{ok:true,state,existingWorkPreserved:true}` after exact full-holder
and generation comparison at that authority; it kills no process. An unavailable
authority is an error, never an empty lease. Offline holders keep their lease
without expiry; offline authorities block every new launch. An irrecoverable
authority requires explicit recovery, never inferred replacement or failover.

Existing configure `{authorityComputerId,confirm:true}`, revoke
`{expectedGeneration,holder,confirm:true}`, and all four donor enrollment bodies
and successful responses remain unchanged. Enrollment still uses two already
paired Hooks and exact reviewed public keys/fingerprints. No new key, pin or
computer is inferred by takeover or existing-peer repair.

New `conductorLeaseTakeover` capability belongs to the conductor module. Send
`POST /v1/conductor/lease/takeover` to the intended replacement's already paired
Hook with:

```typescript
{
  expectedGeneration: number,
  holder: LeaseClaim, // Complete nonnull raw GET holder.
  confirm: true,
  newHolder: {
    computerId: string, // Replacement Hook's canonical UUID.
    target: {
      server: string,
      workspace: string,
      tab: string,
      pane: string,
      source: "claude" | "codex" | "opencode",
      session: string // Real current native UUID or OpenCode ses_ ID.
    },
    terminal: string
  }
}
```

The type shape above describes the JSON body. A `startingToken` is never a
session. Unknown fields and the earlier flat `computerId`/`place` body are
rejected; this is the sole takeover body. The computer ID must be this Hook's
ID. The fresh live workspace, tab, pane, terminal, source and session must
match; no new process is started. The fixed
authority checks the target locally or through an already pinned Hook, then
compares generation and the complete old holder under its state lock and writes
the replacement in one atomic update. There is no empty-holder window.

Success is
`{ok:true,state,previousHolder,existingWorkPreserved:true,launched:false}`.
State increments
generation once and carries the fresh generated claim ID/time and reviewed
place. The receiving Hook saves its claim and explicitly records the local role.
`POST /v1/conductor/stop` returns `{ok:true,stopped}` and adds
`leaseUnchanged:true` only if canonical authority configuration exists. This
flag says the reservation was not changed, not that a holder exists or was
verified. Stop never releases a claim or contacts the authority. Read GET lease
to learn its actual state. The CLI explains this retained reservation.

## Owner authorization and partial state

Configure and all enrollment POSTs require the paired-phone proof from
`owner-controls.ts`. Revoke and takeover carry that original proof to the fixed
authority, where it is verified and its nonce consumed exactly once. Takeover
also verifies the signature read-only on the replacement before inspecting its
target or creating public review evidence; this preflight does not consume a
nonce or authorize an authority mutation. The paired
phone public key must already be trusted on the authority. A computer SSH key,
`origin` omission or `ownerConfirmedRelease:true` cannot authorize either
mutation. Native must sign the exact original body and public pathname.

Headers are `x-phren-owner-time` (13 decimal digits), `x-phren-owner-nonce`
(fresh UUID), `x-phren-owner-key` (base64 ed25519 SSH public-key blob), and
`x-phren-owner-signature` (base64 raw ed25519 signature). Sign six LF-separated
lines, no trailing LF: `phren-owner-v1`, time, nonce, `POST`, pathname, lowercase
SHA256 of JSON with recursively sorted object keys, preserved array order and
no whitespace. Time tolerance is 120 seconds. Paired key and replay ledger are
checked each time. A failed CAS may already have consumed the nonce; explicit
retry needs fresh state and a fresh nonce.

Invalid/stale owner proof is 403; replay/locked state is 409; nonce capacity is
429; malformed body is 400. Exact target mismatch is 409 with
`code:"lease-target-changed"`. Changed holder/generation or offline/unverified/
ambiguous authority refuses with 409; existing pinned transport failures retain
their 403/503 codes. No automatic fallback follows an error.

Before the authority RPC, the replacement persists the parsed public request
and generated claim under `.runtime/conductor-takeovers/<claimId>.json`. It
stores no owner signature, private key or credentials. The previous local claim
is not overwritten until transfer is confirmed. This record is review evidence,
not a replay queue; no restart code runs it automatically.

If the authority replaced the lease but local claim/role adoption failed,
the Hook returns 409 with `{code:"lease-adoption-incomplete",lease:<new State>,
transferred:true,reviewId:<claimId>,existingWorkPreserved:true,launched:false}`.
The reservation remains. A transport/server failure without a confirmed reply
preserves its HTTP status (normally 503/504) and returns
`{code:"lease-transfer-unconfirmed",reviewId:<claimId>,transferUnconfirmed:true,
existingWorkPreserved:true,launched:false}`. This reports uncertainty, not a
successful or failed remote transfer. Other explicit 400/403/409 responses retain
their existing error meaning; a failed response never authorizes replay.
Reread the fixed authority and show its exact state honestly. Do not
automatically revoke, launch another agent or retry takeover against an old
review. Local disk/target recovery may require another explicit owner decision.

Internal `/v1/conductor/lease/authority` is not a native control. Read/claim/bind
retain existing pinned-Hook coordination; release/takeover require the original
signed public owner request. Its read-only `validate-place` operation cannot
change role or lease. It accepts `{storeId,operation:"validate-place",newHolder}`
and returns `{ok:true,newHolder}` only after checking that exact local live
target; the authority compares the complete returned replacement. Already bound
claims cannot change place through bind. An atomic takeover requires a distinct
new claim ID; it cannot replace the old claim under its existing ID.

The old unsigned interactive CLI configure/revoke requests still fail closed at
the Hook. A paired-phone signed request is the implemented owner path; no local
TTY check is treated as cryptographic owner proof. CLI authenticated-owner
transport remains an integration prerequisite if those mutations must be
offered from the terminal. CLI takeover explicitly explains that this transport
is unavailable; the donor's unsigned wrapper is not an alternate authorization
path.

## Enrollment compatibility and partial state

The four donor bodies remain exact. All require an already paired owner's
signed request and existing `manage_config`; no dispatch or release grant is
added. Each direction requires separate review and explicit confirmation.

| Route suffix under `/v1/computers/enrollment/` | POST body | Response |
|---|---|---|
| `prepare` | `{name,confirmKeyCreation:true}` | `{ok:true,version:1,computerId,name,username,hostKey,publicKey,hostFingerprint,keyFingerprint}` |
| `review` | `{peer:{computerId,name,address,username,port,server?,hostKey,publicKey}}` | `{ok:true,version:1,id,localComputerId,peer,localHostFingerprint,hostFingerprint,keyFingerprint,expiresAt,instruction}` |
| `confirm` | `{reviewId,confirm:true,peerComputerId,hostFingerprint,keyFingerprint}` | Verified: `{ok:true,state:"verified",linked:true,added,peerComputerId,hostFingerprint}`; partial: `{ok:true,state:"key-accepted-awaiting-verification",linked:false,peerComputerId,reason}` |
| `verify` | `{name,computerId,hostFingerprint}` | `{ok:true,state:"verified",computerId,hostFingerprint}` |

Review expires after ten minutes, without changing trust. `server` defaults to
`default`. Host/public keys are canonical ed25519 public material; no password
or private key crosses the phone. Confirm rechecks local/peer fingerprints and
UUIDs, accepts only the existing restricted CLI key format, then performs pinned
verification before saving a peer. A changed pin/enrolled key requires separate
explicit owner revocation/review. No implicit pin replacement occurs.

Malformed requests are 400; invalid owner proof/origin/access is 403; stale review,
pin or identity conflicts are 409. Verification transport failures preserve
their coded errors. A confirm 409 can occur after the key was accepted: UUID
mismatch currently explains this in `error`, while link-save failure additionally
returns `{keyAccepted:true,linked:false,peerComputerId}`. Native must treat such
failures/lost responses as partial or uncertain, never as rolled-back trust.
Only explicit owner review may retry confirm or revoke the accepted key; there
is no automatic rollback or retry.

`verify` checks an existing saved peer/pin and exact UUID; it does not recreate a
missing peer, accept a key, change a pin or operate a service. Q's separate
signed existing-peer repair contract remains distinct and uses only verified
preexisting enrollment. Repair that requires accepting a new key uses the above
two-sided explicit flow. The single attached QL Copilot is outside enrollment:
terminal observation carries no verified remote/native session or chat identity,
and unsupported structured chat capabilities stay closed.

## Prepared RC source, UNRUN

`conductor-lease.test.ts` owns the durable public lease/authority boundary. The
new regressions protect exact-holder CAS, one racing takeover, real session
identity, signed authority requests, retained lease on Stop while authority is
offline, and reservation retention after local adoption failure. Reconciled
cases exercise changed workspace/tab/terminal/session, reject unsigned public
review writes, and retain the previous local claim/public review after an
unanswered authority request without retrying it. A dropped-reply fixture does
not prove that a remote transfer happened; the response must remain uncertain.
The prior suite
covered claim races/revoke generation/damaged state, not takeover or signed RPC.
There are no new production test seams. Assertions inspect public results,
durable state and role behavior. Pre-fix failures and post-fix passes have not
been executed; the owner prohibits tests, providers, builds and runtime here.

All new launches routed through server-launch, schedules and the private harness
runner entry check the configured canonical authority. Existing run observation
does not acquire or clear a lease. When combining Q, remove the older competing
harness lease routes/state/admission policy rather than retaining two authorities.
Canonical conductor launch/make still reserves before role assignment.

Before RC, Astra must combine native signing/partial-state handling and the
chosen canonical lease guards, review pinned remote signature forwarding, SDK
auth/resume, restart reconstruction and installer rollback, then obtain the
required development build and real RC slots. No phone linking, local chat/phone
acceptance, QL transport, service action or release is established by this source.
