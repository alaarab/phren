# Harness tier 3a: interactive Claude delivery (bid:c8facfd5)

Branch `fix/claude-delivery-identity` off `origin/train/2026-10-02-hook`, 3 commits, not pushed.

## What the audit says

Source: `~/research/harness-audit.md` on omarchy (alaarab@omarchy), "Harness integration audit: Phren vs T3 Code".

- **§2.1 Enter lost on an idle Claude pane.** Herdr's `agent.prompt` pastes and presses Enter inside Herdr; Claude's Ink TUI can drop that Enter during a redraw or after a long paste. Phren patches it with an extra Enter after 1.5 s idle (`resubmitIfIdle`), a busy-pane follower (`followQueuedDelivery`) and a starting-pane Enter (`submitStartingPrompt`). Each depends on Herdr's `agent_status` being right at that instant.
- **§2.4 The phone shows "not confirmed" for delivered messages.** iOS "Not seen in the chat yet", Android "Not confirmed", and "Delivery wasn't confirmed" on `deliveryUncertain`. There are three truth sources: the Hook's text-matched UserPromptSubmit, "pending plus same identity" reported as a bare ok, and the phone's own text match against transcript rows. They disagree on queued turns, paste unwrapping, and stream lag. Matching by text also makes identical messages in flight collide. T3 gives each message an id at send time.
- **§4.4 Tier 3: Claude.** For interactive panes, keep typing and hooks but harden them. Match by a `deliveryId` where possible (the Hook remembers what it typed and compares hashes), with text only as a fallback. Report "pending, identity unchanged" as *queued*. Drop the extra Enter once Herdr can confirm submission, and ask Herdr upstream for an expected-session parameter. Dispatched and scheduled workers move to the Agent SDK (tier 3b, not this task).

## Where it already stood

Slice 1 of `docs/claude-delivery.md` shipped in #237 (0.3.19/0.3.20): `/v1/prompt` answers `{ ok, queued: true }` for pending with unchanged identity, `/v1/prompt/status` (capability `promptStatus`) answers by id, and identical words settle by conversation. The phones (phren-apps main) do not use `promptStatus` or `queued` yet; that is slice 2.

## What I changed and why

1. **Delivery id follows the typed record** (`agent-hooks.ts`, `server-pane-routes.ts`).
   - `expectDelivery(..., id)` registers the phone's `deliveryId` when the text is typed. The record carries the id, and the conversation's UserPromptSubmit settles the record, which settles the id. Before, the outcome was attached afterwards by searching tracked entries for "oldest queued with the same words hash".
   - The in-flight `deliveries` map is keyed by a SHA-256 of the normalized words, not the words, so the Hook holds no prompt text for the ten-minute guard. Text (the hash of `promptKey`) is compared once, when the hook arrives; everything after is by id.
   - Race fixed: if Claude's hook arrived while the route was running its post-paste identity probe (snapshot + `paneIdentity`, which can take a while), the old code skipped tracking (the record was gone) but still replied `queued: true`. The phone got "queued" and `/v1/prompt/status` then said `unknown` forever. Now the route reads the id's state after the probe: `delivered` → `{ ok, delivered: true }`, `blocked` → 409, else queued as before.
   - A message answered `deliveryUncertain` (probe failed) or `unsubmitted` now turns `delivered` in `/v1/prompt/status` if Claude later submits it (for example after the owner presses Enter), since its id is already on the record. It reads `unknown` until then, as before.
   - `trackDelivery` became `queueDelivery(id, target)`, which only moves `typed` → `queued` and never moves a settled message back.
2. **Delivery frames on the stream (slice 3)** (`server-stream.ts`, `server-routes.ts`, `modules/registry.ts`). A `/v1/transcripts` stream opened with `deliveries=1` (capability `deliveryFrames`) sends `{ type: "delivery", source, session, deliveryId, state }` when one of the conversation's messages changes state. It is read on the stream's tick, like side-answer frames, and is opt-in so older phones never see an unknown frame.
3. **Docs**: `docs/claude-delivery.md` (id model, slices 1 and 3 done, slice 2 now uses frames), `docs/api-reference.md`, CHANGELOG `[Unreleased] / Changed` (the section was absent on this train branch, so I added it above 0.3.20).

