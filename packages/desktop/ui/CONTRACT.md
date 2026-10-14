# UI contract

Read "Shell" first: it is how every new screen plugs in.

# Shell (phase 1)

`index.html` holds only the titlebar (`#section-pills`, `#needs-pill`,
`#conn-count`) and `#sections`. `app.js` registers sections and wires keys,
badge and notifications; nothing else lives there.

## Store (`shell/store.js`)

One `/api/overview` WebSocket for the whole app. Never open your own.

```js
import { store, connectStore, needsYou, sessions, projectOf } from "./shell/store.js";
store.merged                 // MergedOverview (src/contract.ts) or null
store.subscribe(fn)          // fn(merged) now and on every change; returns unsubscribe
store.needsYou()             // [{ key, computer, group, child }] blocked, waiting or approval pending
store.sessions()             // every agent row across computers, same shape
store.find(computer, childId)
await store.capabilities(computer) // the Hook's `capabilities`: seeded from each overview frame's `phren` block, else `/v1/health` (one read in flight per computer), cached 5 min
store.can(computer, "fileWrite")   // sync: true | false | undefined (not fetched yet)
store.version(computer)            // Hook version string when known
```

Gate every control on a capability the Hook declares, never on a 404: an
unsupported feature shows a disabled control with a reason ("Needs a newer
Phren on Devbox").

## Sections (`shell/sections.js`)

Titlebar pills, in `order`. A section mounts once, on first show, and stays
mounted while hidden. The URL hash is `#/<id>`.

```js
registerSection(id, { label, order, badge?: true, mount(el, ctx) -> { show?(), hide?(), focus?(), ... } })
showSection(id)            // returns the section's handle
sectionHandle(id)          // the handle, mounting the section hidden if needed
showPillAt(index)          // open the titlebar pill at index (0-based) as a click would; false past the last. app.js binds ⌘1–⌘9 / Ctrl+1–9 to it
pillShortcut(index)        // "⌘3" / "Ctrl+3", shown in each pill's tooltip and aria-keyshortcuts; "" past nine
prefetchSection(id)        // read a section ahead (titlebar pill hover, 120 ms): only sections registered with readAhead: true are mounted hidden and their prefetch() called. shell/read-ahead.js readAhead(read) gives a section { prefetch(), show() } that skips the show() read when a read ahead for the same online computers is under 5 s old
setSectionBadge(id, count) // amber count on the pill; 0 hides it
onSectionChange(fn)
```

New sections go in `sections/<id>.js` exporting `mount<Id>(el, deps)` and are
registered in `app.js`. Today: `home` (sections/home.js) and `agents`
(sections/agents.js, the sidebar, centre tabs and right panel).

## Documents (`shell/tabs.js`)

Centre tabs inside a section (Agents uses them for chats; files, diffs, a
whole terminal server and settings pages come next).

```js
const tabs = createTabs(barEl, bodyEl, { onActivate(doc, handle), onEmpty(), onClose(doc) })
tabs.open(doc, { background? })  // doc: { id, kind, title, subtitle?, mount(el) -> handle, persist? }
tabs.activate(id); tabs.close(id?); tabs.step(±1); tabs.setTitle(id, title, subtitle)
tabs.active(); tabs.activeHandle(); tabs.list(); tabs.has(id); tabs.saved()
```

A handle may implement `close()`, `focus()`, `show()`, `hide()`. `persist` is a
small JSON value saved to localStorage so the tab reopens on relaunch.

Agents' handle (via `sectionHandle("agents")`): `openSession(computer, child)`,
`showPane(key)`, `closePanel()`, `closeTab()`, `nextTab()`, `previousTab()`,
`toggleZoom()`, `currentSession()`.

## Tiles (`shell/tiles.js`)

The Agents centre is a split tree like Herdr's panes: tiles side by side or
stacked, each with its own tabs (`shell/tabs.js`, which can `detach`/`adopt`
a mounted document, so moving never remounts a chat). Same API as tabs plus
`split(side)`, `focusDir(dir)`, `moveDir(dir)`, `swapDir(dir)`, `resize(dir)`,
`zoom()`, `moveDoc(id, tile, side?)`, `restore(layout, resolve)`, `saved()`.
Drag a tab onto a tile's edge to split there, onto its centre or tab bar to
move into it. Keys use Herdr's action names (focus_pane_*, split_vertical,
split_horizontal, resize_pane_*, zoom, close_pane) plus Phren's move_pane_*,
swap_pane_*, toggle_console; ⌘\ and ⌘⇧\ split. The layout is saved
(`phren.desktop.layout`) and rebuilt once its computers report in.

