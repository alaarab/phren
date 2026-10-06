# Approval rules: stricter only

Owner decision, 2026-10-06: ship opt-in restrictions now. Rules have only two
effects, **always ask** and **deny**. There is no allow effect, rule-created
automatic approval, or “Always allow this” card action. Android parity is a later
slice. The existing PRs remain unmerged for Astra's follow-up security review.

## Defaults and owner control

With no rules, behavior is exactly today's behavior: the agent's own auto mode
and permission settings, plus phone approvals for whatever the agent asks.
An empty or missing rules file changes nothing. Policy is loaded and validated
before resolving repository context; absent, invalid or inapplicable rules spawn
no subprocesses. Applicable rules use Git reads with a 150 ms timeout per process
(two sequential reads per context, both contexts resolved in parallel); a timeout
falls back to today's approval path. Malformed, insecure, tampered,
unverifiable or legacy allow policy is ignored by the approval path and reported
in Settings; it must never block or answer today's requests. An uncertain rule
context also falls back to today's path. This is fail closed toward asking an
existing permission request, never toward granting permission. It does not turn
an agent's native auto mode into a more restrictive mode without owner opt-in.

Settings → Approval rules → computer lets the owner add, individually enable or
disable, and revoke rules by stable UUID. New rules are enabled only after the
owner saves the reviewed draft. Defaults are exact match, always ask, project
scope and no expiry. Each mutation requires biometric confirmation in the app
and an Ed25519 signature from the paired phone key. Saving a rule never answers
a pending request: approval or denial is a separate action in chat.

## Actual enforcement coverage

| Harness / permission path | What this slice enforces |
| --- | --- |
| Claude Code emitting `PermissionRequest` for `Bash` with a shell `input.command` | Matching deny answers deny. Matching always ask uses the ordinary phone approval path. Phone routing requires an active watcher, overview lease, dispatch lease or working push connection; otherwise the existing terminal fallback applies. |
| Claude native allowlists, auto-run, bypass/full-access modes, or any action without `PermissionRequest` | No rule enforcement. Always ask cannot force these commands to the phone; deny cannot block them. |
| Conductor dispatch/hand-off and all MCP or commandless tool calls | No rule enforcement. Existing conductor standing grants still answer matching calls. The Hook rejects creation of rules for these tools; the editor offers only Bash shell-command rules. |
| Claude `PreToolUse` | No rule guard in this slice. |
| Codex callbacks/app-server, Copilot, OpenCode, phren-agent and terminal-only dialogs | No rule enforcement in this slice; their existing permission and phone flows continue. |

Settings repeats these limits for each rule, including a plain unsupported
harness warning. Health advertises version 2, effects `always-ask`/`deny`,
Claude `PermissionRequest` coverage, `tools: ["Bash"]`, `inputField: "command"`,
`conductorTools: false`, `mcpTools: false` and `preExecution: false`. “Any harness”
scope does not create adapter coverage. Future adapters must prove their
pre-execution and permission-mode coverage before promising forced phone asks.
There is no universal risky-command, descendant-process or Face ID approval
guarantee. The app's biometric mutation gate is not server-verifiable attestation.

## Matching and precedence

Rules match an exact tool identifier and a complete command: exact byte match,
word-boundary prefix, or anchored `*`/`?` glob. No shell rewriting or risk
classification is needed to grant permission, because rules never grant it.
Deny takes precedence over always ask. Disabled, revoked, expired and unmatched
rules have no effect. Expiry is checked at request time; expired rules remain
visible for review. Turning a rule off or revoking it affects later requests,
not commands already running or a request already held for an explicit answer.

Project scope is the canonical main repository shared by its registered linked
worktrees. The live pane's repository and callback cwd must agree; an unrelated
folder with a forged gitdir pointer is rejected. Optional harness, session and
computer constraints intersect. Rules remain local to one Hook computer.
Conductor placement grants, release authority and harness sandbox settings stay
independent. A conductor may propose a rule in text; only signed mutations from
a recognized restricted phone key activate it. Prompt text and claimed owner
roles alone cannot create rules; same-user enrollment remains writable as below.

