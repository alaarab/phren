# Changelog

Phren for iPhone. Newest first. The app shows the section for its own version
once after an update ("What's new") and keeps the whole file under
Settings → About. `scripts/changelog.py` refuses to build a version that has no
section here; the version is `MARKETING_VERSION` in `project.yml`, the build
number counts up on its own.

## 1.0.3

### Changed

- A session waiting on a permission reads "Permission needed" instead of "Blocked", and tapping it (or its notification) opens its details led by the request, as Moshi does: the agent, the tool it wants, the project, computer and time with a PERMISSION chip, what it asks, Chat and Terminal, then Deny and Approve. This works long after the computer's 55-second hold ends: the answer types the Yes or No row the agent still shows in its terminal.
- The Agents tab opens on your last known sessions instead of a blank page with a spinner. A list saved more than a minute ago shows greyed, with every computer Connecting…, and each computer's live sessions replace it as they answer.
- Approve and Deny on the lock screen (hold the notification) keep working after that hold ends, still behind Face ID or the passcode, and an answer that doesn't reach the computer now says so in a notification instead of failing silently.
- A message whose delivery the computer could not confirm no longer goes back into the message box. It had usually arrived, so the next message you typed or dictated sent it a second time in front of the new words. It stays as a pending bubble with Retry and Dismiss instead.
- New session in a worktree is easy to find: it is a row in an agent chat's ••• options, in a session card's hold menu, and in a project's Open on computer sheet and sessions page. From a session it starts on the same computer with the same agent, and the branch is named after the session's title (`phren/polish-the-phone-app`); from a project it gets a short id. The launch screen opens with Work in a new worktree already on and the branch editable. The conductor never offers it.
- Talk mode in an agent chat, meant for the conductor: the waveform button next to the microphone turns it on. It listens until you stop talking, sends your words, and reads the agent's final reply aloud once its turn ends, skipping tool calls and code blocks. Talking over a reply stops it and starts your next turn. A bar above the message box says Listening, Thinking or Speaking, shows the words it hears, and has Stop. Replies use the computer's ElevenLabs voice (the key stays on the computer); when the computer can't, or the phone is offline, the best Apple voice on the phone reads them.
- Dictation uses iOS 26's long-form dictation model when it is on the phone. One recognizer listens for as long as the microphone is on, so a long pause or a send mid-dictation no longer drops or repeats words. The microphone runs with the system's echo cancellation, noise suppression and gain control, and the recognizer is told "phren" and your stores' project names and replacement words. Until the model is downloaded (it starts in the background the first time), the older recognizer is used as before.
- One code browser per project. Code's Files lists every file in the checkout, not only indexed ones, and a file opens in a code viewer with syntax colors, line numbers and, for indexed files, an outline to jump through. Names the index knows are tappable and open a compact symbol panel with its definition, references, usage and cited findings; Go to definition and each reference open that line, in the same file or the other one. Recent opens the file at the symbol. Files over 2 MB, and files that are not text, say so and open in the file viewer, as pictures, video, PDF and CSV still do. A computer's Files page and the Memory tab's Files now open a project into this browser instead of a separate file list, and unchanged text files in Changes' working tree open in the same viewer.
- The agent chat's switcher has one header row of icons instead of a search field and a Recent/List segment: Search (magnifier), Recent (clock) and List (bullet) on the left, Close on the right. Search opens an inline field with a Cancel that clears it and returns the icons; the chosen order icon is highlighted and the row's height stays 44 points.
- The agent chat's + opens a small menu right above the button (Photos, Camera, Files, Paste image, and Project memory) instead of the full Add attachment sheet. Picking Photos, Camera or Files opens the system picker directly; the sheet remains for attaching from a terminal.

- Changes can finish a session: a commit message field and Commit button over the staged files, then Push and Open pull request. Push and the pull request ask first; pushing the default branch says so and needs its own confirmation, a pull request can open as a draft, and a refusal from a commit hook, the remote or GitHub's CLI is shown exactly as the computer printed it. Once the branch has a pull request, its button opens it.
- A session card shows its branch's pull request: its number, open, draft, merged or closed, and whether checks pass, fail or are still running. The card never asks on its own; it updates when Changes loads or refreshes and when the overview first appears or is refreshed.

