# Changelog

Phren for iPhone. Newest first. The app shows the section for its own version
once after an update ("What's new") and keeps the whole file under
Settings → About. `scripts/changelog.py` refuses to build a version that has no
section here; the version is `MARKETING_VERSION` in `project.yml`, the build
number counts up on its own.

## 0.0.8

### New

- Session cards show when an agent last changed, with times preserved across
  Phren Hook restarts and a Recent view in the workspace drawer.
- Agents, linked projects, pins, and computers appear together on first load;
  unchanged refreshes keep the list still.
- The agent drawer has Recent/List views, workspace search, and full-width
  activity-tinted rows that highlight the current conversation.
- Two usage rings beside the chat's agent mark open account usage. Cached
  limits appear immediately when reopening usage pages.
- Calmer borders, consistent corners and spacing, and subtle panel highlights
  bring chat tools, background jobs, drawers, and settings together.
- Returning to chat images reuses cached thumbnails; transcript rendering
  and startup keep expensive work away from the main thread where possible.
- Drill-in screens now push sideways with system edge-back, hold-and-swipe back
  from the middle of the screen, and Escape or Command-[ keyboard navigation.
- Live sessions reveal in one complete view after the computers answer, then
  refresh in place without rebuilding every section each second.
- Cached chat text, tool presentation, diffs, and display-sized image decoding
  keep long agent transcripts responsive while scrolling.
- Build richer Shortcuts with typed session status, bounded transcript text,
  message-and-wait replies, and a Start Agent Session action.
- Filter live sessions by computer or phren store from a Focus, with suggested
  filters and a clear control on the Agents screen.
- Session cards now expose project, title, metadata, working, waiting, and done
  colors in custom themes while older saved themes keep their existing look.
- Chat folds three or more consecutive file searches and other read-only
  commands into one expandable row, while keeping every original tool card.
- Background agent commands stay visible above the composer with their
  running time, completion status, exit code, and available output.
- Sessions outside a linked phren project use their folder name and offer a
  direct Link to project action instead of showing a misleading workspace label.
- Switch agents from a searchable workspace tree that slides in from the left
  of chat, including with an edge swipe.
- Open the same Agents drawer from the terminal's new default Agents control;
  the control can be reordered or removed in Terminal toolbar settings.
- Find live agent sessions and projects in Spotlight on iOS 18 and later. Open
  a chat or project directly, message a session, or open its terminal.
- Ask Siri what an agent is doing or which sessions need input. The answer is
  spoken without opening Phren and includes a session card with Open and,
  for pending permissions, Approve and Reject.
- Open the session that needs you most from Control Center, the Lock Screen,
  or the Action button using Phren's shortcuts.
- Track working sessions on the Lock Screen and Dynamic Island with the Phren
  icon, project, branch, elapsed time, current tool, and a tap back to chat.
- Ask Siri to pin a named working session to its Live Activity.
- Catch up after time away with an Apple Intelligence summary of a session's
  recent work, state, blockers, and suggested next step, generated on-device.
- Optionally tighten dictated agent messages with Apple Intelligence, then
  preview and choose the clearer wording or the original before sending.
- Send a terminal, error, or diff image from Shortcuts or Screenshots into
  the live agent session that needs attention, then review it before sending.
- Reviewed Apple's assistant schemas for session and project actions; the
  published file, document, search, and visual-search domains do not describe
  coding-agent sessions, so Phren keeps their precise App Intent contracts.

- Slash commands and `!` shell lines typed at the agent's own prompt read as quiet system lines with their output, not bubbles of tags.
- A picture sent with a message sits inside the same bubble as the words; the
  path list and paste markers no longer show once the picture draws inline.
- Session cards are one flat rounded rectangle each, under small upper-case
  section labels — no box around a section, no border, no lines between
  them. The computer's name sits beside the branch instead of on its own line.
- Scrolling up in a chat loads a few earlier pages at a time again instead
  of the whole history; a long conversation no longer hangs on open.
- Background jobs read as running until the agent's own completion notice
  arrives, keep their real start and finish times, and leave the row two
  minutes after finishing; a completion notice never draws as a bubble.
- A conversation opens on a light first page (Phren Hook 0.2.15) so a big
  one no longer freezes; scrolling up fetches fuller pages.
- Closing a session from the list closes that session and the card leaves at
  once — swipe for a direct Close, hold for Close tab / Close workspace with a
  confirmation. Cards drop the redundant state text (the section already says
  it), keep the computer name, and colour the project name.
- Simulators: every iOS simulator booted on a computer, with its live screen,
  from the Agents header or a computer's page (needs Phren Hook 0.2.15).
- Files: put any file on a computer through Phren Hook and copy its path for
  an agent; chat attachments are no longer limited to images.
- Keyboard: ⌘K shortcuts panel, ⌘V paste, ⌘J chat, ⌘⇧M dictation on a
  hardware keyboard; Option as Meta; auto-hide the toolbar while one is
  connected.
- Notifications: turn the approval Live Activity off, keep the Agents screen
  awake.
- Phren Hook: the install command with Copy, and each computer's Hook
  version at a glance.
- Show on Agents: choose which of Web servers, Simulators and Files sit in the
  Agents header.
- Enter closes the terminal's arrow pad; the arrows and editing keys keep it up.
- Agents list: Done sits above Idle, and within a group the session whose
  agent changed most recently comes first (Phren Hook 0.2.15).
- The shortcuts panel is denser: four to a row, the command and one word,
  agent tabs as glyphs, Add in the header.
- Full-screen diffs scroll sideways again for long lines.
- Session details is a proper page: the agent's mark in its state's tint,
  the title, project · branch · computer, a state pill, Chat and Open
  terminal buttons, this computer's account limits, the facts, Close session.
  The ring on a session card opens it; the (i) button is gone.
- Queued messages no longer leave a hole above the composer.
- Close a session from the list: swipe a card, or hold it to close the tab
  or its whole workspace on the computer.
- Herdr workspaces read as one tree — workspace rows you can fold, tabs with
  the agent's mark, a dot for the ones that need you, the tab Herdr has in
  front highlighted — with search across workspaces, tabs and agents.
- Session cards say more at a glance: the harness's mark inside a ring
  that carries the state (spinning cyan while working, amber when it needs
  you, green when done), a state badge on the ring, the project in bold with
  its branch, then the conversation title and a coloured state line.
- The real agent marks everywhere: Claude's starburst, OpenAI's knot for
  Codex, GitHub Copilot's goggles.
- Dictation types straight into the message as you speak — tap the mic, talk,
  tap again — instead of a separate box to review first. "Send after
  dictation" in Settings → Chat sends it on the second tap.
- Images an agent reads on the computer (a screenshot it opened with Read)
  show in the tool card, not just "[Image attachment]".
- Wrap long lines, separately for chat (Settings → Chat: code blocks, tool
  output, diff cards) and for the full-screen diff editor (its ⋯ menu).
- Inline diffs — chat cards and the full-screen editor — use one narrow
  number column with the sign inside it, so the code gets the width. Side by
  side keeps a number per column.
- Simulators are interactive: tap the screen to tap the device, Home, Lock,
  type text, launch an installed app, open a URL, shut it down (swipe a row
  too). Touches need one Accessibility grant on the Mac for Phren Hook's
  helper; the first tap says what to allow.
- "Hey Siri, tell mina on mini in Phren" — then say the message. Name a
  running session or just a project: when nothing is running there, phren
  starts the agent in the project's folder first, then delivers the message.
  "Open mina in Phren" opens that chat, starting the session when needed.
  Both in Shortcuts as "Message Agent" and "Open Session".

## 0.0.7

### New

- Settings regrouped: Terminal (Theme, Fonts & Size, Chat, Advanced), Input
  (Toolbar, Shortcuts, Gestures, Speech), Integrations, Memory, About.
- Fonts & Size: a font-size stepper, JetBrains Mono, Fira Code and Hack
  downloaded on demand, and your own .ttf/.otf imported from Files — all
  drawn by the terminal's own renderer.
- Chat: choose whether a session opens in chat or the Herdr terminal, send
  dictation straight to the agent, and turn chat autocorrection off.
- Advanced: cursor style (block, underline, bar) and blink, keep the screen
  on while a terminal is open, terminal autocorrection.
- Gestures: pinch, hold-to-select and two-finger swipes can each be turned
  off.
- Speech: pick the dictation language, try a test transcription, and add word
  replacements for names the recogniser gets wrong.
- Attach up to twenty images or files to one message (was four).

## 0.0.6

### New

- Shell commands show what they changed, right under the call: each file as a
  row with its counts, tap for the diff, expand it full screen. Phren Hook
  snapshots the working tree — and the phren store — around every shell call.
- Repository changes also lists other repositories a session wrote to, and
  commits a hook already made.
- Open on a computer: from a project, pick the computer, phren finds the
  folder, pick the harness, and the chat opens in a new Herdr workspace.
- Queue messages while the agent works — Send now, Edit, or remove; the first
  one goes out when the turn ends.
- The chat header shows the agent's glyph, then project · model · branch, with
  the diff button beside it.
- The diff editor follows VS Code: line numbers, tinted rows, changed
  characters, next/previous change, inline or side by side, syntax coloured.
- Tool cards show the full command, output that scrolls sideways, and named
  titles for Read, Grep, Glob, Fetch, Todos and Agent; Write and MultiEdit
  are drawn as diffs.
- phren-agent joins Codex, Claude Code and Copilot as a chat provider.
- The Ctrl-hold shortcut panel can close after a shortcut (Settings).

### Improved

- Chat text is brighter and larger; tool chrome is grey; the accent stays on
  Send and Stop.
- The sessions list wastes less space around "Sessions across your computers".
- The secret scanner matches the CLI, so moving skills no longer trips on
  long base64 strings.

### Fixed

- "Couldn't move skill" for files containing base64 secrets.

## Earlier

Builds 1–60 predate this changelog.
