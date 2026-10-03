# RC regression source — UNRUN

No test runner, build, typecheck, native process, provider, SDK, installer,
network, emulator or simulator was invoked for this slice. Syntax parsing and
git diff whitespace checks do not establish runtime correctness. The integrator
owns later build slots and runtime validation; the four-heavy cap and Mac holds
remain unchanged. Build-only core development and all requested core+iOS source
must be integrated before one full RC/TestFlight. Android may trail; no App Review.

## Authored automated regression source

| Source | Defect caught / required observation |
| --- | --- |
| contract.test.ts: journal shutdown | Final closed-journal events are drained; a waiting ended-session consumer exits |
| contract.test.ts: TurnSubmissions | Concurrent/repeated stable ID submits once; changed text rejects; an uncertain reply never submits again |
| contract.test.ts: ACP request IDs | Typed native permission IDs cannot collide; one-time approval remains session-scoped |
| contract.test.ts: expired blocked return | Aging a blocked worker retains approval data and cannot close its pane |
| owner-controls.test.ts | Independently signed wire fixture succeeds once, persists nonce, rejects computer key, route/body tampering and revoked owner key |
| remote-proxy.test.ts | Existing Copilot pane stays session-less; structured controls cannot read/type/ack; stale screen binding is discarded; exact registration owner gates replacement/removal; fake session/generic runner registration rejected |
| store-lease.test.ts | Lease required, one admission only, no elapsed-time expiry, expected-ID revoke only; offline pinned authority blocks ordinary launches and cannot redirect authority |

These tests are source, not evidence of a pass. Their pre-fix failures were not
executed under the owner's source-only restriction. Transport doubles in the
lease suite isolate the network boundary; the future tests use temporary state,
not the live store. The owner-proof fixture does not call production signing code.

## Required native/phone/fault-injection RC scenarios

| Scenario and setup | Acceptance boundary |
| --- | --- |
| Claude SDK with owner's existing subscription; fresh session, turn, approve once, deny, interrupt, default/plan resume | Exact native session retained; no credential probing, API-billing fallback or broader resume permission; replayed old result cannot finish a new turn |
| SDK or ACP ends/crashes while a stream consumer waits | Final failure drains and consumer terminates; parked requests cannot be approved after owner/process replacement |
| Hook reconstruction with runner alive, turn RPC reply lost, then same delivery ID | One native submission, stable receipt; noack remains queued/uncertain; approvals and thread window reconstruct from runner |
| Runner dies, native session resumed by a replacement runner | Old owner target rejected; explicit registration required; UI does not claim old delivery IDs survived runner death |
| IPC registry/socket symlink, nonprivate mode, foreign UID, changed terminal or foreground PID | Reject before delivery; never unlink/take over a socket due to age; closing observer keeps actual worker alive |
| Concurrent starts for one pane or the one-agent proxy, using two configured ports; prior or abandoned owner registry/lock | Ownership reservation rejects before native adapter construction; at most one agent starts; abandoned lock never clears by timeout |
| Owner POST replay after Hook restart, ±120 s limit, method/body/path change, computer SSH key | Refusal without control; revoked paired phone key is checked on every request; fresh-nonce capacity refuses before mutation |
| Fixed lease authority offline during schedule, worker, conductor or canary launch | No new launch; old conductor never loses authority due to time; no machine linking or authority election |
| Two computers race the same conductor grant; failed launch retains admission | At most one admission per lease; expectedLeaseId must match for owner revoke/takeover; no silent retry/failover |
| Existing peer repair after missing routing row | Same independently verified pin and UUID, existing enrollment only, no key exchange; wrong pin/UUID and endpoint collision reject |
| New enrollment presented without signed owner, confirmation or verified known-host pin | Reject before SSH/key exchange; authorized explicit path preserves existing unrelated keys and peer rows |
| Owner confirms one existing QL reverse-SSH Copilot terminal under Omarchy; no enrollment | Separate version-2 terminal-only row; null session/nativeSession/chatTarget; owner-declared origin and unverified remote transport; no SSH or runner launch by proxy source |
| Copilot pane/process/terminal changes, Hook restarts, registration replaced during screen read | Binding-changed/unavailable row; read discarded; no token promotion to session; explicit signed owner re-registration and exact prior ownerId required |
| iOS version-2 proxy discovery, metadata, terminal screen, attempted chat/transcript/control | Terminal attachment only; correct unsupported 409/code; no transcript route, queued turn/ack or native approval UI; screen is not a conversation or phone acceptance |
| Actual Herdr + default/hidden/custom tmux servers concurrently | Every server/terminal identity kept distinct; no missing or duplicate agent introduced by harness overlay; public aggregation verified on actual combined source |
| Codex direct and OpenCode native requests during Hook restart | Native request IDs and session identity remain scoped; unavailable native status/history capabilities stay false rather than fabricated |
| Accepted/uncertain worker blocked for >24 h | `expired` with approval retained; never done, never auto-close; owner resolves the existing native request |
| Linux upgrade with long-running agent outside Hook scope | Bundle/unit/current writes complete before single restart; worker remains outside stopped service; readiness matches selected version |
| Inject copy/rename/fast-hook/dispatch/askpass/unit failure before activation | Prior Linux Hook is never stopped; exact prior mutable artifacts restored; install lock prevents concurrent writer |
| Inject activation/restart/readiness/apply-hooks/metadata failure; same-version reinstall and first install | Prior symlink/bundle/unit/metadata restored, or newly activated first-install link removed; previous version restarted only when activation occurred; concurrent agent setting edits preserved |
| Kill installer at staging, activation or restart boundary | No truncated bundle/unit; old running service retained until restart; report interrupted install and require explicit owner reconciliation, without claiming catch rollback executed |

## Source integration dependencies and limits

The inherited lead snapshot is a separately committed set of 28 exact files,
not a promise that the partial checkout includes every other lead WIP module.
In particular inherited server-routes expects the lead task directory route;
its task/data owner must supply that implementation. This worker does not edit
task-routes/data/sync or packages/agent. SDK/native schema/version compatibility,
Windows executable/ACL behavior, the owner-established SSH attachment and phone UI
adoption are external runtime/integration gates, not source-validation results.

The owner-specified Astra integrator exclusively combines and publicly pushes.
This worker returns local snapshot + own delta commits, bundle/patch hashes and
dispatch_report; there is no public push, invented PR or runtime acceptance.
