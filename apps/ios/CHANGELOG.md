# Changelog

Phren for iPhone. Newest first. The app shows the section for its own version
once after an update ("What's new") and keeps the whole file under
Settings → About. `scripts/changelog.py` refuses to build a version that has no
section here; the version is `MARKETING_VERSION` in `project.yml`, the build
number counts up on its own.

## 1.0.1

A patch on the day-one build: faster sends, a chat that stays put, and the
lock screen and Changes screen done properly.

### New

- Changes is a new screen laid out like a source-control sheet: the branch
  and counts up top, then Changes (List or Diff, with stage, unstage and
  revert, a line-number gutter, word-level highlights and folded unchanged
  runs), History with a commit graph and branch chips, Branches with local
  and remote lists, PRs from GitHub, and a Working tree browser with file
  icons and change badges.
- Lock screen: one line per running agent with its model, project, computer
  and elapsed time, waiting agents first, "+N more" past five, and no
  private paths in the step.

### Changed

- Sending is faster: the phone keeps one SSH connection per computer and
  runs every request as a channel on it, and a send, a key or a password no
  longer asks the computer about the pane first (the Hook checks the
  conversation itself right before it types). A busy agent no longer holds
  the reply for a confirmation that cannot come until its turn ends.
- Claude Code compaction shows as one small row and a header state instead
  of a giant bubble that blanked the chat.
- Focusing the composer no longer throws the chat past its end; pins are
  clamped to the laid-out content.
- Memory graph: the hover bubble is gone; findings and tasks can be edited
  and deleted from the node panel.
- Lock screen: the activity keeps its rows on one line each when the display
  dims for Always-On; the timer, which cannot tick there, steps aside.
- A background worker launched from a shell loop no longer shows the
  unexpanded label variable as its name.
- Projects: a Knobs screen sets finding sensitivity, proactivity and task
  mode per project, written to phren.project.yaml; empty means the global
  setting.
- A tool's output screen no longer shows a Done button beside the back
  chevron; back is the way out.
- What's new appears once after every update again; it used to count the
  marketing version alone, which every TestFlight build shares.

## 1.0.0

### Changed

- Spawned agents now sit under their parent agent in the sidebar, and the
  agent-tree control lives beside the agent switcher in chat input.

### New

- The composer's Paste image button (shown when the clipboard holds a
  picture) has its icon back; it used to leave an empty gap before the
  terminal and agents buttons.
- A waiting agent with a plain question in its terminal takes a typed reply
  from the composer again; the answer keys stay for real prompts, and Y and N
  appear only when they mean something there.
- Typing /permissions on a Codex chat draws its menu natively (Ask for
  approval, Approve for me, Full Access); the choice types the command and
  walks the agent's own menu with keys, without the terminal.
- Prompts an agent draws only in its terminal (folder trust, a yes/no, a
  menu) can be answered from the chat with a row of keys: Y, N, Enter, the
  arrows and Esc. The Hook accepts exactly those keys and nothing typed.
  When the prompt is a permission request the Hook saw go by, the question
  itself (reason and command) appears above the keys.
- A prompt that wants a password (sudo, a login) can be answered from the
  same row: a lock opens a field, the secret is typed into the agent's
  terminal and sent with Enter, and the phone keeps nothing.
- Typing /model, or Model in the chat options, opens a picker listing the
  models the computer's agent actually offers, with descriptions and the
  default marked, plus a field for any id; the choice is applied in the
  transcript without switching to the terminal.
- Inserting an image from the terminal now uploads it to the computer and
  types its path at the cursor; the terminal stays open.
- Sending while dictating starts a fresh recognition segment, so words already
  sent never come back into the composer.
- Coming back to a chat after the phone slept re-pins the transcript to its
  end instead of leaving it partway up the conversation.
- The chat transcript no longer lands past its end when the keyboard
  appears or goes away, or when a long conversation opens: any offset past
  the last message is pulled back on the next layout.