Document kinds: `chat` (a session: Chat or Console, the console being the
agent pane's own terminal over `/pty?pane=`), `file`, `diff`, `terminal`
(a whole Herdr/tmux server).

## Agents layout

`#sidebar` (left, collapses to 64 px below 1440 px wide, toggle in the doc bar)
· `#main` = `.doc-bar` (centre tabs) + `.doc-body` + the bottom terminal panel
(hidden by default, ⌘J / `showPane("terminal")`, follows the active tab's
session, height remembered) · `#side`, the right tool panel with exactly
Changes · Files · Search (360 px default, 300 px to 50 %, remembered; overlays
the centre below 1200 px). Extensions live in Settings.

## Other shell modules

- `shell/approvals.js`: `startApprovals()`, started once by `app.js`, follows the overview store and opens a `/v1/status` watcher for each session with a pending approval. Home and the tray share `approvals.approval(key)`, `approvals.answerKey(key, decision, scope?)` and `approvals.subscribe(fn)`; watchers and summaries are removed when the approval or session goes away. Away data and its overview/CI feeders already live independently in `shell/away.js`. Home mounts without starting reads or keys; `show()` starts receipt/schedule polling, follows CI checks and attaches its keydown listener, and `hide()` stops them. The handler also ignores keys while hidden.

- `shell/theme.js`: `initTheme()`, `applyTheme(id)`, `currentTheme()`, `themes()`; the phone's five token sets in `tokens.json`. Extension themes colour the editor and terminal only.
- `shell/palette.js`: `openPalette()`, `registerCommand({ id, title, keys?, run, meta?, when? })` (`when()` hides a command while false; `meta` may be a function), `fuzzyScore(query, text)`. ⌘K. A query starting with `>` lists commands only; one starting with `?` asks the active session's project memory (`GET /v1/projects/:project/memory/search`, debounced, 20 results) and Enter opens the Memory section through its handle's `open({ computer, project, segment, search })`. It also lists the open pull requests the CI watch last saw (`lastChecks()` from `shell/ci-watch.js`, read without following it, so no extra polling), failing first, and Enter opens that session on Changes › PRs. Projects come from the Projects section's handle (`projects()`, loaded once by `load()` when the palette first opens, then the list redraws); Enter calls its `open({ computer, name })`. Under `?` results, `askItem` adds "Ask in a quick chat: <question>", which opens the launch sheet in quick-chat mode on that project with the question as its first prompt (`launch.js` is imported when used: it registers its commands here at load). `paletteMode`, `memoryItems`, `pullItems`, `projectItems` and `askItem` are exported for `src/ui-palette.test.ts`.
- Check states are worded by `checksWord(checks, what)` in `git-review.js` everywhere (Home's Checks strip, ⌘K, the project page, Changes › PRs): "Checks failing / running / passing", with the host's word ("Pipeline") where it differs; transitions read "checks failed / passed", and a failed one is red.
- `shell/ci-watch.js`: `startCiWatch({ notify, enabled })`, started by `app.js`: every two minutes one `/v1/git/pulls` per computer and project with a working or recently active session (at most six), and a notification when that branch's open request's checks turn failing or passing. It polls only while notifications are on or a view follows it: `followChecks(fn)` hands Home's Checks strip each look (the open requests, ordered by `checksStrip`, failing first) and makes the watch look early when the watched sessions change. Home's chips open the session with Changes on PRs (`agents.openPulls`, `changes.showView`). `watchedSessions`, `ciTransitions` and `checksStrip` are exported for `src/ui-ci-watch.test.ts`.
- `shell/merge-when-green.js`: `startMergeWhenGreen({ notify })`, started by `app.js`. Changes › PRs arms the branch's open request with "Merge when checks pass" (`armMerge`, kept in memory only); while anything is armed, one `/v1/git/pulls` per armed request every minute, and `/v1/git/pr/merge` with the armed method and `expectedHeadSha` once `mergeDecision` says its checks pass and the host does not block it. New commits, a failing check, conflicts or a closed request disarm it; each outcome is a notification. `mergeDecision` is exported for `src/ui-merge-when-green.test.ts`.
- `shell/summon.js`: `startSummon(window.phrenDesktop)`, started by `app.js`. The Electron shell registers a system-wide accelerator (`globalShortcut`, IPC `phren:summon-key`) that shows and focuses the window and sends `phren:summon`, which opens ⌘K. The key is kept in localStorage (`phren.desktop.summon`, default `CommandOrControl+Shift+Space`, `""` is off) and set from Settings › Keys, which records it from a keydown (`acceleratorFromEvent`, ⌘/Ctrl or ⌥/Alt required) and reports a key the system refused. Absent in a browser. `acceleratorFromEvent` and `formatAccelerator` are exported for `src/ui-summon.test.ts`.
- `shell/tray.js`: `startTray(window.phrenDesktop)`, started by `app.js`. Sends the shell `trayState(store.needsYou(), trayEnabled())` over IPC `phren:tray` whenever it changes: up to twelve rows `{ key, title, sub }` and a `more` count, or `{ enabled: false }`. The shell draws a menu bar / system tray icon (`electron/tray/`, a template image on macOS) with the count beside it on a Mac and the rows in its menu; its New agent… item sends `phren:new-agent`, which opens the launch sheet; choosing a row sends `phren:open-session` with the row key, which `shell/needs-notify.js` opens. While the icon is on, closing the window on a Mac hides it and the Dock or the icon brings it back. Settings › Notifications turns it off (localStorage `phren.desktop.tray`). Absent in a browser. A row with a known pending approval (`shell/approvals.js`) carries its summary, and the shell gives it a submenu with that summary, Allow, Deny and Open; Allow / Deny come back as `phren:tray-answer` and `approvals.answerKey(key, decision)` answers through `/v1/approvals/answer`. The tray never mounts Home. `trayState` is exported for `src/ui-tray.test.ts`.
- `shell/needs-notify.js`: `startNeedsNotify(window.phrenDesktop, { enabled, openSession })`, started by `app.js`: a native notification for each row that newly needs you (`needsNotice`), carrying its key. Clicking one opens that session (`phren:open-session`, shared with the tray). On macOS a plain wait (`agentStatus` `waiting`, no approval) takes a typed reply (`hasReply`), which comes back as `phren:reply` and `sendReply` posts as `/v1/prompt` to that target; a gone session or a refused prompt is its own notification. The body adds the row's `lastReply` (what the agent said last; overview rows from Hook 0.3.45 on) on a second line, Home shows it under Needs you and Since you left rows, and the Agents sidebar under a detailed row that needs you (not an approval). `needsNotice` and `sendReply` are exported for `src/ui-needs-notify.test.ts`.
- `shell/away.js`: `startAway()`, started by `app.js`, and the shared `away` tracker. Away begins when the window is hidden or loses focus; every overview is observed, and a session that was `working` and no longer is counts as a finished turn while away. The CI watch's settled checks (`onChecksSettled` in `shell/ci-watch.js`) are kept too while away (`noteChecks`, latest per request). Coming back after at least `MIN_AWAY_MS` (a minute) with finished turns or settled checks publishes `{ since, back, rows, checks }`, the checks listed first and opening the session's Changes › PRs; (newest first, at most 20) to Home's "Since you left" block, which shows each session as it is now and opens it; Dismiss (or the next time away) clears it. `createAway({ now })` and `endedTurns` are exported for `src/ui-away.test.ts`.
- `shell/warm.js`: `startWarm({ sections, mount, settleMs })`, started by `app.js`. After the first overview with an online computer and a 3 s settle, mounts Projects and Tasks hidden through `sectionHandle`, one per idle callback, so their first reads happen before the first visit. Tested in `src/ui-warm.test.ts`.
- `shell/skeleton.js`: `skeleton({ count, itemClass, widths, wrapClass, label })` → a `role=status` `aria-busy` wrapper of placeholder items reusing the section's own item class (`pj-card`, `tasks-project`, `mem-row`), one `.skel` bar per width (a list of lists varies them per item). Styles in `theme.css` (`.skel`, `.skel-wrap`), still under reduced motion.
- `shell/hook-drift.js`: `hookDrift(merged.computers)` → `{ newest, behind }` from each online computer's overview `phren.version` (no Hook calls), `compareVersions`, `hookVersion`, `updateCommand(version)` (`npx --yes @phren/cli@<v> bridge update`). Home's Computers rows show `Hook <version>`; one behind the newest gets an "update to <newest>" chip that copies the command, and Settings › Computers marks its version the same way. Exported for `src/ui-hook-drift.test.ts`.
- `shell/update-chip.js`: `startUpdateChip(window.phrenDesktop, beforeEl)`, started by `app.js`. The shell's updater (`electron/updates.js`) sends `phren:update` `{ version, current, notes, action }` when a newer release is available (`download`, a build that cannot update itself) or downloaded (`restart`); `notes` are the release body's lines (`noteLines`), which the release workflow takes from `packages/desktop/CHANGELOG.md`. The chip opens What's new; its button sends `phren:update-action`, and Later hides that version (localStorage `phren.desktop.update-skipped`). With no window the shell falls back to a dialog. `updateView` and `noteLines` are exported for `src/ui-update-chip.test.ts`.
- `shell/stalls.js`: `stalledMinutes(child)` (the Hook's `stalled` / `stalledSince` on a working row: screen and transcript unchanged past its threshold), `stallLabel`, `newlyStalled(rows, seen)`, and `backgroundLabel(child)` ("3 background tasks" from the Hook's `backgroundTasks` on a working row, shown as Home's Working sub line when there is no current step and as a sidebar chip). Home's Working rows turn red with "stalled 7m", detailed sidebar rows show it in place of their age, and `shell/needs-notify.js` notifies once per stall (`stalledNotice`, behind the needs-you notification setting). Exported for `src/ui-stalls.test.ts`.
- `shell/quiet.js`: quiet hours, `{ on, from, to }` in localStorage `phren.desktop.quiet` (local time; a window may cross midnight), `inQuietHours(date, from, to)` (exported for `src/ui-quiet.test.ts`) and `quietNow()`. `app.js` gates the needs-you, stalled and CI notifications on `!quietNow()`; stalled ones also on Settings' `stallNotifyEnabled()` (`phren.desktop.notify-stalled`). Notifications skipped in quiet hours are not shown later.
- `shell/move.js`: `openMoveSheet({ computer, child })`, from a sidebar row's menu (Continue in…) and the ⌘K command "Continue this session in…" (shown only while a session is open, via `registerCommand`'s `when`). Lists the other harnesses (`moveChoices` over `GET /v1/harnesses`, unusable ones disabled) and, for Claude, the usable non-default accounts (`moveAccounts`); Continue posts `POST /v1/sessions/move { target, to: { harness, account? }, id }` and follows `GET /v1/sessions/move?id=` every 2 s (`moveStatus` words each state) until moved or failed. Reuses `launch.css`. Exported for `src/ui-move.test.ts`.
- Home's Needs you: a row whose agent is simply waiting (`agentStatus` `waiting`, no approval) gets a reply box under it that sends `/v1/prompt` through `sendReply` (`shell/needs-notify.js`). Drafts and the last "Sent" / error stay per session across re-renders, and the block does not redraw while a reply box is focused (it catches up on blur).
- `branch-tasks.js`: `loadBranchTasks(computer, project, branch)` over `GET /v1/projects/:project/tasks?branch=` (null on an older Hook), `completeBranchTask` over `POST …/tasks/complete {id}`, and `renderBranchTasks({ computer, project, branch, state, rerender })`, the card with Done. Shown on Changes › PRs for the current request and in the project page's Code block for the checkout's branch.
- `shell/launch.js`: `openLaunchSheet({ project, computer, role, prompt, title, label, chat })`; `chat: true` is a quick chat (the phren harness with `mode: "chat"`, role, worktree and permission hidden, disabled with a reason when the computer's Hook lacks `quickChat`), opened from a project page's Quick chat and the ⌘K command, the launch sheet over `POST /v1/workspaces/launch`. `prompt` shows an editable First prompt sent as the launch's `brief` (`{id, text}`); Fix it on a failing request (Changes › PRs, the project page's Code block) opens it with `fixItPrompt` from `git-review.js`.
- `shell/usage-rings.js`: `mountUsageRings(el)` over the daemon's `GET /api/usage` (merged across computers with the CLI's `mergeAccountUsage`)). The popover lays accounts out like the phone's Account usage cards: title by email (plus the plan when one email has two), plan line, computers and age, every window with its reset ("not started" for a 5-hour window without one), API credits as dollars with their expiry, and Codex credits. Its text helpers (`accountTitles`, `subscriptionSummary`, `metaLine`, `windowText`, `creditsValue`) are exported for `src/ui-usage.test.ts`.
- `sections/settings.js`: the page list and `mountSettings`; each page is a module in `sections/settings/` (`computers.js`: link and revoke via `POST /api/computers/link|revoke`, health, resources, peers, files; `keys.js` with the summon row; `appearance.js`; `notifications.js`; `diagnostics.js`; `about.js`), sharing `settings/ui.js` (DOM and request helpers, `toggleRow`) and `settings/prefs.js` (localStorage keys). It re-exports `notifyEnabled()`, `badgeEnabled()`, `ciNotifyEnabled()` and `stallNotifyEnabled()` from `settings/prefs.js`.
- `sections/settings/about.js`: last Settings page; desktop version from `window.phrenDesktop.version` (Electron's `app.getVersion()`, or browser mode), live computer states and Hook versions from the shared store, and Copy for a bug report using exported `aboutText` with platform and user agent; shows "Copied" for 2 seconds.

## Writes

Every non-GET request to the daemon sends `Content-Type: application/json` and
`X-Phren-Desktop: 1` (the daemon refuses anything else). Use `hookPost` from
`api.js`.

# Phase 0 spike (still current below)

Plain browser ES modules, no bundler, no framework. Served by src/server.ts from
this folder; xterm is at `/vendor/xterm/xterm.js` (ESM build `/vendor/xterm/xterm.mjs`),
`/vendor/xterm/xterm.css`, `/vendor/addon-fit/addon-fit.mjs`,
`/vendor/addon-webgl/addon-webgl.mjs`.

Files and owners:
- `index.html`, `theme.css`, `app.js`, `terminal.js`: the shell (layout, data flow, terminal tile).
- `sidebar.js`: the sessions sidebar.
- `chat.js`: the chat pane; applies preview updates (including clears) on every transcript frame carrying them.
- `chat/composer.js`: owns delivery state for both the pending strip and timeline echoes. `createComposer` takes `submissionCursor()` (the last known transcript line when sending, or `null` until the initial backlog arrives) and returns `applyDelivery({deliveryId,state,reason?})` for pushed receipts, `reconcileTranscript(messages, acknowledgementID?)` for FIFO non-queued user-row matching of pending submissions after their cursor (exact text after whitespace normalization), and `pendingEchoes()` for the timeline. `onDelivery(fn)` notifies state changes, including removals; receipt polling remains the fallback. The optional acknowledgement-ID callback defaults to the row ID; chat supplies `AgentChatHistory.acknowledgementID` so a consumed queue row and its real replacement settle only one submission. The composer retains settlement under both row identities across transcript resets and reconnects. Submissions sent before the initial backlog receive its end cursor when it loads, so its historical rows never settle them. Queued transcript rows and failed submissions never settle deliveries through text matching; only a submission's own late delivered receipt overrides its earlier failure. Delivered receipts reserve their first matching transcript row even after the echo disappears. `draftKey(target, computer)` scopes drafts by computer; the target-only key is read for one-time migration when no scoped draft exists.
- `chat/recall.js`: the composer's recall strip. Once a prompt has three words, a typing pause asks the session's project memory (`GET /v1/projects/:project/memory/search`, 6 results) and shows up to three confident hits (score 0.3 or more) as chips above the editor; a click appends `Phren remembers: <text>` to the prompt, × hides them until the prompt is sent. `recallQuery`, `recallHits` and `withRecall` are exported for `src/ui-recall.test.ts`.

## Exports

```js
// sidebar.js
export function renderSidebar(el, merged, handlers)
//   merged: MergedOverview (src/contract.ts). Re-render fully on every call.
//   handlers.onOpenChat(computerName, child)     // child: OverviewChild with a target
//   handlers.onOpenTerminal(computerName, server) // server: child.target.server or mux.session
//   handlers.onDropFiles(computerName, child, files) // Files dropped on a row: open it, then attach(files)

// chat.js
export function openChat(el, computerName, child) // returns { close(), focus(), insert(text), attach(files) }

// terminal.js
export function openTerminal(el, computerName, server) // returns { close() }
```

## Server endpoints the UI uses (same origin; the token cookie is already set)

- `WS /api/overview` → `{type:"overview", merged}` frames.
- `WS /hosts/<computer>/v1/transcripts?<target as query>` → Hook frames
  `{type:"backlog"|"append"|"older"|"preview", entries:[{line, raw}], ...}`.
  `raw` is the harness's own JSONL row (Claude: `raw.type` "user"|"assistant",
  `raw.message.content` string or `[{type:"text",text}|{type:"tool_use",name,input}|{type:"tool_result",content}]`;
  Codex: `raw.type` "response_item" with `raw.payload.type` "message" and
  `raw.payload.role`, `raw.payload.content[{type:"input_text"|"output_text", text}]`).
