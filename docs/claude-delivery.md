# Delivering to interactive Claude panes

Design note for harness tier 3a (task `bid:c8facfd5`, harness audit §2.1, §2.4
and §4.4). It covers panes the owner started or watches: interactive Claude
Code in Herdr, where Phren still types. Dispatched and scheduled Claude workers
moving to the Agent SDK is tier 3b and is not covered here.

## Where it stands

A phone message to a Claude pane is typed by Herdr's `agent.prompt`. The Hook
then waits for the conversation's own UserPromptSubmit hook to report the text.
It matches the words (`promptKey`: pasted-content wrappers and picture paths
removed, whitespace folded) and gets one of three outcomes:

- **delivered**: this conversation submitted it within 1.5 s (2.5 s more after
  one extra Enter on an idle pane);
- **blocked**: another conversation in the pane submitted it, and the hook told
  that conversation to drop it (409 to the phone);
- **pending**: nothing yet. A busy Claude queues typed input and only submits
  it when the turn ends, which can be minutes later.

Before this change, pending with the same conversation in the same terminal was
answered with a bare `{ ok: true }`. The phone read that as not confirmed and
showed "Delivery wasn't confirmed" or, after 180 s without a transcript row,
"Not seen in the chat yet" (iOS) and "Not confirmed" (Android), even though the
message was sitting in Claude's queue as intended.

Matching also had a collision: two identical messages in flight to two
conversations in the same pane settled the oldest record, so the second
conversation's own submission was refused as the wrong conversation.

## What can and cannot be matched by id

Typed input carries no id. Claude's UserPromptSubmit payload has the prompt
text and the session, nothing Phren chose, and adding a marker to the text
would show up in the transcript and the model's context. So the bytes Phren
typed and the words the hook reports are still compared once, on the Hook,
where both sides are in hand. Everything after that is keyed by id:

- the phone names each message with its `deliveryId` (already sent on every
  attempt for `PromptOnce`);
- the typed record carries that id and is keyed by a SHA-256 of the prompt's
  words, so the Hook holds no prompt text while it waits (ten minutes);
- the Hook keeps, per `deliveryId`, the conversation and its state; the
  hook's answer settles the record, and the record settles its id;
- the phone asks by id, or hears it on the conversation's stream.

The phone then never matches its own text against transcript rows to decide
whether a message arrived.

## Slices

### Slice 1 (Hook only, done)

1. `POST /v1/prompt` answers `{ ok: true, queued: true }` for "pending,
   identity unchanged": same terminal, and a fresh identity probe still names
   the target conversation. A failed probe stays `deliveryUncertain`.
2. `POST /v1/prompt/status { target, deliveryId }` returns `queued`,
   `delivered`, `blocked` or `unknown`. Advertised as
   `capabilities.promptStatus`. The id is registered when the text is typed
   and reported once the Hook answered, so a hook that lands while the Hook
   still probes the pane's identity turns the reply into `delivered` (or
   409), and a message answered `deliveryUncertain` still turns `delivered`
   when the agent takes it.
3. `submitted()` settles the record for the submitting conversation first and
   blocks only when no record for that conversation has those words.

Nothing a phone does today changes: `queued` is an extra field on an `ok`
reply, and a phone that ignores it behaves as before.

### Slice 2 (phones, phren-apps; not started)

- Show `queued` as a neutral pending state ("Queued, sends when Claude
  finishes"), never as a warning. Keep the outbox echo until the queued row or
  the user row lands.
- Open the transcript stream with `deliveries=1` and follow a `queued`
  message by its `delivery` frames (`/v1/prompt/status` after a reconnect),
  and clear the pending echo on `delivered`. On `blocked`, show "Not delivered, send again". On `unknown`
  fall back to today's transcript match.
- Stop raising "Not seen in the chat yet" / "Not confirmed" for a message the
  Hook called queued until the pane has been idle for a full status tick with
  the message still unsubmitted.

### Slice 3 (Hook, push instead of poll; done)

A `/v1/transcripts` stream opened with `deliveries=1` (capability
`deliveryFrames`) sends `{ type: "delivery", source, session, deliveryId,
state }` for the conversation's messages whenever one's state changes, so the
phone does not poll. Same entries as slice 1, read on the stream's tick like
side-answer frames.

### Slice 4 (Herdr upstream)

The extra Enter (`resubmitIfIdle`, `followQueuedDelivery`,
`submitStartingPrompt`) exists because Herdr cannot tell Phren whether the
pasted text was submitted, and the identity recheck exists because Herdr
writes to a pane, not a conversation. Both go away with two Herdr parameters.
Draft issue for the owner to file (not filed):

> **agent.prompt / pane.send_keys: expected session and submit confirmation**
>
> Clients that drive agents through Herdr need to know that input went to the
> conversation they meant, and that it was submitted. Today `agent.prompt`
> pastes and presses Enter with no binding, and returns before the agent takes
> the input.
>
> Proposal:
> 1. An optional `expect` object on `agent.prompt` and `pane.send_keys`:
>    `{ terminal_id?, agent?, session? }`. Herdr refuses with
>    `expectation_failed` before writing anything when the pane's current
>    terminal, agent or agent session (as Herdr detects it) differs.
> 2. An optional `confirm_submit: true` on `agent.prompt` that waits (bounded
>    by `timeout_ms`) until the agent leaves its input state or its status
>    changes after the Enter, and returns `{ submitted: true | false }`.
>    `false` means the text is still in the input line, so a client can press
>    Enter once without guessing from a status snapshot.
>
> Both are additive and default off.

## Out of scope here

- Dispatched and scheduled Claude workers on the Agent SDK (tier 3b).
- The Codex and OpenCode paths, which already acknowledge with turn ids on
  Hook-run panes.
