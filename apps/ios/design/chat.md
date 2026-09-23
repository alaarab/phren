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
and arc while the scene is inactive. The line is one accessibility element with
children ignored and identifier chat-activity.

For Claude the Hook reads the whole spinner line from the pane and sends it
beside frames as `activity` (verb, elapsed seconds, tokens with direction,
thinking, thought-for). The line then reads as Claude's does:
`✻ Whirlpooling… (34s · ↓ 3.1k tokens · thinking)`, the glyph in the running
color and turning once a second (static under Reduce Motion), the time from the
phone's own clock. Only the activity row observes these fields, so a token
update redraws that row alone. Codex and other harnesses keep the line above.

A live line ends in a stop ring, `chat-activity-stop`: a 22-point track with
the running arc around a stop square, in a 44-point target, so the live row is
44 points high at every tick. It sends the same stop as the composer's stop
button and is enabled whenever that stop would be, with or without a draft.
The composer keeps its own stop.

On completion, place one quiet dim italic line above the final reply: Thought
for 27s without tools, Worked for 1m 12s with tools, or Stopped after 12s for a
stopped turn. When the harness named the turn (Claude's last spinner verb for
that turn, kept by its start), the line uses it in the past tense, Brewed for
18m 18s, from a fixed map of Claude's words, and Worked for when the word is
not in it. This line never spins and uses chat-activity-done. Persisted transcript
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

## Text selection and the composer

Selection takes priority over conversation scrolling and keyboard dismissal.
Read the composer's UITextView selectedRange and UITextInteraction gesture
states: a nonempty selection or a handle or loupe drag freezes the transcript
and switches keyboard dismissal to never. Restore interactive dismissal as
soon as the range collapses and the interaction ends. A plain transcript drag
still lowers the keyboard. Composer and icon-row dismissal gestures must obey
the same selection guard.

The composer grows from one to four lines at the current text size, then
scrolls internally. Keep UITextView scrolling enabled so dragging a handle
past the visible lines follows the selection through the entire draft. Do not
scroll the whole selected range into view or hand that drag to the transcript.
In a message's Select text mode, use the same selection and gesture guard;
handle movement must neither dismiss the keyboard nor end selection by moving
the transcript. Done or a tap outside the paragraph still leaves selection.

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

## Sub-agent composers

Child navigation keeps the tree's `navigationID`, including the computer and
parent-scoped child identity. An agent with its own verified pane opens that
session's full chat and composer. Its note says "Messages go directly to this
agent session." Unknown computers still require enrollment; an offline pane
keeps ordinary chat connection behavior.

A fan-out worker has an explicit Hook continuation capability. Its note above
the Phren message field says "Continues this worker's own session. Messages
wait in its queue while it runs." Send uses `POST /v1/subagents/resume` with the
validated parent target, opaque child id and text. A completed worker resumes
its existing Codex or OpenCode session in its original worktree. A running
worker receives a durable queued message and starts the next round only after
finishing. `GET /v1/subagents/messages` supplies receipt state across reopening.
Queued bubbles say "Queued until this worker finishes" and stop showing as
queued once the Hook starts that round. The resumed user turn and reply remain
in the same child transcript. Finished resumable workers remain in the tree.
A worker without a resumable session has a disabled field and explains why.

In-process Claude Task agents and Codex spawned threads cannot receive phone
input. Their note says "This sub-agent cannot receive input. Your message goes
to its parent, labeled with this sub-agent's name." Send goes through the
parent's validated prompt route with `About the <label> sub-agent: <message>`.
The child transcript stays scoped to the child; the delivery receipt names the
parent. A failed or uncertain send preserves the draft and never retries
silently. Fields, send controls, notes and queue receipts use Phren surfaces,
colors, wrapping text and 44-point action targets.
## Narration

Claude's narration between tool calls (text the Hook marks `narration: true`)
is a dim italic `Thinking: …` line, not reply text. Folded it is one line with
an ellipsis; a tap opens the whole note in place and another folds it. It has
identifier `chat-narration:<message-id>`, value Collapsed or Expanded, and is
never the reply the finished activity line sits above.

## Tool pills

Every call is a quiet 44-point pill while folded: icon, tool name, one-line
summary and a status mark. The mark is amber for running, a green check for
finished and the theme's danger mark for failed. A tap opens the full input and
output in place; another tap folds it. Two or more calls in a row of the same
tool with the same kind of input (not edits, pictures, background jobs or
cards) fold into one pill, `Shell ×2`, that opens to each call; a failure
inside shows the danger mark on the folded pill. Other MCP servers' calls use
the same pill (`chat-mcp-card:<call-id>`), with the full reader behind
`chat-mcp-open:<call-id>` once opened.

Colors carry meaning in the transcript: `chatPath` for file paths and links,
`chatBranch` for the repository branch, `chatRunning` and `chatFinished` for
call state, `chatNote` for narration and the finished line. Each has a light
value for light custom themes. Phren purple stays on buttons and phren cards.

## Header and keyboard

The header's capsule sits on a solid band of the chat canvas from the top of
the screen to just below the capsule. The transcript starts below the header
and its top 16 points fade into the canvas (`ChatHeaderFade`), so a row
leaving the top dissolves instead of stopping at a hard edge; no row shows
beside or above the title. The title truncates in the
middle. Project, model and branch each truncate on their own: when the line is
short, the widest part gives up width first, so the branch always keeps a
share.

The transcript's viewport keeps its bottom anchored when the keyboard resizes
it, in the keyboard's own animation: the latest message rises with the
composer and falls back when the keyboard hides or is dragged down, and a
reader in history keeps the same message above the composer.

## Phren tool cards

The card body toggles full input and output in place. Folded, the card is the
height of a tool pill: the mark, verb, project chip, one line of result (the
failure's reason when it failed) and its status. Expanded content wraps, is selectable,
and has no height cap. The 0.18-second animation respects Reduce Motion.
`chat-phren-card:<call-id>` remains the body control; its accessibility value
is Folded or Expanded. `chat-phren-expanded:<call-id>` identifies the full text.

A separate 44-point chevron, `chat-phren-open:<call-id>`, opens a resolved task,
finding dossier or the captured search results. Task and finding resolution
requires the originating store (or an explicit attached store), project and a
unique stable ID or exact text match. Missing, ambiguous and unsynced targets
have no chevron. Positional task or finding IDs are not trusted across syncs.

A failed call uses a danger-colored Failed label and a one-line reason from
the result, including errors nested in MCP content or structured results.
The same expand gesture exposes raw error text. Transcript cards have no API
for safely replaying an exact call. They offer no Retry until such a route can
prove both the target and replay safety; writes are never replayed from a card.