- `WS /hosts/<computer>/v1/status?<target as query>` → `{agentStatus:{status, pendingApproval, pendingQuestions, terminalPrompt, passwordPrompt, compacting, suggestion, permissionMode, historyStalled, capabilities, settingsState, branch}}` frames (built in packages/cli/src/bridge/server-stream.ts).
- `POST /hosts/<computer>/v1/prompt` body `{target, text, deliveryId}` (deliveryId: crypto.randomUUID()).
- `POST /hosts/<computer>/v1/keys` body `{target, keys:["Escape"]}` to stop.
- `POST /hosts/<computer>/v1/approvals/answer` body `{target, actionId, decision:"approve"|"deny"}`.
- `WS /pty?computer=&server=&cols=&rows=` → terminal output as text frames;
  send input as BINARY frames (UTF-8 bytes) and `{"type":"resize","cols","rows"}`
  as a text frame. Text frames are never written to the terminal.

## Look (Phren Charcoal; use these CSS variables from theme.css only)

--bg #1E1E1E; --sunken #141618; --surface #282A2C; --card #323437; --raised #3C3F42;
--tool #121416; --text #FFFFFF; --text-2 #ECEDEE; --muted #A4A9B1; --dim #999FA8;
--accent #B994F4; --accent-hover #DCC5FF; --accent-solid #7450A7; --link #C2AAFF;
--working #B994F4; --waiting #E0BC7F; --done #8AC8AC; --danger #EF9898;
--path #7FB6F0; --branch #F0A06E; --border rgba(255,255,255,0.07); --border-strong rgba(255,255,255,0.14);
Spacing 4/8/12/16/20/24 px; radius 10 px cards, 12 options, 18 large, 999px pills;
rows min 36 px (desktop density); transitions 0.18s ease; no decorative animation;
UI font system-ui; transcript and code font "JetBrains Mono", ui-monospace, Menlo, monospace.

