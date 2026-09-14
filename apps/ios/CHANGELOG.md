# Changelog

Phren for iPhone. Newest first. The app shows the section for its own version
once after an update ("What's new") and keeps the whole file under
Settings → About. `scripts/changelog.py` refuses to build a version that has no
section here; the version is `MARKETING_VERSION` in `project.yml`, the build
number counts up on its own.

## 0.0.8

### New

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
