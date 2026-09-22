# Agent chat features

Current behavior for Phren 1.0.3. Chat uses Phren Hook through the selected
computer's pinned SSH connection. The app owns its controls and follows
[the control kit](design/controls.md).

| Capability | Behavior |
| --- | --- |
| Session identity | Exact computer, Herdr server, workspace, tab, pane, provider and conversation. Ambiguous identity disables sends. |
| Live replies | Claude pane previews and Codex/OpenCode text deltas appear below activity, then become the finished reply without duplicate text or restarting its reveal. |
| Activity | Thinking and tools show elapsed time; a quiet duration remains above the reply, including stopped turns. |
| Steering | Working harnesses receive messages immediately. Queue captions come from harness transcripts. Local unsent bubbles name a connection, startup or held-prompt blocker. |
| Reconnect and history | Older pages merge by line and preserve loaded rows. Only an explicit Hook conversation reset clears current state. Missing-file placeholders do not claim history is complete. |
| Heavy transcripts | Distant rows retain measured height without building rich content. Folded tool bodies are not built. Uneven conversations open at their actual end. |
| Messages | Markdown, syntax-colored code, lossless Copy and paged tool output. Long-press actions lift the selected message over a dimmed full-screen backdrop. |
| Drafts and attachments | Drafts persist per conversation. Photos, camera, Files and system image paste add attachments; failed sends retain them for explicit retry. Uploaded files are reused. |
| Image viewer | Full detail, pinch zoom, double tap for actual size, bounded pan, phren close and swipe down to dismiss at fit. |
| Questions and permissions | Provider header and asking sentence, wrapping labels and descriptions, ordered phren radio rows, folded Action details and terminal access in the header. Terminal prompts retain their actual keys. |
| Terminal fallback | Unresolved prompts offer Open terminal. Password entry appears only for a real password read. Claude AskUserQuestion retains its card when answered through the terminal. |
| Models | Waits for the computer's catalogue. Claude uses its cached terminal menu with client-version filtering; Codex and OpenCode use live discovery. Built-in names are fallbacks. |
| Repository changes | Status, history, branches, pull requests and a working tree that keeps expanded folders and loaded children. Stage, unstage and confirmed discard use the session's repository. |
| Code | Indexed files, scoped search, full usage ranking and recent symbol changes. Dossiers include cited findings; a line note opened from chat or Changes returns to that session. |
| Agent work | Remote leads and children use their owning computer's connection. Running jobs lead; failures show age for one hour and can be dismissed. Permission refusals remain failures. |
| Conductor | Explicit launch role, model and effort, standing grants, remote dispatch, hand-off and Siri/Action button controls. |
| Notifications | Permission Live Activities plus local approval and schedule alerts during available phone execution windows. Optional direct APNs is separate. |
| Usage | Provider-reported response tokens and account windows, with sources and observation ages. No inferred percentages. |
| Terminal and previews | Herdr terminal, clipboard text/image paste, custom shortcut panels and restricted SSH web previews. |

Only input readiness holds unsent messages. A pending bubble can be edited or
removed; once submitted, its receipt stays internal until the transcript
acknowledges it. Unknown delivery is never automatically resent. See
[chat design](design/chat.md) for per-harness queue records.

Local notifications need no relay or APNs key. iOS controls background time,
so short approvals may expire between checks. A scheduled reminder says the
prompt is due, not that it ran. Tapping revalidates the current session or run.
See [notifications](design/notifications.md).

## Validation boundaries

Existing package and app fixtures cover transcript normalization, retained
history, preview replacement, steering readiness, exact answers, draft recovery,
code routes, grants and notification reconciliation. UI fixtures exercise
message actions, Code entry points, images, prompts and working-tree state.
This documentation update does not claim a new simulator or device run.

Physical camera and microphone capture, notification delivery and iOS background
scheduling still require device checks. Live connection checks use disposable
Herdr panes and pinned keys, never a user's running conversation.

See [connection details](AGENT_CONNECTIONS.md), [chat design](design/chat.md),
[Code design](design/code.md) and [conductor design](design/conductor.md).