Session row (sidebar): a provider glyph letter in a ring colored by status
(working lavender, blocked/waiting amber, idle/done muted), project name (basename of cwd)
in --accent, branch in monospace --muted, computer name, age ("2m"), title below in --text-2,
a 3 px left accent bar for working (--working) and needs-input (--waiting).
Sections in small caps with counts: "NEEDS YOU · 1", "WORKING · 2", "IDLE · 3", then "COMPUTERS"
listing each computer with a state dot (online --done, connecting --muted, offline --danger).

# Changes and editor (phase 1b)

Owner direction 2026-10-09: "look at Codex and VS Code, mixed, but based more on
Phren." So: Phren's phone Changes and Code screens are the base (looks, words,
row shapes); VS Code supplies the desktop layout (file tree, editor tabs, side by
side diff, ⌘P, ⌘S, dirty dots); Codex supplies review beside the conversation
(comment on a line, send it to the agent working there).

## Workbench (owned by sections/agents.js)

The right panel `#side` is the workbench: a segment control at its top with
**Changes · Files · Terminal** (pill segments, raised background, selected
segment in --accent text on --card). Opening a session's chat also scopes the
workbench to that session. A drag handle on its left edge resizes it (280 px to
75 % of the window), and a maximize button lets it cover the chat.

Each pane module gets a container element and a context:

