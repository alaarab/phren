# Feature maturity

## Current source contract for owner task 250619d7

The owner requested one conductor per store, phone-driven linking, and an
explicit return when observation expires. The details below are conservative
**conductor implementation judgment**, not verbatim owner decisions. The
September 26 assessment below remains historical evidence, not the current
implementation status. These source changes have not been exercised against
live peers; new takeover/stop corrections and prepared regressions are UNRUN
and unbuilt under the development policy.

### Store lease

Capability `conductorLease` belongs to the conductor module. The registered
eight-hex store ID and one explicitly configured authority computer UUID live
in synced `.config/conductor-authority.json`. The authority serializes its
machine-local lease under a lock. A holder has no expiry: offline holders and
unreachable authorities block new launches. Existing work is preserved. The
configuration must be distributed to participating compatible Hooks before
adoption; neither these routes nor a phone sync elects a replacement authority.

- `GET /v1/conductor/lease` returns `{ok:true,config:null|Config,state:null|State}`.
  Config is `{version:1,storeId,authorityComputerId}`. State adds `generation`
  and `holder:null|Holder`. Holder is `{computerId,claimId,since,place?}`;
  place is `{server,pane,terminal,source,session?}`. IDs for computers/claims are
  UUIDs; `since` is an ISO datetime. An unavailable authority returns an error,
  not an empty lease.
- `POST /v1/conductor/lease/configure` accepts
  `{authorityComputerId,confirm:true}` and returns
  `{ok:true,config,distributionRequired:true}`. It verifies the existing local
  or pinned-peer computer and refuses to replace an existing authority.
- `POST /v1/conductor/lease/revoke` accepts
  `{expectedGeneration,holder:<complete reviewed Holder>,confirm:true}` and
  returns `{ok:true,state,existingWorkPreserved:true}`. Both holder and generation
  must still match at the authority. No process is stopped.
- `POST /v1/conductor/lease/takeover` runs on the replacement computer's
  authenticated Hook and accepts:

  ```json
  {
    "expectedGeneration": 3,
    "holder": {
      "computerId":"40000000-0000-4000-8000-000000000001",
      "claimId":"40000000-0000-4000-8000-000000000002",
      "since":"2026-10-03T00:00:00.000Z",
      "place":{"server":"default","pane":"w1:p1","terminal":"terminal-1","source":"codex","session":"40000000-0000-4000-8000-000000000003"}
    },
    "newHolder": {
      "computerId":"40000000-0000-4000-8000-000000000004",
      "target":{"server":"default","workspace":"w2","tab":"w2:t1","pane":"w2:p1","source":"codex","session":"40000000-0000-4000-8000-000000000005"},
      "terminal":"terminal-2"
    },
    "confirm":true
  }
  ```

  These example identities must be replaced by the exact GET holder and live
  replacement identity; omit `holder.place` only if GET omitted it. The UI must
  show the complete old and new identities before confirmation.
  The new target must be an already running local Claude, Codex or OpenCode
  session, with matching workspace, tab, pane, terminal and session identity.
  Starting tokens are insufficient. The authority atomically compares the
  complete old holder and generation, replaces it with a new claim, and advances
  the generation. Success returns
  `{ok:true,state,previousHolder,existingWorkPreserved:true,launched:false}`.
  The old worker stays alive but cannot dispatch under the revoked lease. A
  lost response requires reading the lease and explicit review, never automatic
  replay. A failure after transfer reports that transfer may need role repair;
  it retains the lease and per-claim review evidence.

All three mutation controls reject agent-origin calls and require existing
`manage_config` authority. They add no dispatch or release grants. The private
`/v1/conductor/lease/authority` coordination route is not a phone control.
`POST /v1/conductor/stop` ends the local role and returns `leaseUnchanged:true`
when configured; it does not implicitly revoke the reservation or assert that
the authority currently has a holder. Read the lease for its actual state. CLI lease
configure/revoke/takeover requires the owner's interactive terminal. Takeover
uses `phren conductor lease takeover --review-file <request.json> --confirm
'<oldClaimId>-><newComputerId>/<newSession>'` on the replacement computer.

