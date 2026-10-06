# Approval rules: stricter only

Owner decision, 2026-10-06: ship opt-in restrictions now. Rules have only two
effects, **always ask** and **deny**. There is no allow effect, rule-created
automatic approval, or “Always allow this” card action. Android parity is a later
slice. The existing PRs remain unmerged for Astra's follow-up security review.

## Defaults and owner control

With no rules, behavior is exactly today's behavior: the agent's own auto mode
and permission settings, plus phone approvals for whatever the agent asks.
An empty or missing rules file changes nothing. Malformed, insecure, tampered,
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
| Claude Code emitting `PermissionRequest` | Matching deny answers deny. Matching always ask prevents the Hook's existing conductor standing grant from automatically answering this callback, then uses the ordinary phone approval path. Phone routing requires an active watcher, overview lease, dispatch lease or working push connection; otherwise the existing terminal fallback applies. |
| Claude native allowlists, auto-run, bypass/full-access modes, or any action without `PermissionRequest` | No rule enforcement. Always ask cannot force these commands to the phone; deny cannot block them. |
| Claude `PreToolUse` | No rule guard in this slice. |
| Codex callbacks/app-server, Copilot, OpenCode, phren-agent and terminal-only dialogs | No rule enforcement in this slice; their existing permission and phone flows continue. |

Settings repeats these limits for each rule, including a plain unsupported
harness warning. Health advertises version 2, effects `always-ask`/`deny`,
Claude `PermissionRequest` coverage and `preExecution: false`. “Any harness”
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
independent. A conductor may propose a rule in text; only owner-signed mutations
activate it. Prompt text and claimed owner roles cannot create rules.

## Integrity and deferred auto-allow

The Hook verifies signed raw payload bytes, complete strict schemas, the paired
restricted `phren-iphone` key, a five-minute mutation timestamp window and unique
nonces. Signed add, set-enabled and revoke operations are retained and verified
again on every load. Unsigned/foreign/forged mutations and ordinary HTTP replay
are rejected. No audit endpoint or automatic approval ledger is needed in this
slice because there are no rule-created approvals.

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
broken policy; deny; scope/matching; expiry; signed toggles/revocation; rejection
of allow; unsupported adapter coverage; and saving without answering. No new
production test seam is required. iOS validation is build-only: the integrator
compiles the paired app/Hook slice on the Mini. Do not run iOS suites or merge
these PRs here. Astra reviews the rescope next.