- The agent chat does less work while you read and scroll it. Streaming updates, status ticks and typing redraw only the part of the screen they change (the rows, the header or the message box) instead of the whole chat, and rows far from the screen fold without work on every scrolled frame, so a long conversation scrolls with far fewer dropped frames.
- Agents, a computer's page, session details and project sessions no longer redraw every second. Only the elapsed times ("3m ago", a turn's running time) tick, from one clock for the whole app, and a computer turns stale at the moment its last answer ages out.
- With an updated Phren Hook, each computer pushes its session list to the phone when something changes, instead of the phone asking every ten seconds; an older Hook is still asked, and so is any computer whose push connection drops. A computer's page, session details, project sessions and Herdr workspaces show that same list instead of fetching their own, and a session's sub-agents are read once for its card, its drawer row and its details.
- The code viewer colors a file's lines as they scroll into view and remembers them, so opening a long file or returning to it no longer colors every line again.
- The agent chat's header sits on a solid band of the chat background, and the conversation fades out just below it, so no cut-off line shows beside or above the title while you scroll. A long title keeps both its start and its end, and the project, model and branch each shorten on their own, so a long project name no longer pushes the branch off the line.
- A Claude chat's live line is Claude's own spinner line, "✻ Whirlpooling… (34s · ↓ 3.1k tokens · thinking)", with a small stop ring at its end that stops the turn like the composer's stop. The finished line says Claude's word in the past tense ("Brewed for 18m 18s") in dim italic. Codex and other agents keep today's line.
- Claude's narration between tool calls reads as a dim italic "Thinking:" line, folded to one line until you tap it; the reply itself stays ordinary text.
- Tool calls are quiet one-line pills that open in place and close again: other MCP servers' calls too, and a phren card folds to the same height. Two or more calls of the same tool in a row fold into one pill ("Shell ×2") that opens to each call, and a failed call shows a red mark at the end of its pill instead of the check.
- Colors in the chat carry meaning: file paths and links in one color, the git branch in another, running and finished calls in their own, with phren purple kept for buttons and phren cards.
- A chat opened at launch (from Siri, Spotlight or a restored screen) no longer shows the system bar's back button above its own header while it loads; a chat rebuilt for another session keeps the bar hidden too.
- Opening the keyboard moves the conversation up with the message box, so the latest messages stay visible above it, and closing it (or dragging it down) moves the conversation back; reading earlier history keeps the same message in place.
- GitHub Copilot chats end their turns again with Copilot 1.0.87, which no longer writes an idle event: a turn starts with your prompt and finishes at Copilot's final answer, so the chat stops showing the agent as working forever. A failed Copilot tool run is marked as failed.
- Settings → Notifications says "Instant approval alerts need an APNs key on the computer" and names each connected computer whose Hook reports push as not configured, instead of implying that registering this phone was enough.
- Changes has a Workers section: the repository's other worktrees, where sub-agents and fan-out workers keep their edits, each named by the worker's task (or its branch) with uncommitted files and commits ahead. A row opens the same list, diff, history and working tree bound to that worker's checkout. In the agent tree, a worker with its own worktree has a Changes button that opens it directly.
- The working tree has a Show ignored switch, off by default and remembered, that lists git-ignored folders and files dimmed, so a build or media folder can be found and its files opened.
- The chat's model picker also sets effort. Choosing a model opens its effort levels under it (the computer's own levels for that model, Low, Medium and High when the harness lists none, the catalogue's default marked), with the current effort checked when this phone set it. Choosing a level switches the model with that effort, including a switch held until the turn ends. A typed model id still switches without one.
- Development: an unchanged build no longer runs the graph bundler. Its build phase runs only when a source the bundle reads, the bundler or the lockfile changed (the list lives in `scripts/graph-inputs.xcfilelist` and a test fails when it drifts). `scripts/release.py` runs `xcodegen generate` once instead of twice when it releases from the main checkout. Several UI tests share a launch instead of relaunching, wait for elements instead of sleeping, and the stale-status test uses a 30 second live window instead of waiting out 90 seconds.
- Claude chats suggest `/btw` for a quick side question. It sends even while Claude is working, and the answer shows on a card above the message box, marked as not part of the conversation, with Copy and Dismiss. Dismissing a question that is still being answered cancels it on the computer.
- The live reply preview renders its Markdown as the finished message does, in the same font, color and spacing: bold, lists, headings, code and tables show while the reply streams, and when the finished message replaces it only the caret goes away. Claude's preview comes from its terminal, which carries no bold, so its bold appears when the message lands.
- Opening a chat you opened recently shows its conversation at once and catches up from where it left off, and Agents (and a chat's drawer) loads the first few sessions' recent messages ahead, so opening one of them shows its messages in about half a second instead of a second and a half on a typical connection.
- A project's files have one home: the project's Code page. It starts on a computer that keeps the code index, and a line under the title picks any computer's checkout of the project. A computer's Files page keeps its uploads and Memory's Files keeps the store's files; neither lists projects any more.
- The chat's live line ("✻ Swooping… (39s · ↓ 2.9k tokens)") is a size larger, the size of a tool pill's text, and sits close to the rows around it: the stop ring keeps its full touch target over the gaps instead of padding the line out.
- A message you send shows in the conversation at once, as a dimmed bubble above the live line, and your text leaves the message box at the same moment. The computer's own copy replaces it when it arrives; a message that could not be sent goes back to the message box.
- The message box grows with every line up to four, including a paste, dictation and deleting back down, then scrolls whole lines inside its padding, so a long draft no longer shows a cut-off line pressed against the top of the box.
- A long draft in the agent chat's message box stays where you scrolled it; any update to the chat had jumped it back to the cursor.
- Holding a selection handle or the cursor at the top or bottom edge of the message box scrolls a long draft, so a selection can reach lines beyond the four on screen.
- Double tapping the terminal pastes when the second tap arrives at the instant the first one lifts, as synthesized taps do; the second tap had been dropped.
- Tapping a file in a computer's Files list opens it in the file viewer again; the tap had done nothing.
- The file viewer's PDF page buttons, media transport and text page buttons keep their own names for VoiceOver instead of all reading as the viewer.
- File paths in a chat reply become tappable once the computer confirms them, also when the path is written as code. The first, unlinked rendering of the paragraph had been reused.
- A website link in a chat reply asks "Open website?" again before leaving the app, and a link with another scheme (such as `shortcuts://`) does nothing. Replies that could hold file links had been opening every link directly.
- Schedule history shows a run that finished by asking you something as "needs you" with the question, in the waiting color, instead of as a failure.
- The agent tree folds finished workers into one "N finished" row you can open, and Clear finished archives that chat's finished workers on the computer right away instead of after a day.
- Failures that used to pass silently now say why. An agent chat shows why approvals and status went quiet while it reconnects, why the sub-agent list could not refresh, and when sub-agents on other computers are missing because the computer's `hooks.yaml` is broken. A Memory search that fails shows its reason. Signing out or removing a store says when the copy on this phone could not be deleted, and local cache writes that fail during sync join the storage notice instead of vanishing.
- Chat question cards list each question as one "Header: question" line followed by compact bordered options, the description in the secondary text color below the title. An option's background now always holds its radio, title and full description, so rows no longer overlap. A wide option preview scrolls sideways in its own box without widening the card, and Show all is its own row below the cut instead of floating over an option.
- Pasting an image into the agent chat's message box (the edit menu's Paste or the keyboard's screenshot suggestion) adds it as an attachment, the same as the + picker, within the same attachment limit.
- Settings → Health (and Health on a computer's page in Agents) shows each computer's tool versions, store sync with its last error, the last scheduled run, peers with a warning when a link is one-way, approval push and the last canary, which you can run again from there.
- A Claude chat's live line uses Claude's own spinner word ("Pondering 16s") for the whole turn instead of switching words on every tool call, and Claude's tool-call lines no longer flash in the live reply preview.
- A launch the computer refuses shows the computer's own reason; only a refusal that names a running conductor is reported as one.
- Launching an agent or the conductor goes computer, harness, model, effort. The models are the chosen computer's own list for that harness (phren's defaults only when it can't be asked), with no free-text field. Effort lists that model's own levels (Claude up to Max, Codex from its catalogue), starts on Medium and is remembered per harness.
- A failed phren call shows its reason and one line per problem instead of the raw JSON with the parameter list; a successful call shows phren's message without repeating it as JSON.
- The agent chat's message box takes focus and raises the keyboard again; its focus flag had stayed a SwiftUI focus state that no field was bound to, so every tap was undone.
- The conductor starts without a project: it opens in the chosen computer's phren store and works across every project from there. The launch sheet no longer asks for a project or folder.
- Sessions and a computer's page have no search bar.
- The last system controls on Agents are phren's own: holding a session opens phren's action sheet (link or change project, rename the workspace, close the tab or workspace), closing asks in a phren dialog with an explicit Keep, renaming a workspace is a small editor instead of an alert, and a computer's Workspaces and Activity switch is a phren segment. Terminal font size uses phren's stepper, the Graph search is phren's search field, and passwords, tokens and every other text field use phren's field shape and colors.
- Saved computers, links and pins are read once per change instead of on every redraw of Agents, a computer's page, session details, project sessions, the launch sheet and the chat's agent switcher. Dates are formatted by shared formatters built once, including a file's modified date, which used to build a new formatter on every read.
- Choosers such as Code's Symbol kind size to their rows instead of trailing empty space.
- Expanding a phren card shows its full text in place (every field, result and title) instead of raw input and JSON output; raw output appears only when the card has nothing readable, and a failure still shows its raw error.
- Agents keeps Start a conductor at the top, replaced in place by the running conductor's card. Launch restores its harness, model, effort and last computer, with a store choice when several stores are connected. Conductor chats have a Grants control in their header.
- Child conversations explain where messages go: pane agents open their full chat, fan-out workers continue their own sessions or queue another round, and in-process sub-agents send a message to their parent prefixed with the sub-agent's name. Finished resumable workers remain available in the tree.
- Phren chat cards expand and fold in place with selectable full input and output. Separate chevrons open synced tasks, finding dossiers and captured search results. Failed calls show their reason and keep raw errors in expanded details.

- Workspace order, chat session destinations, website confirmations, attachment paste, and custom theme, computer and project colors use phren controls. Color edits keep live previews, exact hex values and saved preferences.
- Selecting a graph node centers it in the open space above its details card, with room to breathe. The camera follows changes in card height, respects Reduce Motion, yields to dragging, and returns to the previous view when the card closes.
- Multi-select filters fit their content, with dense checked rows, pinned removable chips, search for longer lists, inline All and None, and a selected count on Done.
- Hold a project to choose a computer by name, state and project session count. Reachable and recently used computers come first, with a last-used shortcut, search for longer lists, and disabled offline computers that explain why they cannot open.
- Code opens on the indexed codebase, with file symbol counts, languages, index time and Reindex. Search supports kind and directory filters. Usage shows the full paged ranking with bars, kind and file filters, and Hot/Cold jumps within the same list. Recent shows symbols the index last saw change. Code entries share the curly braces icon.
- Chat sends steering messages straight to working harnesses and reads queued state from their transcripts. Local pending messages name the connection, startup or prompt that prevents delivery.

- Tasks: Start opens the agent launch sheet with the task and its project. Backlog work moves to Active after the agent receives the task; cancel leaves it in place. Move to Active is a separate action, and moves out of the current filter show their destination with a View action. Selecting several tasks offers moves only.
- Projects uses the same inline header as Agents, Tasks and Memory, with add, search and voice capture beside the title. Its More menu is removed. Memory owns the graph, Files and Memory maintenance; Agents owns Live sessions, Skills and Agent instructions.

- Agent work puts running jobs first, shows failures for one hour with their age, and remembers dismissed failures. Header counts match the visible rows.

- The working tree keeps expanded folders and loaded children during refreshes and tab switches. Directory rows show file totals; indexed projects also show symbol totals and kinds, with file symbol chips opening the dossier.
- A finished agent turn that changed files ends with one quiet row, "3 files changed +6 −3". Tapping it opens everything that turn changed, file by file, and each file opens its own full diff. The list comes from the conversation itself (the edits the agent made and the changes Phren Hook measured under its commands), so another agent working in the same folder never shows up in it. Works for Claude and Codex.

- Internal: the largest chat, sessions and tasks source files are split along their seams (composer, options, dictation, scroll follow, pending queue; one file per sessions type; the task sheets), and the chat model keeps its connection and outgoing queue in their own objects. The chat UI tests are split by feature. Nothing looks or behaves differently.

### Added

- Opening a project on a computer can start the agent in a new worktree. Turn on Work in a new worktree below Effort and edit the branch, suggested from the task's first line or `phren/` and a short id. The computer adds the worktree under `.claude/worktrees` from the project's current HEAD and starts the agent there; it says so when the folder is not a Git repository or the branch already exists. The worktree then shows in Changes > Workers, named for the agent working in it.
- One file viewer opens computer files, working-tree contents and verified paths in chat. Downloads show progress and resume from the cache after cancellation or backgrounding. Video and audio use phren playback controls; PDFs have page controls, JSON folds, CSV scrolls as a table, Markdown renders, code highlights and images zoom. Save to Files and Share work for every downloaded type.

- Replies appear as they are written below the activity row. Live previews become the finished reply without duplicate text or restarting the reveal animation.
- Image previews support pinch zoom, double tap for actual size, and bounded panning. Chat and file previews retain full image detail, with a phren close control and a downward swipe to dismiss at fit.
- Local notifications for the next scheduled prompt and pending approvals, with separate switches in Settings. The phone checks approvals during its brief background window and on optional iOS background refreshes; no APNs key or relay is needed.

- Chat shows live thinking and tool activity with elapsed time, then keeps a quiet duration above the reply, including stopped turns.

- Open the session project's Code index from Changes or the chat header actions. Notes from these dossiers return to the originating session without another recipient prompt.
- Hold a project or computer for 0.4 seconds to choose where to open an agent. The chooser shows computer colors and keeps the existing harness and model launch flow, with an Open agent accessibility action.

- Select a symbol line, write a note and send it to a project session or a new worker. Code rows show usage bars, and the dossier lists cited findings.

### Fixed

- A chat attachment that reached the computer reports success. When another request on the same SSH connection failed (a stream that ended, a poll that timed out), the phone closed the connection under the upload, which then said "Attachment upload didn't finish" (tcpShutdown) although the file was already stored. A failed request now only takes its connection out of use: requests already running on it finish first, and new requests open a fresh connection.
- Focus in the Memory map lands on the focused node. Focus shows the node's neighbourhood, which lays the map out again, and the camera stayed where the node used to be, often leaving it off screen. A tap on the map also selects the node under your finger; it had selected the node under the previous tap, or nothing.
- Project numbers tell the truth. The number beside a project in the Memory
  graph counted only the recent findings the graph drew (the CLI keeps 20 live
  and archives the rest, so many projects read exactly 20) and ignored the
  filter. It now counts what the filter shows, all of it: every finding
  including the archive (read from the project's summary.md, so nothing extra
  is downloaded), or open tasks under Tasks. Project cards and the widget use
  the same total.
- A computer phren cannot reach still opens its terminal. The Connections
  row and the computer's page offer a terminal that attaches Herdr straight
  over SSH, which needs neither the Hook nor its status, so a stuck or
  overloaded Hook no longer sends you to another app to see the machine.
- The model picker switches through the Hook without sending chat messages. Working agents offer Switch after this turn with cancellation; verified switches appear as a small system row.
- Extending a chat text selection keeps the keyboard and conversation still. Long drafts grow to four lines, then scroll inside the composer as selection handles move; ordinary conversation drags still dismiss the keyboard.

- Long-press message actions lift the message above a dimmed screen, cover the composer, and fit above or below the message without overlapping it. Dismissal restores the conversation in one animation.

- Codex prompt options show their labels and wrapping descriptions separately. Long question text expands without fading or covering the options.
- MCP approvals ask the tool's sentence, keep arguments in folded details, and use the terminal's actual choices and keys. Unresolved requests offer Open terminal.
- Terminal paste uploads clipboard images and inserts their paths at the cursor. Double tap also pastes text or images. Chat keeps system image paste and removes the extra clipboard button.

- A horizontal session swipe cancels the card tap instead of opening chat; vertical scrolling stays available.
- Task fold controls retain their button trait alongside the section heading trait.
- Terminal shortcut settings has a stable accessibility identifier.

- Task section headers keep their fold button and count marker as separate accessibility elements.
- Swiping a session reveals or hides Close as soon as the horizontal gesture is recognized.
- Sessions keeps Refresh all sessions and Schedules reachable in More when the navigation bar is full.
- Terminal shortcut commands and their actions have separate tap targets, so tapping a command sends it and honors the close-after-shortcut setting.
- Uneven chats lay out their real end on open and retain measured heights when distant rows fold into placeholders.
- Working tree rows return to the compact 32-point density while keeping folder counts and symbol chips.

- All four project controls use equal columns, an icon above a single-line title, and a 52-point band with space below the inline navigation title.
- Chat permissions use the provider question header and ordered radio options, including conductor grants. Terminal access stays in the header, and action details use Phren's disclosure.
- SSH upload errors show a readable explanation and the SSH error type. Attachment requests flush bounded chunks, and a complete response remains successful if the channel reports a later failure.

- A Codex prompt drawn in its pane, like "Would you like to run the following
  command?", draws as a choice card again, so the key strip no longer covers it.
  With nothing parsed, the row under "Waiting for your answer" is now Open
  terminal plus a Keys chip that reveals the strip, and the password action
  appears only when the terminal is really reading a password ("The terminal is
  asking for a password" with Enter password). An answered card and strip clear
  until the next prompt arrives.
- A fan-out worker the computer refused a permission for reads as failed, never
  completed: its row and its chat header say "Permission refused" with the
  refused type and pattern and a FAILED badge in the warning tint.
- A computer under heavy load shows "Slow to answer" on its row and keeps its last snapshot, distinct from unreachable, using the Hook's reported load and gateway cost.

- Claude Code's AskUserQuestion that falls back to the terminal is asked with the
  same question card a held one uses, marked "answered in the terminal"; the
  answer sends each question's option digit through the keys route. Its
  transcript tool row no longer repeats the JSON beside the card.
- OpenCode calls use phren memory, todo, patch and subagent cards, with captured tool arguments preserved.

The Tasks tab filters open from done, and the Memory list shows its projects
and scrolls again.

### New

- Siri and the Action button drive the conductor: "Tell my conductor …" sends
  a line to the running conductor, "Ask my conductor …" speaks its next reply,
  and "What is Phren doing" reports the working, waiting and idle counts plus
  the conductor's current step. Settings gains a "Siri and the Action button"
  row that lists the phrases and opens the Shortcuts app.
- Tasks: the filter line leads with an Open versus Done status drop-down:
  Open (Active plus Queue, the default), Active, Backlog, Done and All,
  remembered across launches. Project count chips and section order follow
  the choice, both Select all and the bulk moves work on the filtered rows,
  and done rows draw muted with a checkmark and their done date.

### Changed

- Sessions leads with running sessions and keeps Computers below them. Skills
  and Agent instructions move into More, which also offers Add computer. The
  repeated Agent setup group and Tailscale footer are removed.

- The Agents and Projects lists derive their rows and counts once per input
  change rather than on every draw, the graph prepares its payload off the
  main actor and keeps one web view while the selection changes, and image
  previews decode once into a shared cache.
- Projects leads with the project grid and keeps its Phren store filter.

- Chat, tool cards and Changes are denser: the floating header sits 4 points
  under the safe area, the composer 4 above the home indicator, transcript
  rows 6 apart, and expanded tool cards use 8-point padding with 4 between
  rows. Changes list rows are 44 points, Working tree rows 32 with a 12-point
  indent per level, and the section band is 40 with 32-point icon tabs.
- A heavy transcript stays quick to swipe: rows more than two screens from the
  viewport keep only their identifier and label at their measured height
  instead of laying out their rich content, a folded tool card's body is never
  built, and folded read runs and large patch checks are computed once in
  preparation rather than while drawing.
- A project's name color comes from the same eight-color palette a computer
  gets, plus the custom color wheel and a hex field; the row previews the name.
- Knobs are sliders: every stop is visible under its own dot, the current value
  sits beside the title, a tap or a press-and-drag sets it, and a knob that
  overrides the global value shows a reset glyph. The whole screen fits at once.
- The remaining native controls are replaced by the Phren control kit: Toggle
  25 to 0, alert 17 to 4, confirmationDialog 13 to 2, Menu 15 to 2, contextMenu
  12 to 6, Picker 27 to 4, and searchable 6 to 3. ReviewView's list now scrolls
  as cards. The leftover counts live in the Chat, live-session and project
  screens another pass owns; PhrenList and PhrenForm stay until each screen
  migrates with its own list behaviour.

### Fixed

- A Codex subagent card stops saying "Working in the background" once the computer
  has seen that child finish, even before the spawn call's own result arrives.
- Task rows, project groups and counts refresh only when their inputs change;
  unchanged rows do not redraw on unrelated updates.
- Code searches ignore late results from superseded queries. Failed grant
  saves keep the editor open, and revoking a stale row cannot remove another grant.
- Chat progress and pending questions follow explicit conversation resets,
  preserving current state across older reconnect pages and missing-file placeholders.
- Memory list rows: the project chip is back whenever the filter is not a single
  project, tasks keep their Active/Backlog/Done chip and date, and a row with
  nothing for the meta line no longer leaves a blank band under its text.
- The Memory list with a few hundred rows scrolls again: filtering, grouping
  and counts are computed only when the rows or filters change, each row
  redraws only when its own content changes, the highlight is drawn on the
  highlighted row alone, and scrolling to a row runs only when a new target
  arrives.

## 1.0.2

A patch with the conductor's grants, the Code screen, grouped tasks, and a
run of chat fixes: replies unfold in place, queued Codex questions become
cards, idle reconnects keep the transcript, and the chat header stays alone.

### New

- Grants: a conductor's standing dispatch and hand-off authorizations open
  from the chat options as a list of scope, action and computer rows, with
  add and revoke. A conductor permission card also offers "Allow for this
  project" and "Allow everywhere", which approve the call and write the
  matching grant on the computer.
- Code: the project page's Code cell opens a symbol search over the computer's
  code index, with the hottest and coldest symbols when no query is typed. Tap a
  symbol for its dossier: the definition, the last change, its references by
  file and a Findings section reserved for later.
- Tasks: the backlog groups into one collapsible section per project, busiest
  open work first. Headers show the project's color with Active and Queue
  counts as chips, tapping a header folds that section, and All folds or
  unfolds every section. Folds are remembered.

### Changed

- The Knobs screen is a plain list like the others: category headers over
  session cards, each knob one row with a caption and a phren drop-down for
  its value, and a Reset row at the bottom that clears every override after
  a confirmation.
- The Projects tab's Explore list no longer shows Memory graph; the Memory
  tab is the graph now, and a session's or chat's Explore graph still opens
  that project's graph. The More menu keeps its Memory graph item.

### Fixed

- A long reply unfolds in place with Show more, rendered like the rest of the bubble,
  instead of opening the monospace pager meant for tool output.
- A Codex queued follow-up question waiting in the terminal now opens as the
  chat's question card: the Hook reads its text and options from the thread
  store, the card lists them, and Send presses alt+up (Codex's queue binding)
  followed by the chosen option's key. Without readable text the plain answer
  keys stay as the fallback.
- Choosing Full Access under /permissions no longer leaves Codex's terminal on
  "Enable full access?". The Hook walks that second confirmation itself from
  the pane's lines; if it never appears the phone gets the visible prompt as a
  question card instead of a blind Enter that landed too early.
- Claude's usage numbers add up. The Fable weekly window is labelled
  "7-day, Fable only" with its own reset time and its own "updated" age beside
  it, never drawn as part of the all-models window it can exceed; the Claude
  card says where the numbers came from ("from Claude Code status line,
  updated 6 s ago"); and the Live sessions header ring is bound to the same
  5-hour window the Account usage page shows first, instead of whichever
  window happens to be highest.
- After the app sits idle, the chat no longer resets to an earlier point until
  it catches up: a reconnect merges the resumed stream by line and keeps every
  row the phone already showed, an empty placeholder while the transcript file
  is missing cannot claim the beginning is loaded, and only the Hook's explicit
  conversation-replacement snapshot clears the conversation.
- The floating chat header is the only bar: the system navigation bar no
  longer returns above it when the app comes back from another app or a chat
  sheet is dismissed, and the bar is never titled "Agent chat".
- Sending while dictating delivers new words again: the send ends the current
  recognition task, starts a fresh request and tap on the same audio engine
  with the audio session reasserted, and the composer shows the next segment's
  text instead of a live mic over a silent recogniser.

## 1.0.1

A patch on the day-one build: faster sends, a chat that stays put, and the
lock screen and Changes screen done properly.

### New

- Conductor is a launch role with its own provider, model and effort choice,
  a pinned dispatch-marked session card, and matching chat and Lock Screen identity.

- Memory is map or list: the full graph with its node dossier, or the same findings,
  notes, tasks and topics as a filterable list. A search icon and two drop-down
  filters for kinds and projects sit above both; mode and filters are remembered.
  Tasks keep their tab.
- Approval results show as phren's own notice instead of a system alert.
- A shared control kit (search fields, single-select chips, switches, option
  rows and groups, text segments, icon
  buttons, action sheets, dialogs, steppers, screens, groups and rows) drawn
  by Phren instead of the system controls. The chat question card, Project
  Knobs and the schedule editor use it; `design/controls.md` is the contract.
- Schedules: a Notify group in the editor chooses which runs reach the phone
  as notifications (Start, Finish, Failure; Finish and Failure by default).
  Tapping one opens the run's session, or the schedule's history.
- Agent work follows a conductor's remote leads and their nested workers
  through the computer that owns them: computer chips, remote questions and
  changes, and clear offline or enrollment states.
- Usage shows OpenCode Go spend per model over 5 hours, 7 days and 30 days,
  with limits when the plan reports them.
- Memory graph: Edit and Delete are icons in the node panel, and Previous and
  Next step through a project's tasks or a topic's findings.
- The phone hides Schedules and Conductor on a computer whose Hook does not
  run those modules.
- Schedules: scheduled prompts per project and computer with a chosen harness
  and model, maintained from the phone.
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

- The node dossier's Previous and Next moved into the header beside Edit,
  Delete and Close as `Previous node` / `Next node` arrows (44pt targets), and
  they step through the ranked list the Memory list shows for the project
  (findings newest date first, then tasks), wrapping at both ends. The
  keyboard arrows walk the same list.
- The schedule editor, the chat /model picker and the launch computer chooser pick
  from phren's own drop-down rows instead of long option lists.
- Account usage is rebuilt around what each source means: one updated line with the
  reporting computers, Claude and Codex limits with phren's own bars and reset captions,
  OpenCode Go per model with a billed chip, OpenCode marked as an estimate, and
  OpenRouter folded to one row when the week's charge is zero.
- The project page keeps only memory: the session actions and project graph link leave
  its top bar for Agents and Memory. The Skills, Knobs and Schedules band stays.
- The UI test suite runs its classes on two simulator clones, skips screenshots
  unless asked, and launches with animations off, about 2.5 times faster.
- Denser chat and Changes screens: the header sits under the status bar, the
  composer sits on the home indicator, tool cards are 44pt, and the Changes
  tabs, rows and tree are slimmer.
- OpenCode conversations draw the same rows as Claude's: a read folds into the
  same run, an edit or write shows its path and patch card, a task or todo its
  card, and a phren tool its phren card, instead of a raw-JSON pill.
- Knobs are chosen with phren's own option rows instead of system pickers.
- A Codex thread that stopped recording says so in the chat instead of going
  stale.
- Returning to agent chat after the app has been idle keeps the newest local
  messages visible while the transcript resumes from the computer.
- Claude usage labels the all-models and model-specific seven-day allowances
  separately. The Live sessions ring now uses the primary window from the
  newest computer report, matching the Account usage screen.
- A prompt from the agent's terminal is asked as a card with Yes and No rows;
  the raw keys sit in a quiet strip beneath, and the orange waiting sentence
  is gone.
- Tasks: across projects the backlog is grouped by project, fullest first,
  with a count on each section; tap a project name to fold it.
- Projects: project names take the theme's project color, as on the Agents
  list.
- The Projects tab's dictate button is gone; Siri and the capture shortcut
  are the way to speak a note or task.
- The /model picker shows "Loading models from <computer>" until the computer's
  catalogue arrives, then the recently used models for that harness first with
  the default marked; the built-in names appear only when the route fails, each
  marked "built-in" and keeping its default chip, and never another harness's
  list. Claude's rows are Claude Code's own menu entries (Fable 5.1, Opus 5,
  Sonnet 5, Haiku 4.5, Fable 5.1 (1M context)), a typed id joins the recents
  like a tapped one, and the row checked is the session's exact model id.
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
- Background workers launched through the fanout skill (Codex or OpenCode,
  by provider) are named and grouped like the old per-provider launchers.
- Projects: a Knobs screen sets finding sensitivity, proactivity and task
  mode per project, written to phren.project.yaml; empty means the global
  setting.
- A tool's output screen no longer shows a Done button beside the back
  chevron; back is the way out.
- What's new appears once after every update again; it used to count the
  marketing version alone, which every TestFlight build shares.
- Session details: Chat and Terminal sit side by side, each half the width and
  44 points tall, instead of two stacked full-width buttons.
- Project names take a per-project color chosen in the project's Knobs screen
  (a row of color dots, phone-local); the Agents list, Memory, chat header and
  lock screen follow it.
- The lock screen line shows each agent's branch, or the worktree folder when
  it is off the main checkout, instead of the current step; running fan-out
  workers read as "N workers" with their provider glyphs.

### Fixed

- A Codex approval in the terminal shows its actual question and options as the
  question card, answered by their own keys (`y`, `p`, `Esc`), instead of a bare
  "Waiting for your answer" line and a key strip; the terminal stays in the
  card's header. Codex's Wait Agent, List Agents and Send Message calls fold into
  one row with a plain-language preview rather than a raw id or timeout.
- Opening the app no longer shows a computer as disconnected or its sessions
  as Stale while the first SSH connection is still being made: cached sessions
  keep their live groups and read as refreshing until the computer answers,
  and Stale now means a computer that answered and then went quiet.
- The Memory list scrolls again: a vertical drag on a row moves the list, and the row
  actions stay on the ellipsis glyph.
- Sending no longer throws the transcript past its end: the scroll waits for the new
  row and the keyboard, and holds its target to the content end.
- The project dossier in the memory graph is a dialog again for assistive tech.
- Project cards keep their compact two-line height with the themed project color.
- Task details keep the agent action visible above long plans.
- Selecting a project from graph search opens its dossier again.
- Schedule history opens older run records that have no notification result.
- Long rich transcripts keep one accessibility element per dense reply or large
  folded patch card, and hidden patch details are prepared only after opening.
- Schedules: Run now takes its own tap beside the chips, the swipe actions no
  longer peek through the card's corners, and the all-projects list resolves
  the computer and next run like the per-project list.
- The schedule editor puts the keyboard away as soon as you scroll.
- A schedule's next-run on the list follows an edit at once: the card recomputes
  on the phone until the owning computer's Hook reports the new revision, instead
  of showing the pre-edit time from the computer's older copy of the store.
- Chat options lists the conversation's token usage above the project rows, and
  the token sheet starts at the top instead of floating mid-sheet.
- Account usage: each provider's windows keep their own accessibility ids.
- Working tree folders open on the first tap again.
- Dictation keeps what you said across pauses and keeps listening after a send.
- The lock screen counts a session as running while its fan-out workers run,
  and says how many.
- The Add computer button on an unknown remote agent's page is a full
  44-point target again.

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
  identifiers — is colored like links, with its own theme slot.
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
  project chips, search results, and customisable colors.
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
  it), keep the computer name, and color the project name.
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
  its branch, then the conversation title and a colored state line.
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
  characters, next/previous change, inline or side by side, syntax colored.
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