- The lock screen Live Activity is three short rows: project, computer and
  the elapsed time; what the agent is doing right now (read by the Hook from
  the transcript, so it shows without the chat open), in orange when it needs
  an answer and green when finished; and, with several sessions, their
  glyphs and "2 working, 1 waiting" instead of a bare count. Tapping opens
  that chat.
- Connection settings now offers the full color picker and custom hex colors
  for computers, alongside the quick swatches.
- Agent work, the agent drawer and the composer badge show running agents
  only; finished workers leave the tree, and their cards read model and
  branch on one line without a Running capsule or a chevron.
- Agent work uses compact headers and flat session-style cards for spawned
  agents, with provider, model, checkout, and running state visible at a glance.
- Agent work shows each fan-out worker's branch and worktree in its row and
  transcript header.
- Subagent transcripts open that agent's repository changes directly, with the
  same native file and diff views as the parent chat.
- Background jobs show their human description, and wrapped Codex and opencode
  workers show their label and provider mark while they run.
- Graph nodes open in the graph's own docked dossier card, the same dark-glass
  dossier the web and VS Code viewers draw, with Focus, Open project and Share;
  the graph stays visible and the zoom controls step aside.
- Agent work rows centre the provider glyph in its tile and show the model
  the worker ran instead of repeating the provider name.
- Session cards count only the subagents still running; the badge goes away
  when they finish.
- Computer names use a device color you can choose in Connection settings,
  making it easier to see which machine a session is running on.
- A subagent's card in the chat opens that agent's own transcript —
  **Follow transcript** while it works (live, through the same connection as
  the chat) and **Open transcript** once it is back — with earlier activity
  one tap away. The transcript of a finished Claude Code subagent was
  showing empty.
- A compact agent-tree badge in the chat composer shows how many spawned
  agents are still running, and agent lists and transcripts include model names.
- The ⋯ button in the chat header opens a Chat options sheet (Herdr
  workspaces, project memory, skills, graph, project context, token usage,
  another agent). The menu behind it never opened on the phone.

- Agent questions are never cut off. The card above the composer shows each
  question in full, fades where more follows, counts answers ("1 of 4"), and
  **Expand** (or **Show all**) opens the whole set as a sheet — every
  description and Claude's option previews included — that keeps the answers
  you already picked and sends from there. Option previews render monospaced.
- A session in a folder under your home no longer shows a project named
  after you (`/home/sam/Projects/hub` read as "sam"); the home folder
  is never a project, so the row says "hub" until the folder is linked.
- Hold a session for **Link to project** / **Change project** (fix a wrong
  automatic match, or name an unlinked folder) and **Rename workspace**,
  which renames the Herdr workspace on the computer.
- Messages you send from the phone while the agent is mid-turn now stay in
  the chat instead of appearing only in the terminal (Phren Hook update).
- Full tool output wraps. Recalled memories, findings and any long line now
  read on screen; a toolbar toggle brings back sideways scrolling for code
  and tables. phren's own results open unwrapped and pretty-printed, with the
  message first, instead of as escaped JSON inside JSON.
- **Open a terminal instead** on the launch form when Herdr is not running:
  the agent (or a shell) starts straight over SSH in the project folder.
  Terminal only — no chat or approvals — and it ends with the connection.
- Agent permission requests can reach the lock screen while Phren is suspended
  when direct APNs delivery is configured on the computer. Approve or deny from
  the notification; questions open in Phren for their full answer.
- Codex async questions stay visible above chat input after acknowledgement,
  including older pending questions, and can be answered with choices or typed
  text through Codex's exact-conversation inbox. Pending prompts no longer say
  “Waiting for your reply — type below”; unsupported connections explain the
  terminal fallback. Duplicate and uncertain answer submissions are not retried.

- **Add project** from the Projects tab: pick a computer, pick one of the
  repositories it offers (or paste a GitHub URL for it to clone), and phren
  there adds it and syncs the store — the project opens here, ready for
  **Open on a computer**. An empty Projects tab now starts you there.
