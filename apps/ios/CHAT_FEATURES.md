# Native chat feature review

Reviewed September 9, 2026 against Moshi's public documentation and the installed
`moshi-hook 0.3.19` protocol. This tracks Phren's implementation; it does not claim
complete Moshi parity. Native SwiftUI code uses the existing helper through the
configured computer's pinned SSH connection. Moshi on the iPhone is optional.

## Available in this iteration

| Capability | Phren behavior | Reference |
| --- | --- | --- |
| Existing agent conversation | Exact computer/workspace/tab/pane/provider/session selection; Codex and Claude Code | [Chat View](https://getmoshi.app/docs/chat-view) |
| Live replies | Foreground WebSocket updates; progressively reveal new words, show waiting/working/finished states, preserve scroll position and drafts on reconnect | [Gateway](https://getmoshi.app/docs/debug-gateway) |
| Response token counts | Actual provider-reported input/output/cache counts through a restricted SSH reader; updated when recorded by the provider | Phren feature; [setup](README.md#live-token-counts) |
| Earlier history | Load earlier numbered pages; keep loaded pages on reconnect, with memory bounds | [Chat debugging](https://getmoshi.app/docs/debug-chat-view) |
| Image and file attachments | Photos, camera, Files, and explicit clipboard paste; preview/remove, upload on Send, preserve failed drafts | [Image paste](https://getmoshi.app/docs/image-paste) |
| Dictation | Existing Apple Speech integration; edit transcription and add it to the draft | [Voice workflows](https://getmoshi.app/docs/voice) |
| Stop | Escape to the validated, working conversation; does not terminate the process | [Chat controls](https://getmoshi.app/docs/chat-view) |
| Readable messages | Open transcript, inline Markdown, headings, fenced code cards with Copy, individual tool calls/results with previews, paged full output with lossless Copy, copy/share messages | [Chat View](https://getmoshi.app/docs/chat-view) |
| Compact composer | Full-width multiline text, separate control row, inline status/token counts, keyboard dismissal from the transcript, and direct Herdr access | Phren feature |
| Keyboard send | Command-Return; ordinary Return remains available for multiline text | [Chat controls](https://getmoshi.app/docs/chat-view) |
| Herdr terminal | Native SwiftTerm terminal over the existing SSH connection; keyboard, Ctrl/Esc/Tab/arrows, resize, reconnect and safe detachment | [Herdr](https://getmoshi.app/docs/herdr) |
| Herdr management | Discover and select named servers; browse workspaces/tabs/panes; create workspaces, tabs and panes; rename/close workspaces and tabs | [Multiplexer chooser](https://getmoshi.app/docs/debug-multiplexer-chooser) |
| Approvals and questions | Permission explanation, Open terminal, and persistent Approve/Deny above the composer; single/multiple-choice questions; exact action IDs and stale-request rejection | [Chat controls](https://getmoshi.app/docs/chat-view) |
| Permission Live Activity | Requests received in chat can show Lock Screen and Dynamic Island actions; authenticate and open Phren to send the exact answer over SSH; expires with the helper request | Phren feature |
| Historical images | Fetch original image bytes by conversation, JSONL line and original content block; bounded cache and downsampled preview | [Chat debugging](https://getmoshi.app/docs/debug-chat-view) |
| Repository diffs | Fresh pane directory, independent diff session, changed-file list and colored patch text; read-only | [Diff Viewer](https://getmoshi.app/docs/diff-viewer) |
| Persistent drafts | Device-local text and attachments keyed by computer/server/workspace/tab/pane/provider/conversation; atomic writes, integrity checks and protected files | Phren feature |
| Project context | Insert selected Phren summaries, findings, or skills into a draft; open project memory/skills/graph | Phren feature |

Image uploads use the helper's observed `/v1/upload` API. It returns a path in a
temporary host directory; Phren appends that path to the explicit agent prompt.
This differs from the SCP location described in Moshi's image-paste guide.
There is no public image hosting or borrowing of Moshi's iPhone credentials.
Photos are re-encoded without source metadata and limited to 2,048 pixels;
attachments are limited to four files, 8 MB each. Local sent previews are bounded.

## Next iterations

| Gap | Work required before shipping |
| --- | --- |
| Browser previews | Verify URL, tunnel ownership, lifecycle, and explicit user navigation. See [Browser Preview](https://getmoshi.app/docs/browser-preview). |
| Additional providers and multiplexers | Add providers and tmux after verifying their transcript, discovery, and send contracts. |
| Account quotas, background notifications, agent creation | Separate integrations; no inferred account metrics or background agent supervision. See [Agents and Usages](https://getmoshi.app/docs/agents-usages). |

## Validation

- Herdr integration: pinned SSH to an isolated named server, create/rename/focus/close, real PTY resize/input/output, and detach preserving its shell. Original image bytes and independent diff sessions verified against the installed helper. Stale approval requests reject with HTTP 409.
- Simulator: inline approval/question responses, historical-image preview, diff/terminal navigation, and draft/image recovery after process relaunch.
- Core coverage: attachment bounds/filenames, transcript normalization, pane and
  conversation guards, history merge/reconnect/truncation, and retained caps.
- Real helper integration: fresh pinned SSH relay to an inert process in its own
  disposable Herdr pane; upload and compare image bytes on the host, deliver its
  path, receive a live reply, retrieve earlier history, and observe Escape.
- Simulator UI coverage: image preview/removal/send, upload failure retaining
  image and text, earlier history after foregrounding, stop/code cards, and
  existing conversation, project-context, pane-choice, and Moshi-preference flows.
- Physical camera/microphone capture and actual model interpretation of an image
  still require device verification. The integration fixture deliberately does
  not prompt a user's running agent.

See [connection details and limits](AGENT_CONNECTIONS.md#native-conversation).