```js
ctx = {
  computer,          // the Computer name
  child,             // OverviewChild; child.target is the session target
  openFile(path, { line, diff }),  // switch to Files and open path (diff: true opens the diff view)
  showChanges(),     // switch to Changes
  ask(text),         // put text in that session's chat composer (Codex-style review)
}
```

`ui/api.js` (exists): `hookPost(computer, route, body)`, `hookGet(computer, route, query)`,
`targetQuery(target)`, `readRepoFile(computer, target, path) → {text, version, total}`.
Errors are `Error` with `.status`, `.code` and `.body` (the Hook's JSON).

## Hook routes these panes use (all take the session `target`)

- `POST /v1/git/status {target}` → `{branch, upstream, ahead, behind, staged, unstaged, untracked,
  additions, deletions, totalFiles, files:[{path, status:"M"|"A"|"D"|"R"|"?", staged, additions, deletions, binary}], repository}`.
  A file staged and also changed again appears twice (staged true and false).
- `POST /v1/diff {target, paths:[]}` → `{files:[{path, status, sections:[{id, kind:"staged"|"unstaged", binary, patch, truncated}]}]}`
  (`patch` is unified diff text; untracked files have no sections; read them whole).
- `POST /v1/git/stage|unstage|discard {target, paths:[...], expectedRepository}`; stage also takes `confirmBulk`.
- `POST /v1/git/commit {target, message, expectedRepository}`; `POST /v1/git/push {target, expectedRepository}`
  (a 409 whose `error.body.defaultBranch` is set means pushing the default branch: ask with a Phren dialog, then resend with `confirmDefault: true`).
- `POST /v1/git/log {target, limit}` → `{commits:[{sha, short, subject, author, date, refs, parents}]}` (History).
- `POST /v1/git/tree {target, path}` → `{path, entries:[{name, path, kind:"dir"|"file", fileCount?}]}` one directory.
- `GET /v1/files/range` via `readRepoFile`.
- `POST /v1/files/write {target, path, content, version}` → `{path, version, size}`; 409 code
  "file-changed" when the file moved since `version`; omit `version` only to create a new file
  (409 code "file-exists" if it exists). Only Hooks advertising `capabilities.fileWrite` have it;
  others answer 404: show "Update Phren on <computer> to save files here."

## Look additions (Phren phone Changes screen)

- Title row: "Uncommitted changes" (or History, Branches) with a ▾ that opens the section menu,
  and a quiet line under it in mono --muted: "main · 3 files +12 −3".
- Section headers: small caps `STAGED` / `CHANGES` followed by a count pill (raised, radius 999, 11 px).
- File row (40 px): a 24 px status tile (radius 6, tinted background: M and A green rgba(138,200,172,.16)
  with --done letter, D rgba(239,152,152,.16) --danger, ? --muted on raised, R --link), file name in mono
  --text, its folder below in --muted 12 px, then `+n` in --done and `−n` in --danger, right aligned.
  Hover reveals row actions as small icon buttons: open file, stage (+) or unstage (−), discard (↺).
- Diff rows: mono 12.5 px, line-number gutter in --dim, added rows rgba(138,200,172,.14) with the changed
  words rgba(138,200,172,.32), removed rows rgba(239,152,152,.14) / .32, hunk header `@@ -2,3 +2,3 @@`
  in --accent on a hairline rule. Syntax colour is not required in the list diff.
- Footer: commit message field (sunken, radius 12) + "✓ Commit" button (--accent-solid at 0.35 when
  disabled, full when enabled) + "↑ Push N" pill when ahead > 0. "Stage all" replaces Commit when nothing is staged.
- Words: "Changes", "Files", "Uncommitted changes", "Working tree clean", never "symbol" or "SCM".

# Code index and search (phase 1c)

## Which project's index

The code index is per project, not per checkout. Resolve once per session:
`GET /v1/projects/repos` → `{repos:[{directory, name, registered}]}`; the project is the
`name` of the entry whose `directory` equals the Changes status `repository` (from
`POST /v1/git/status`) and whose `registered` is true. Then `GET /v1/code/status?project=<name>`
must answer 200 with `available: true`; otherwise the index is off for this session (no
error UI beyond a quiet "No code index for <name>" note where the feature would be).
All index paths are repository-relative, the same as editor paths.

## Code index routes (GET, query `project=<name>`)

- `/v1/code/file-references?path=<file>` → `{references:[{line, kind, name, symbol:"file::Name", file, targetLine, targetKind}]}`:
  every resolved use in that file (no columns: match by line and the word's text).
- `/v1/code/definition?name=<Name | file::Type.member>` → `{definition:{symbol:{name, kind, file, line, endLine, signature, doc, uses}, candidates, findings:[...]}}`.
- `/v1/code/references?name=<…>&limit=200` → `{references:{symbol, groups:[{file, references:[{line, kind}]}], total}}`.
- `/v1/code/outline?path=<file>` → `{entries:[{name, kind, line, endLine, signature, children:[…]}]}`.
- `/v1/code/search?q=<text>&limit=50` → `{symbols:[{name, kind, file, line, signature, doc}]}`.
Words in the UI: function, type, variable, method, class; never "symbol".

## Find in files

`POST /v1/files/search {target, query, regex?, caseSensitive?, wholeWord?, include?: string[], limit?}`
→ `{matches:[{file, lines:[{line, column, text, offset?}]}], files, total, truncated}`.
`column` is 1-based in the full line; `text` is at most 300 chars starting at `offset` (0 when absent).
Errors: 400 code "search-invalid-regex", 413 code "search-too-broad". Hooks without
`capabilities.fileSearch` answer 404: show "Update Phren on <computer> to search here."
- `POST /v1/files/list {target}` → `{files: [path…], total, truncated}`: every tracked and untracked
  (not ignored) file, for ⌘P. Same `fileSearch` capability; on 404 fall back to the paths already loaded.

# VS Code extensions (phase 1d)

Owner decision 2026-10-09: VS Code extensions through monaco-vscode-api, keeping
Phren's own UI. The editor host (`packages/desktop-editor`, built by Vite to
`ui/editor-host/`) runs VS Code's editor services and a web-worker extension host.

What runs: declarative contributions of any extension (themes, icon themes,
grammars, language configurations, snippets) and the code of **web extensions**
(manifest `browser` entry). Extensions with only a Node `main` contribute their
declarative parts; their code runs in the Node extension host below, when the owner
turns Node extensions on.

## Node extension host (src/reh.ts, src/reh-sandbox.ts)

VS Code's remote extension host (REH), built by `packages/desktop-editor/scripts/build-reh.sh`,
runs Node extensions on this computer, bound to 127.0.0.1. It is off until the owner turns it on:

- `GET /api/extensions/node` → `{enabled, isolation: "sandbox"|"environment"}`;
  `POST {enabled: boolean}` turns it on or off (off stops a running host).
- `GET /api/reh` → `{available, authority?: "localhost:<port>", connectionToken?, version?, isolation?, reason?}`,
  starting the host lazily.

The host's one channel is the loopback WebSocket the editor page opens to it with
`connectionToken`, made fresh on every start (its own 0600 file in `<reh>/tokens/`, removed when the host exits). It holds no
daemon credential: not the daemon token or cookie, not the Hook socket, not an SSH key or
ControlMaster. Install and uninstall run the same launcher, isolated the same way. If a
host feature ever needs the daemon, add it as a route reachable only with a per-start
token scoped to an explicit allowlist of routes, never by handing over the daemon token,
the Hook socket or the bridge folder.

Isolation (`reh-sandbox.ts`):
- Environment: drops `PHREN_*`, `SSH_*`, `TMUX*`, `HERDR_*`, `ELECTRON_*`, `VSCODE_*`, `npm_*`,
  `NODE_OPTIONS`, `DBUS_SESSION_BUS_ADDRESS`, askpass helpers and any name that reads as a
  credential (token, secret, password, API key, auth, cookie, `*_KEY`). `HOME` (also the
  cwd) is `<reh>/home`; `TMPDIR` (and `XDG_RUNTIME_DIR` off macOS) is `/tmp/phren-reh-<uid>`
  (0700). Toolchains that locate themselves through HOME (`CARGO_HOME`, `RUSTUP_HOME`,
  `GOPATH`, `PYENV_ROOT`, `NVM_DIR`, `VOLTA_HOME`, `BUN_INSTALL`, `SDKMAN_DIR`,
  `GIT_CONFIG_GLOBAL`) are pointed at the owner's real folders when they exist.
- File descriptors: the daemon closes the token pipe (fd 3) once read; the host gets
  stdin `/dev/null`, stdout and stderr only.
- macOS: `sandbox-exec -p <HOST_PROFILE> -D NAME=path…` (paths as parameters, never
  spliced into the profile). `(allow default)`, then denies: read/write of the bridge
  folder, `/tmp/phren-desktop-<uid>` (ControlMasters), `~/.cache/phren/desktop-traces` and
  `~/Library/Application Support/Phren`; writes to what the daemon or the owner later runs
  outside the sandbox: the desktop's extensions folder, the installed app's own code,
  `~/Library/LaunchAgents`, every folder on the daemon's PATH, the node it runs on,
  `/opt/homebrew`, `/usr/local`, shell startup files, `~/.ssh`, git's global config and
  Claude's and Codex's settings (never a folder the host itself writes in); renaming or
  removing any ancestor of those paths (which would move them out from under their
  rules); unix-socket connects into the
  bridge folder (`hook.sock`), the ControlMaster folder, Herdr's folder, tmux's
  `tmux-<uid>` and launchd's SSH agent; AppleEvents, LaunchServices opens and running
  `launchctl`, `crontab`, `at`, `osascript` and `open`. `PHREN_REH_SANDBOX=off` turns it
  off for troubleshooting. `isolation` is `"sandbox"` only when it is applied.
- Linux and Windows: environment and folders only (`isolation: "environment"`): the key and
  `hook.sock` stay reachable there, and Settings › Extensions says so.
- Not covered, even on macOS: the profile starts from `(allow default)`, so an extension
  still reads the owner's other files (other projects, `~/.ssh`, cloud credentials) and
  the network, and the write denials list known ways out rather than every file something
  later executes. Follow-ups: bubblewrap on Linux; a deny-default profile limited to the
  opened folders and toolchains.

## Daemon (src/extensions.ts, routes in src/server.ts)

Installed extensions live in `<config>/phren/desktop-extensions/<publisher>.<name>/`
(`<config>` = `$XDG_CONFIG_HOME` or `~/.config`), holding the unzipped `extension/`
folder of the VSIX plus `phren.json` `{id, version, installedAt, enabled, source: "open-vsx"}`.

- `GET /api/extensions` → `{extensions:[{id, version, displayName, description, publisher, enabled, kind:"web"|"declarative"|"node", icon?: url, manifest, files:[relative paths]}]}`
  `kind`: "web" when the manifest has `browser`; "node" when it has `main` but no `browser`;
  else "declarative". `files` lists every file under `extension/` (posix, relative, max 5000).
  `icon` is `/extension-files/<id>/<manifest.icon>` when set.
- `GET /api/extensions/search?q=<text>` → proxies `https://open-vsx.org/api/-/search?query=<q>&size=30`
  and returns `{extensions:[{namespace, name, version, displayName, description, downloadCount, icon}]}`.
- `POST /api/extensions/install {namespace, name}` → fetch `https://open-vsx.org/api/<ns>/<name>/latest`,
  download `files.download` (max 60 MB), verify it against `files.sha256` (hex in the body),
  unzip with fflate, keep only `extension/**` (reject absolute paths, `..`, symlinks), write to a temp
  dir and rename into place (replacing an older version). Returns the installed entry.
- `DELETE /api/extensions/<id>`; `POST /api/extensions/<id>/enable {enabled}`.
- `GET /extension-files/<id>/<path>` → a file from that extension's `extension/` folder (no traversal).
Ids match `/^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/`.

## UI (ui/extensions.js)

`openExtensions(el, ctx)` → `{ close() }`, the workbench's Extensions segment, Phren style:
a search field ("Search Open VSX"), INSTALLED and RESULTS sections. A row: 32 px icon (or a
letter tile), display name in --text, publisher in --muted, description one line, a kind chip
("Runs here" for web in --done, "Themes and grammars" for declarative in --muted, "Needs a Node host" for node
in --waiting), and Install / Uninstall / Enable / Disable buttons. After any change call
`window.PhrenEditorHost?.reloadExtensions?.()` if present and show "Reload the window to finish" when it returns false.
A "Color theme" select at the top lists every contributed theme from installed + built-in
(`PhrenEditorHost.themes()` → [{id, label}]) and applies it with `PhrenEditorHost.setTheme(id)`.

Implementation notes (verified 2026-10-09): `registerCustomProvider` must run before
`initialize`; the worker URLs use the literal `new Worker(new URL(...))` pattern with
a stand-in Worker class so Vite bundles them; `files.sha256` from Open VSX is a URL to
the digest file; the extension host frame runs on `{{uuid}}.localhost` and loads its
worker from the page origin, so the UI is served as `localhost` (its CSP allows
`http://localhost:*`, not 127.0.0.1); `/editor-host/*` and `/extension-files/*` are
public, read-only and served without the cookie.