## Files

- packages/cli/src/bridge/agent-hooks.ts
- packages/cli/src/bridge/server-pane-routes.ts
- packages/cli/src/bridge/server-stream.ts
- packages/cli/src/bridge/server-routes.ts
- packages/cli/src/modules/registry.ts
- packages/cli/src/bridge/dispatch-returns-hooks.test.ts, prompt-delivery.test.ts, bridge.suite.ts
- docs/claude-delivery.md, docs/api-reference.md, CHANGELOG.md

## Tests

- New `dispatch-returns-hooks.test.ts` case: a message settles by its id through a pasted-content-wrapped hook prompt. It reads `unknown` until answered, the map key is a 64-hex hash, an uncertain message turns delivered, and a late queue call never reverts a settled message. The same-words test now uses ids.
- New `prompt-delivery.test.ts` cases: a hook that lands during the identity probe answers delivered; blocked answers 409; otherwise the message is queued under its id.
- `bridge.suite.ts` binding test: a `deliveries=1` stream gets `delivery` frames ending in `blocked` and `delivered`, each state once, and nothing for an unsent id. Verified that the test fails without the query param.
- Results: the focused files pass, `packages/cli/src/bridge` gives 137 files and 1664 tests passed (1 expected fail), and `pnpm build`, `pnpm lint`, `pnpm -s run validate-docs` and `tsc --noEmit` are clean.

## Herdr upstream issue draft (not filed; for the owner to send)

> **agent.prompt / pane.send_keys: expected session and submit confirmation**
>
> Clients that drive agents through Herdr need to know that input reached the conversation they meant and that it was submitted. Today `agent.prompt` pastes and presses Enter with no binding, and returns before the agent takes the input. Phren works around it: the agent's own UserPromptSubmit hook refuses text meant for another conversation, Phren rechecks pane identity after every send, and it presses Enter again when a pane stays idle with the text still in its input line. That last step guesses from a status snapshot and can answer a menu.
>
> Proposal (both additive, default off):
> 1. An optional `expect` object on `agent.prompt` and `pane.send_keys`: `{ terminal_id?, agent?, session? }`. Herdr refuses with `expectation_failed` before writing anything when the pane's current terminal, agent or detected agent session differs.
> 2. An optional `confirm_submit: true` on `agent.prompt` that waits, bounded by `timeout_ms`, until the agent leaves its input state or changes status after the Enter, and returns `{ submitted: true | false }`. `false` means the text is still in the input line, so the client can press Enter once without guessing.
>
> With these, a client can drop its post-send identity probe and its blind extra Enter.

## Not done, on purpose

- **Removing the extra Enter** (`resubmitIfIdle`, `followQueuedDelivery`, `submitStartingPrompt`). It stays until Herdr can confirm a submission.
- **Phone slice 2** (phren-apps: show `queued` as neutral, consume `delivery` frames, stop the 180 s "Not seen in the chat yet" / "Not confirmed" for a queued message). It lives in the other repo and is out of scope here; the Hook side is ready for it.
- **Matching Claude's joined queued sends.** The phone's outbox notes that Claude can join queued sends into one turn. If UserPromptSubmit ever reports the joined text, neither message's hash matches, and both stay `queued` until ten minutes pass. The CHANGELOG says Claude runs UserPromptSubmit about 340 ms after each mid-turn message, which suggests each message is hooked separately, but I could not verify it here. Substring matching on hashes is not possible, so I did not add speculative segment matching.
- No marker or id is injected into the typed text: it would show in the transcript and the model's context.
- Tier 3b (Agent SDK workers) is not covered.