## Integrity and deferred auto-allow

The Hook verifies signed raw payload bytes, complete strict schemas, the paired
restricted `phren-iphone` key, a five-minute mutation timestamp window and unique
nonces. Signed add, set-enabled and revoke operations are retained and verified
again on every load. Unsigned, unenrolled-key or forged mutations and ordinary HTTP replay
are rejected. No audit endpoint or automatic approval ledger is needed in this
slice because there are no rule-created approvals.

The integrator's decision on Astra's stricter-only re-review is **mitigate and
disclose**, rather than block mutations. [Astra's Hook finding #1](https://github.com/alaarab/phren/pull/351#pullrequestreview-5426079340)
and [iOS finding #1](https://github.com/alaarab/phren-apps/pull/322#pullrequestreview-5426080296)
show that a same-user agent can enroll its own key and add deny/ask rules. This
can disrupt approvals but cannot grant execution; the same user can already stop
or disrupt the Hook. These rules are visible and revocable from the paired phone.
Protected enrollment comes with the protected-Hook work, not this restriction slice.

Every listed rule returns its original signer key fingerprint (`signerFingerprint`,
SHA-256 of the raw Ed25519 public key) and `matchesPairedKey`. The phone supplies
its own public key as GET `pairedKey`; this comparison identifies the signing key,
not protected enrollment or server-verifiable biometric attestation. Toggling a
rule does not change its creator. iOS shows the signer on every row, marks other
keys red with “Not created on this iPhone”, offers a direct revoke with biometric
confirmation, and warns on Settings → Approval rules when any such row exists.
A different legitimate phone also receives that warning. Failed fetches retain
last loaded rows with an unavailable-policy warning; only a successful empty
fetch displays “No approval rules”. A stale snapshot is not assurance about the
currently enforced policy.

These integrity basics do not solve same-user host compromise: an agent running
as the Hook's OS user can edit enrollment, executable/configuration, signed
history order and files. Policy sequencing, expiry clocks and audit are not
rollback protected. A removed, tampered or rolled-back stricter rule can loosen
restrictions only back to today's agent behavior, never grant beyond it. This
slice has no protected-policy or tamper-proof audit claim.

Auto-allow is deferred until the Hook runs as its own protected OS user with
owner-controlled enrollment and fixed executable/configuration/storage paths,
rollback-protected authenticated policy order and high-water state, and durable
protected audit. The executor must also constrain executable/environment,
mutable configuration/scripts and descendants, with verified adapter coverage.

This decision responds to [Astra's Hook review on #351](https://github.com/alaarab/phren/pull/351#pullrequestreview-5425477352)
and [Astra's iOS review on #322](https://github.com/alaarab/phren-apps/pull/322#pullrequestreview-5425474008):
self-enrollment under the same UID, replayed/reordered policy, mutable npm scripts,
Git fsmonitor/PATH execution, forged repository scope, missing pre-execution
coverage, erasable audit and clock rollback made automatic grants unsafe. The
iOS review also found that saving a changed/always-ask rule approved the original
request; removing the card-save callback separates those actions completely.

## Validation and integration

Hook Vitest exercises signed HTTP mutations and live PermissionRequest callbacks:
unchanged no-rule phone answers and terminal fallback for empty, missing and
broken policy with zero spawned subprocesses; bounded Git timeout fallback;
shell-only creation rejection and unchanged conductor grants; signer comparison
and cross-key revoke; deny; scope/matching; expiry; signed toggles/revocation; rejection
of allow; unsupported adapter coverage; and saving without answering. No new
production test seam is required. iOS validation is build-only: the integrator
compiles the paired app/Hook slice on the Mini. Do not run iOS suites or merge
these PRs here. The residual enrollment risk above remains disclosed for review.