An irrecoverable authority remains an explicit recovery prerequisite. This
implementation does not infer that an inaccessible computer has lost its state
or authorize a second authority while the first might return.

### Phone linking and repair

Capability `computerEnrollment` exposes owner-only controls under existing
`manage_config` authority. Both computers must already have authenticated phone
connections; the phone relays public identity material, never credentials.

1. `POST /v1/computers/enrollment/prepare` with
   `{name,confirmKeyCreation:true}` explicitly creates/reuses the existing CLI
   dispatch identity. Response is
   `{ok:true,version:1,computerId,name,username,hostKey,publicKey,hostFingerprint,keyFingerprint}`.
2. `POST /v1/computers/enrollment/review` with
   `{peer:{computerId,name,address,username,port,server,hostKey,publicKey}}`
   stores a ten-minute review without changing trust. `server` defaults to
   `default`. Response includes `ok`, `version:1`, review `id`, `localComputerId`,
   `peer`, `localHostFingerprint`, `hostFingerprint`, `keyFingerprint`,
   `expiresAt`, and an instruction to compare both authenticated identities.
3. `POST /v1/computers/enrollment/confirm` requires
   `{reviewId,confirm:true,peerComputerId,hostFingerprint,keyFingerprint}`.
   It rechecks the review, local host pin and existing enrollment, accepts only
   the existing restricted CLI key format, and verifies pinned SSH plus the
   exact remote computer UUID before saving a peer. Success reports
   `state:"verified",linked:true`; partial acceptance reports
   `state:"key-accepted-awaiting-verification",linked:false` and its reason.
   Show partial state; do not report a completed link or automatically retry.
4. `POST /v1/computers/enrollment/verify` with
   `{name,computerId,hostFingerprint}` checks only an existing saved peer/pin
   and exact remote UUID. It changes no keys, pins, identities or grants.
   This is verification, not automatic one-way-link repair. Repair requiring
   key acceptance uses the same explicit review/confirm flow above; mismatching
   existing pins or enrolled keys require separate owner review and revocation.

None of this authorizes new enrollment for the separate QL attached-Copilot
scope. No live enrollment, credential collection or host-key probing occurred.

### Expired observation

After 24 hours an accepted or uncertain dispatch with no return produces
`returned.state:"expired"`, `read:false`, and an explanation that completion
was not verified. `worker.state` becomes `expired`. The worker may still run;
expiry does not mark its task Done, close it, release a lease or grant failover.
The native returns UI must preserve that distinction from Gone and Done.

## Historical September 26 assessment

Level 5 means a feature **works**, is **reliable** (errors, restarts and
offline states are handled), is **visible** (the phone or CLI shows its real
state), is **real-tool tested** (tests or fixtures from the real harness, Herdr,
SSH or git, not only mocks) and is **documented**. Each criterion is scored
**Y** (met), **~** (partly) or **N** (missing). Evidence names files, tests and
docs pages. App evidence comes from the private `phren-apps` repo (`apps/ios`),
read only. Measured on `origin/main` at 718d55eb plus this branch
(`feat/level5`), whose fixes are marked *fixed here*.

