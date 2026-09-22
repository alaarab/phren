# Chat activity

One activity row belongs to each source-stamped turn. Transcript preparation
chooses its owner and position, including its placeholder label. A working row
stays at the end under the user message and subsequent tool or assistant rows.
It hides while a question, terminal prompt, password or approval needs an answer.

The initial verb is Thinking. After assistant text it is Responding. An active
tool uses ToolPresentation's decoded card title: Read becomes Reading, Patch
and Write become Editing, and other titles become Running <title>, including
Running Shell. Once tool calls return, Working covers the gap before more text.
Tool results, changes and background notifications do not start tool activity.
Only the current turn's calls choose its verb.

Use Phren's activity arc and muted caption color, with no card chrome. Reduce
Motion leaves a static arc. The clock ticks at 1 Hz in the row alone. Pin the
row to the transcript width and a 24-point caption-scaled height, and reserve a
104-point caption-scaled timer slot with monospaced digits. Seconds becoming
minutes must never change the row frame or move the transcript. Pause the clock
and arc while the scene is inactive. The row is one accessibility element with
children ignored and identifier chat-activity.

On completion, place one quiet line above the final reply: Thought for 27s
without tools, Worked for 1m 12s with tools, or Stopped after 12s for a stopped
turn. This line never spins and uses chat-activity-done. Persisted transcript
startedAt and finishedAt supply the duration on reopening. A missing start or
end gives no completed line. A local submit timestamp only fills the live gap
before the harness acknowledges the turn; it never invents a saved duration.
Completed placeholders retain the same identifier and label.

## Live reply preview

While a turn is working, show its unfinished reply below the activity row.
Claude supplies rendered pane text until the first assistant entry lands;
strip box drawing, prompt and composer lines, interrupt footers and spinners.
Codex uses accumulated thread-store text or public rollout deltas. OpenCode
uses its message part events. Those delta sources never fall back to the pane.
Publish changed text at most once every 500 ms and carry the turn start time.

The preview uses reply typography and color, with no card, selection, links,
menus or tool affordances. It is one accessibility element with children ignored
and identifier chat-reply-preview. Updating its text does not rebuild or unfold
history rows. The preview has no message identity and never enters history,
paging, copying or action counts. Publish the prepared real row and remove its
preview together without replaying the word-reveal animation. Clear previews
when a turn stops, needs input, disconnects or changes conversation.

## Message actions

Hold a message or paragraph for 0.4 seconds. The conversation root presents
Phren's action rows above a black 0.5 backdrop covering the transcript, header,
composer and safe areas. Hide the original bubble while its lifted copy is
visible. The menu and message never overlap: use the space below or flip above,
then move the pair inside the viewport. Long messages scroll in the preview,
starting at the pressed paragraph; long action lists scroll separately.

Copy paragraph, Select text, Copy message and Share retain stable action IDs
under `chat-message-menu:`: `copy-paragraph`, `select-text`, `copy-message`,
`share`. The preview is `chat-message-menu-preview`; the backdrop is
`chat-message-menu-backdrop`. Close, backdrop tap and accessibility Escape
restore both layers in one 0.18-second animation. Reduce Motion removes motion.
Selection and the system sharing service begin after dismissal completes.

## Steering and pending messages

Working, thinking, responding and compacting never create a phone queue.
A send goes immediately to the Hook's validated `agent.prompt` route. The
harness decides when to consume the input. The phone does not interrupt or
stop the turn to deliver it, and never retries an uncertain delivery.

| Harness | Working-turn delivery | Queue presentation |
| --- | --- | --- |
| Codex | Send immediately through `agent.prompt` to its input queue. | Read queued `userMessage` items from the thread store. Their identity is retained when consumed. A version that exports only the submitted user row shows that row when it arrives; the phone invents no queue state. |
| Claude Code | Send immediately through `agent.prompt`. | Read its `queue-operation` enqueue and remove records. The same bubble loses its queued caption on consumption. |
| Copilot | Send immediately through the same validated pane route. | Show the harness's user message when its event log exports it. No separate queue state is exported by this adapter. |
| opencode | Send immediately through the same validated pane route. | Show the user message from the normalized session transcript. No separate queue state is exported by this adapter. |
| phren-agent (experimental) | Send immediately through the same validated pane route. | Show its `user/message` event. No separate queue state is exported by this adapter. |

Only input readiness can leave an unsent bubble above the composer. Each
bubble names its current blocker: Disconnected, Starting, or Holding a prompt.
A verified starting pane accepts the first prompt so it can create a transcript;
further messages wait for that exact pane to attach to its real conversation.
Approvals, synchronous questions, held terminal prompts and password prompts
hold ordinary input. Async questions and queued Codex questions leave steering
available while the harness works.
A plain text question with no structured prompt still accepts the composer as
its answer. Unknown terminal status counts as disconnected input readiness.

Pending messages can be edited or removed and leave immediately when the
blocker clears, even during a working turn. Submitted receipts remain internal
until the transcript acknowledges them, and cannot be edited, removed or sent
again. A confirmed rejection keeps the draft available for an explicit retry.
