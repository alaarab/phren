# Canonical lease correction, source only

This isolated correction starts at frozen donor
`1f8dfdf5bc527a9ab012a6b65b6712f86db0cd78`. It does not import later donor
commits or optional edits. Q's older inherited `5aca1ecb` snapshot and harness
commits remain separate. The two owner-proof helper files are exact reused Q
source; this correction adopts the donor's canonical generation/claim format,
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
  computerId: string, // Replacement Hook's canonical UUID.
  place: {
    server: string,
    pane: string,
    terminal: string,
    source: "claude" | "codex" | "opencode",
    session: string // Real current native session ID.
  }
}
```

The type shape above describes the JSON body. A `startingToken` is never a
session. The computer ID must be this Hook's ID. The fresh live pane,
terminal, source and session must match; no new process is started. The fixed
authority checks the target locally or through an already pinned Hook, then
compares generation and the complete old holder under its state lock and writes
the replacement in one atomic update. There is no empty-holder window.

Success is `{ok:true,state,existingWorkPreserved:true}`. State increments
generation once and carries the fresh generated claim ID/time and reviewed
place. The receiving Hook saves its claim and explicitly records the local role.
`POST /v1/conductor/stop` adds `leasePreserved:true`; it never releases a claim.

## Owner authorization and partial state

Configure and all enrollment POSTs require the paired-phone proof from
`owner-controls.ts`. Revoke and takeover carry that original proof to the fixed
authority, where it is verified and its nonce consumed exactly once. The paired
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

If the authority replaced the lease but local claim/role adoption failed,
the Hook returns 409, `code:"lease-adoption-incomplete"`, the new `state`, and
`existingWorkPreserved:true`. The reservation remains. A lost reply has an
uncertain outcome: reread the fixed authority and show it honestly. Do not
automatically revoke, launch another agent or retry takeover against an old
review. Local disk/target recovery may require another explicit owner decision.

Internal `/v1/conductor/lease/authority` is not a native control. Read/claim/bind
retain existing pinned-Hook coordination; release/takeover require the original
signed public owner request. Its read-only `validate-place` operation cannot
change role or lease. Already bound claims cannot change place through bind.

The old unsigned interactive CLI configure/revoke requests now fail closed at
the Hook. A paired-phone signed request is the implemented owner path; no local
TTY check is treated as cryptographic owner proof. CLI authenticated-owner
transport remains an integration prerequisite if those mutations must be
offered from the terminal.

## Prepared RC source, UNRUN

`conductor-lease.test.ts` owns the durable public lease/authority boundary. The
new regressions protect exact-holder CAS, one racing takeover, real session
identity, signed authority requests, retained lease on Stop while authority is
offline, and reservation retention after local adoption failure. The prior suite
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