| Feature | Works | Reliable | Visible | Real-tool tested | Documented | Gaps left |
|---|---|---|---|---|---|---|
| **Conductor** (one per group, returns loop) | Y: `server-launch.ts:137` refuses a second conductor on this computer or any linked peer (409 with `target`); `dispatch-returns.ts` polls peers every 15 s and types one notice into an idle conductor | ~: silence is never a transition (`dispatch-returns.test.ts` "records nothing while a peer is unreachable"). But a dispatch whose 24 h watch ends while its worker still runs, or whose peer was removed from `hooks.yaml`, ends with no return at all. Unchecked peers now carry an offline `code` (*fixed here*) | ~: `phren dispatch returns/status`, `live_sessions`. The phone shows only the newest dispatch line (`ConductorActivityStore.swift`), with no returns list and no read state | Y: `dispatch-returns.test.ts` (12), `dispatch.test.ts` (15), `conductor-group.test.ts`, daily canary launches a real Claude conductor (`canary.ts`) | Y: [conductor.md](conductor.md) | The limit is one conductor per *linked group*, not per store: unlinked computers on one store can each run one (owner decision). No return when the watch window lapses. App: no `dispatch_returns` card or inbox, and the 409 → offer running conductor path has no test |
| **Two-way enrollment from the phone** | ~: the phone pairs itself (`pair.ts`, `PhonePairing.swift`) and adds projects (`enroll.ts`). Linking computer to computer is CLI only (`phren bridge link`, `link.ts`), and runs both ways | Y: pinned host keys, restricted `phren-hook v1 pipe`, re-linking keeps matching keys and pins (`link.ts`) | ~: Health shows unreachable and one-way peers (`/v1/health/details` `listsBack`, `HookHealthView.swift`). The phone cannot fix a one-way link | ~: `computers.test.ts` runs real `ssh-keygen`, `pair.test.ts` covers the pairing proof. `link.test.ts` covers only host discovery; nothing links two real hosts | ~: [conductor.md](conductor.md#enroll-computers), [phren-hook.md](phren-hook.md). The app's `AGENT_CONNECTIONS.md` does not cover pairing | No Hook route lets the phone link two computers. That route runs SSH key exchange on the phone's say-so, so it needs an owner decision on its security model. App: no UI test for `AddComputerView` pairing |
| **Store sync by task id** | Y: `sync/task-merge.ts` merges `tasks.md` by `bid`; claims (`task-claim.ts`); phone writes are compare-and-swap (`memory-store.ts`, 409 on change) | Y: conflict resolution with two clones and a bare remote (`conflict-resolve.test.ts`); claim race through the merge (*test added here*) | Y: `[claimed: <computer>]` in `get_tasks`; the phone's pending ops replay on a sha conflict | Y: real git in `conflict-resolve.test.ts`, `task-claim.test.ts`, `memory-store.test.ts` | ~: [store-format.md](store-format.md), [conductor.md](conductor.md). No app-side doc of bid matching | App: `GraphView.swift:405` and `MemoryView.swift:580` complete and edit tasks by *positional* id (A1/Q2), which can hit the wrong task after a remote change. `TasksFile.swift:20` parses `bid:[a-z0-9]{8}`, but the matcher only accepts hex |
| **Chat** (Copilot, attachments, effort, structured previews) | Y: Copilot transcripts (`transcript-copilot.ts`), uploads (`uploads.ts`, `/v1/upload`), effort at launch for Claude, Codex and OpenCode (`server-launch.ts:44`), live previews (`transcript-preview.ts`) | ~: failed uploads keep the text (app `AgentChatImageTests`). Copilot has no effort flag. Delivery confirmation is in flight in another lane | Y: tool cards, diffs, turn changes, reply preview rows in the app | Y: recorded fixtures `bridge/fixtures/copilot/1.0.88`, `claude`, `codex`; `transcript-preview.test.ts` (24), `model-switch.test.ts` (21) | ~: [phren-hook.md](phren-hook.md). The app's `CHAT_FEATURES.md` never mentions Copilot | App: effort is offered only for Claude and Codex (`ChatModelPickerSheet.swift:21`), though the Hook accepts OpenCode `--variant`. No test sends a non-image file through the file importer |
| **Schedules** | Y: five timing forms, Herdr or headless launch, history (`schedules.ts`, `schedule-launch.ts`) | Y: record-before-launch, blocked-at-startup detection. A Hook restart mid-run no longer strands the run as `running`, which used to block its schedule forever: the new process follows it to its real end or fails it with the reason (*fixed here*) | ~: phone list, editor and history. The app decodes `notified`/`notifyReason` but never shows them | Y: `schedules.test.ts` (41), including real Claude, Codex and OpenCode transcript shapes | Y: [schedules.md](schedules.md) | App: show whether a run's push went out (`notifyReason`) |
| **Notifications honesty** | Y: `push.ts` titles come from the real status (`needs you`, `blocked`, `failed`); the notification service extension shows the generic alert when it cannot decrypt | Y: a delivered blocked alert suppresses a second finish alert; missing APNs config is recorded, not thrown (`schedules.test.ts`, `push.test.ts`) | ~: no push for a dispatch return or a finished agent turn | ~: `push.test.ts` (11). No end-to-end APNs test | Y: [phren-hook.md](phren-hook.md#approval-push-with-your-own-apns-key), [schedules.md](schedules.md) | App: the local fallback title comes from `kind`, not `status` (`ApprovalPushNotifications.swift:132`), so a `needs-you` finish would read "finished". The notification extension has no test for a malformed payload |
| **Terminal offline reasons** | Y: Herdr socket failures keep their errno (`herdr.ts:41`); SSH failures keep ssh's first line and exit code (`peers.ts:92`) | Y: every Herdr and peer failure now carries a stable `code` (`herdr-not-running`, `peer-offline`, `peer-key-not-enrolled`, and others), forwarded through remote Hooks, on Health peers, `live_sessions` and conductor launch (*fixed here*) | ~: the phone shows Offline, Busy or Slow (`LiveHostMonitor.swift:208`); the reason text sits only in details | Y: `offline-reasons.test.ts` drives a real unix-socket Hook and a fake `ssh` binary | Y: [phren-hook.md](phren-hook.md#offline-reasons) (*added here*) | App: parse `code` (`PhrenConnection.swift:317` reads only `error`) and show the reason on the row. No tests for the Busy and Slow states |
| **Files and code** | Y: `/v1/projects/files` (`files.ts`), `/v1/files/range`, `/v1/files/resolve` and `/v1/code/*` routes (`code-routes.ts`) | Y: path containment, size caps, `@phren/code` missing reported as 503 with a hint | Y: app Files and Code screens | Y: `code-routes.test.ts` (24) over a real tree-sitter index; `files.test.ts`, `file-range.test.ts`, `file-resolve.test.ts` | Y: [code-index.md](code-index.md) | App: `AGENT_CONNECTIONS.md` does not list the `/v1/files*` or `/v1/code*` routes |
| **Graph** | Y: web and VS Code viewer (`browser/graph/`), shell Graph view (`shell/graph/`), phone graph built from the synced store | Y: host-agnostic `graph-core/`; `scripts/graph-survey.ts` across 3 to 40 projects | Y | ~: `graph-core/*.test.ts`, `shell/graph/*.test.ts`; app `GraphInteractionTests` (8) | Y: [graph-viewer.md](graph-viewer.md), [shell.md](shell.md) | App: task edits from the graph use positional ids (see Store sync) |
| **App Store** | ~: TestFlight builds ship; App Store version 1.0.0 is still in Prepare for Submission | ~: the notification extension's App ID lacks the app group, so it is not embedded | n/a | ~: `DEVICE_CHECKLIST.md` physical-device pass is still open | ~: `AppStore/` has listing, review notes, privacy label and policy | Owner only, see below |

## Owner decisions and actions

- **One conductor per store.** Today the rule is one per linked group. Enforcing
  it across computers that share a store but are not linked needs a store-level
  lease (a synced conductor claim, like task claims) and a choice of what
  happens when a lease holder goes offline.
- **Linking computers from the phone.** A Hook route that runs `phren bridge
  link` on the phone's request exchanges SSH keys between two computers. It
  needs a decision on confirmation (on which computer?) before it is built.
- **A return when a dispatch's watch ends.** Adding a state such as `expired`
  changes the `dispatch_returns` contract, and the app currently maps unknown
  states to "Gone".
- **App Store submission.** Assign `group.com.phren.ios` to the
  `com.phren.ios.notifications` App ID in the Developer portal, deploy the push
  relay, fill in the App Privacy questionnaire and the EU trader status, replace
  the demo-token placeholder, and run the physical-device checklist.
- **Push-to-talk.** The PushToTalk entitlement request and background mode.