- opencode sessions join the chat: pick it in **Open on a computer**, then read
  and send in the conversation like any other agent. A session that restarts in
  the same pane now attaches instead of staying on "Starting…".
- **Open on a computer** can start the agent on a chosen model: codex, Claude
  Code, and opencode take a model field (opencode wants `provider/model`), and
  the last model you used per harness is remembered.
- Paste a copied screenshot straight into the chat: when an image is on the
  clipboard, a paste control appears beside the message box and attaches it.
- The keyboard button in Herdr resizes the terminal once it settles, so showing
  and hiding the keyboard no longer stutters.
- Tasks, Findings, and Notes read as dense cards with section counts instead of
  plain list rows, and a new **Files** browser opens the store's markdown and
  config in a syntax-highlighted viewer.
- Hold a paragraph to copy only it, or the whole reply; double-tap a word to
  select it with native handles and copy exactly as much as you want.
- The agent's own bookkeeping has cards of its own in the chat. A subagent
  (Claude Code's Task tool) shows who it was, what it was asked, its model,
  whether it is still out there, and its report — the first screenful, the
  rest a tap away; its prompt stays behind Show prompt. Todo lists (TodoWrite,
  TaskCreate, Codex's update_plan) are a checklist with the active item lit
  and done items struck through; an earlier list a later call replaced folds
  to one line, "Todos · 3 of 5 done". Plan mode shows "Entered plan mode" as
  a system line, and a plan ready for review as a card with the plan itself
  and Approve plan / Keep planning where Claude waits for the answer.
- Web fetches and searches, skills, and other MCP servers read as
  themselves in the chat. A fetch or search is a globe card with the page
  (host and path) or the query; open it for the prompt and the first dozen
  lines of what came back as Markdown — a search's sources as tappable
  links — and Read all for the rest. Three in a row still fold into a read
  run like Reads do. A Skill call is a small "/design" chip with its
  arguments dimmed; what it loaded opens with a tap, and the chip ends the
  run either side of it. A call to any other MCP server (GitHub, Herdr…)
  gets the phren card's shape: the server as a chip, the tool as a verb
  ("Get pull request"), the input as rows, and the result's first lines
  with its keys and without the braces; phren's own card is unchanged.
- Claude Code's questions are answered from the phone. When Claude asks
  (its AskUserQuestion tool), the chat shows the questions as phren's own
  choice cards — header, question, options with their descriptions,
  multi-select where Claude allows it, an "Other…" row for your own words —
  instead of a permission card with the raw tool JSON. Send returns the
  answers inside the approval; Skip declines. The Live Activity, Siri and
  Spotlight say "Claude has a question" and offer Open rather than a blind
  Approve.
- Every picture the agent reads shows in the chat: a Read of a screenshot
  puts its frames under the tool pill without opening the card, several side
  by side, each a tap from full screen. Pictures sent from the phone show in
  your bubble too, where Claude Code used to leave only a path.
- The terminal toolbar has a Chat control wearing the pane's agent mark:
  it pops back to the chat the terminal came from, or opens this pane's
  chat when the terminal was opened on its own. The phren mark now draws
  the same size as Claude, Codex, and Copilot everywhere it appears.
- Commands that only looked around — builds, tests, greps — fold into one
  "Shell ×6" row; a call that changed a file keeps its card and its diff.
- The queued-steer strip is exactly as tall as its rows and sits on the
  composer, instead of a tall box with the message floating in the middle.
- A steer that is only a picture clears itself once the picture lands in the
  conversation, and its row no longer keeps a blank line above "1 attachment".
- Claude's shortcut tab carries the Shift+Tab permission-mode key, so
  auto-accept and plan mode are one tap away from the terminal.
- Code blocks in chat lose their title bar: press and hold copies the block
  (a brief "Copied" flash), a cut-short preview opens with a tap, and the
  language sits faintly in the corner. Inline code — paths, commands,
  identifiers — is coloured like links, with its own theme slot.
- Dictation in chat survives pauses: every segment's words are banked before
  the recognizer restarts, a restart that fails ends dictation visibly, and
  the transcript stays pinned to its end when the keyboard goes away
  instead of leaving a blank band under the last bubble.
- "Talk to Phren" — an Action button shortcut that opens the session you
  used last with dictation already listening; a Control Center toggle shows
  or hides the agents Live Activity. (Pin Session keeps its Shortcuts action
  but no longer takes one of the ten Siri phrases.)
- One compact Live Activity counts working agents across your computers;
  expand it for project and tool details, or pin a session to the first row.
- Write, Edit, and Patch cards show their changed files without opening the
  card, with input previews available on older Hooks too.
- New agent sessions open straight into chat. Send the first prompt from
  your phone and the conversation attaches as soon as it is ready.
- Phren memory and task calls have their own cards, with readable content,
  project chips, search results, and customisable colours.
- Sent messages stay softly muted until they land, without queued captions
  or duplicate bubbles.
- Pasted Claude Code images appear with their message; image placeholders
  and attachment footers disappear once the pictures arrive.
- Privacy and security hardening protects saved chat data, private links,
  clipboard copies, terminal output, and downloaded fonts.
- Account usage lists Claude's per-model weekly window (Fable) on its own
  line, dated from Claude Code's own usage check; Codex's Spark lane is left
  out of the report. The page shows each account once — computers sharing a
  sign-in are merged, and every window is one short line.
- Account usage also shows OpenCode's rolling seven-day dollar cost and live
  OpenRouter calendar-week spend, without sending provider keys to the phone.
- The working Live Activity's island is trimmed: the elapsed timer no longer
  stretches it across the screen and the phren mark is the sprite itself.
- Privacy manifest declares the file-timestamp reads, the terminal's
  reconnect clock no longer reads boot time, and the build answers the
  export-compliance question (standard algorithms only).
- Long chats keep tools compact while scrolling, with cached Markdown and
  full messages, outputs, and patches available on demand.
- Messages sent while Claude Code works appear as pending conversation bubbles;
  they become fully visible when Claude Code consumes them.
- Live sessions restore a recent complete screen or show one loading indicator,
  and brief backgrounding no longer makes every computer look stale.
- Denser project rows make more projects and navigation links visible at once.
- Herdr terminals fill the available width and keep their size in sync through
  connection, rotation, and keyboard changes.
- Session cards show when an agent last changed, with times preserved across
  Phren Hook restarts and a Recent view in the workspace drawer.
- Agents, linked projects, pins, and computers appear together on first load;
  unchanged refreshes keep the list still.
- The agent drawer has Recent/List views, workspace search, and full-width
  activity-tinted rows that highlight the current conversation.
- Two usage rings on the Sessions toolbar open account usage. Cached
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
- The usage rings live on the Sessions tab, one ring per provider you use
  (Claude and Codex both when both are), and open Account usage.
- Messages sent while the agent is mid-turn show as your bubble right away
  instead of vanishing until the turn picks them up (Phren Hook 0.2.15).
- The agent drawer reads the same live overview as the Sessions tab, so it
  opens on what is already known instead of re-fetching every computer.
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

### Fixed

- Agent chats stay at the last message when the keyboard or nearby activity
  changes height, without scrolling into empty space below the transcript.


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

- Expired permission activities stop showing the raised-hand alert. Returning
  to Phren clears expired activities and requests already resolved on the computer.
- Permission requests discovered on the Agents overview now create Live
  Activities without opening each conversation first.
- Image uploads remain available while an agent waits for an answer. A blocked
  send keeps its draft and uploaded attachment for an explicit retry, and
  follow-ups leave the queue when the agent's current turn finishes.

- "Couldn't move skill" for files containing base64 secrets.

## Earlier

Builds 1–60 predate this changelog.
