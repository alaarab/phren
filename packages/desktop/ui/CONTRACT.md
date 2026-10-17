# UI contract

Read "Shell" first: it is how every new screen plugs in.

`chat/answers.js`: `answerQuestion(computer, target, { id, answers, questions })`
posts to `/v1/questions/answer`. Cards pass normalized questions with
`options: [{ label, description? }]` and answers with `{ optionIndexes, text? }`.
For Claude and OpenCode it sends question text, `multiSelect` and string option
labels; for Codex it sends `toolUseId: id` and answers without questions.

`chat/cards.js`: `renderInteractions(container, agentStatus, { computer, target,
onAnswered })` renders question sets from both `pendingQuestions` (Codex) and
`terminalPrompt.questions` (released Claude and served OpenCode), using the same
answer card and serializer. The chat's card signature includes terminal questions
so changes redraw the cards while identical status frames preserve typed answers.

# Shell (phase 1)

`index.html` holds only the titlebar (`#section-pills`, `#needs-pill`,
`#conn-count`) and `#sections`. `app.js` registers sections and wires keys,
badge and notifications; nothing else lives there.

The titlebar navigation (`.section-nav`) shrinks and scrolls horizontally within
its own container, including the current group’s page tabs. Below 761 px, main
pills show icons with full titles and accessible names; needs-you shows its count
and computers shows online/total, retaining full accessible labels. The wordmark
and duplicate Home count hide at that width. Status and Settings stay outside
the scrolling navigation. Section changes and compact-window resizes reveal the
active page tab (or main pill) with nearest inline scrolling. The computers
fraction has screen-reader text “computers online” at every width, rendered by
`shell/titlebar.js` without relying on an accessible name on a generic span.
At 1280 px the labels and spacing are unchanged.

Agents at 760 px and below (`NARROW_QUERY` in `sections/agents.js`, the media
query in `theme.css`): the layout bar folds Mirror tab / Shell / Split / Zoom into a
`.layout-more` ("⋯") `role="menu"` (opens with focus on the first item; ArrowUp/Down,
Home/End move; Escape, Tab or an outside press close it, Escape returning focus to the
trigger). A `.layout-panel` button (`aria-expanded`) opens and closes the right panel,
which overlays the centre below the layout bar, starts closed, is remembered per chat
tab (`doc.panelOpen`), takes focus on open, and closes on Escape, on a press outside it
or on its toggle. Crossing the breakpoint closes the menu; narrowing closes the panel,
widening restores the panel's wide state. Wider windows are unchanged: `.layout-more`
and `.layout-panel` are hidden and `.layout-actions` is `display: contents`.

The chat header and composer compact by the chat pane's own width (`.session-doc` is
an inline-size container named `chat`; `@container chat` at 460, 340 and 290 px in
`chat/chat.css` and `chat/composer.css`), so a split tile gets them in a wide window.
The project, branch and computer move into the title's tooltip; below 290 px the
console, agents and workers shortcuts (`.pc-low`) fold away so send never clips.

## Daemon connections

The overview uses each computer's configured `server` and reconnects when its
SSH username, server or private key contents change. Pending handshakes and frames from a
replaced connection are discarded by connection generation. Heartbeat `phren` blocks refresh the merged
overview's version and capabilities while retaining its sessions.
`ChannelPool.acquire(computerName, { timeoutMs?, signal? })` bounds queued
acquisition (60 s by default); cancellation removes the waiter. HTTP's 60 s
deadline includes acquisition. SSH masters use a 96-bit SHA-256 socket name over the private key identity,
full pinned host key and destination (username, address, port), recomputed from the private file
on each use without trusting its `.pub` sidecar. `knownHostsPath(masterKey(computer))`
returns the identity's pin file under `desktop-cm`; it is written atomically before SSH
starts and never reused for another pin. Desktop-key SSH uses `IdentityAgent=none`,
`IdentitiesOnly=yes` and `StrictHostKeyChecking=yes`; the owner's enrollment and
revocation login still uses their own SSH configuration. Relinking closes old masters before
verification using the control paths retained when they were opened, including
when a key rotates at the same path; enrollment keeps the public key beside the private key as `.pub`.

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

Shared UI helpers live at the UI root. `dom.js` exports `el(tag, className, text)`
for creating elements with an optional class and text; import it with a local alias
when needed. `sections/settings/ui.js` also re-exports `el` for settings pages.

- `schedule-update.js`: `scheduleChanges(before, after)` allowlists edited schedule fields and uses `null` for removals; `updateSchedule(computer, project, original, before, after)` posts through `hookPost` with the exact stored revision, skipping unchanged values. Schedules retains the source Hook for each listed schedule and checks that Hook's `scheduleUpdate` capability for edits and Pause/Resume. Conflicts reopen the editor with the returned schedule and a review notice; removed schedules close it, and validation errors stay on the form. The sheet body scrolls, with wrapping timing controls and notices at narrow widths. Unchanged polls and refreshes preserve list nodes and focus; computer order alone does not trigger a read. Older Hooks, creation and deletion retain the daemon's memory save path. Covered by `src/ui-schedule-update.test.ts` and `src/ui-schedules.test.ts`.

- `shell/store.js`: `sessions(merged?, { includeOffline = false }?)` and `store.sessions(options?)` flatten online computers only by default; the sidebar requests last-seen rows with `includeOffline: true`. `needsYou(merged?)` counts only online attention. `sessionKind(child)` shares the attention predicate and preserves working, done, idle and error; other statuses are unknown. `store.find` also finds cached rows.
- `shell/returns.js`: `stateChip(state)` returns `{ label, cls }` for dispatch returns and worker states, shared by Conductor and Review; unrecognised states keep their word with no class, missing states read "unknown".

- `shell/approvals.js`: `startApprovals()`, started once by `app.js`, follows the overview store and opens a `/v1/status` watcher for each session with a pending approval. Home and the tray share `approvals.approval(key)`, `approvals.answerKey(key, decision, scope?)` and `approvals.subscribe(fn)`; watchers and summaries are removed when the approval or session goes away. Away data and its overview/CI feeders already live independently in `shell/away.js`. Home mounts without starting reads or keys; `show()` starts receipt/schedule polling, follows CI checks and attaches its keydown listener, and `hide()` stops them. The handler also ignores keys while hidden.

- `shell/theme.js`: `initTheme()`, `applyTheme(id)`, `currentTheme()`, `themes()`; the phone's five token sets in `tokens.json`. Extension themes colour the editor and terminal only.
- `shell/palette.js`: `openPalette()`, `registerCommand({ id, title, keys?, run, meta?, when? })` (`when()` hides a command while false; `meta` may be a function), `fuzzyScore(query, text)`. ⌘K. A query starting with `>` lists commands only; one starting with `?` asks the project memory scoped when the palette opened (`GET /v1/projects/:project/memory/search`, 250 ms debounce, 20 results) and Enter opens the Memory section through its handle's `open({ computer, project, segment, search })`. It also lists the open pull requests the CI watch last saw (`lastChecks()` from `shell/ci-watch.js`, read without following it, so no extra polling), failing first, and Enter opens that session on Changes › PRs. Projects come from the Projects section's handle (`projects()`, loaded once by `load()` when the palette first opens, then the list redraws); Enter calls its `open({ computer, name })`. Under `?` results, `askItem` adds "Ask in a quick chat: <question>", which opens the launch sheet in quick-chat mode on that project with the question as its first prompt (`launch.js` is imported when used: it registers its commands here at load). `paletteMode`, `memoryItems`, `pullItems`, `projectItems` and `askItem` are exported for `src/ui-palette.test.ts`. `shell/palette-recent.js` is the palette's memory of what you pick: `localStorage` `phren.palette.recent`, at most 200 `{ id, n, t }` rows (item id such as `session:<key>`, `command:<id>`, `project:…`, `file:…`; a decayed pick count and its time; never the query), pruned on read (malformed, faded below 0.05, duplicates). An empty query in `all` mode lists a **Recent** group after the boosted rows (sessions that need you, failing PRs, which stay first and are never in Recent): the 6 latest picks that still exist, in frecency order (copies with `recent:`-prefixed row ids; the original row is hidden). File paths are never stored; the store is read once per open and future-dated times are clamped to now. With a query, a match score is multiplied by `1 + min(0.5, 0.25 * log2(1 + count))` with the count halving every 3 days, so frecency never outweighs a clearly better match. Memory (`?`, `??`) results and the Ask row are not recorded or boosted. The "Clear recent" command (`palette.clear-recent`, shown while anything is stored) forgets it all. Tested in `src/ui-palette-recent.test.ts` and `e2e/palette-recent.spec.ts`.
- Check states are worded by `checksWord(checks, what)` in `git-review.js` everywhere (Home's Checks strip, ⌘K, the project page, Changes › PRs): "Checks failing / running / passing", with the host's word ("Pipeline") where it differs; transitions read "checks failed / passed", and a failed one is red.
- `shell/ci-watch.js`: `startCiWatch({ notify, enabled })`, started by `app.js`: every two minutes one `/v1/git/pulls` per computer and project with a working or recently active session (at most six), and a notification when that branch's open request's checks turn failing or passing (`startCiWatch({ notify, enabled, reviewEnabled })`). Each tick also folds the reads into one baseline per request, keyed by `prKey` (host + repository from the request URL, else project + number), so two chats on one branch or one project on two computers give one notification, carried by the most recently active session (`reviewLook`, `reviewStep`, `reviewNotice`): "Changes requested on #N title", "Approved: #N title" (only when it was not approved before) and "#N title now has conflicts". Never on first sight. A missing `reviewDecision` or an `UNKNOWN` merge state says nothing and the known state is carried; a state clears only on a positive opposite (`CLEAN`/`BLOCKED`/`BEHIND` clears conflicts, `REVIEW_REQUIRED`/`CHANGES_REQUESTED` clears approval, `APPROVED`/`REVIEW_REQUIRED` clears changes requested). Baselines are kept 6 h (`REVIEW_GRACE_MS`) after a request leaves the watch set or a read fails. A review change within 2 min of the owner's own action in the app (`noteOwnAction`, called after Changes › PRs merges) is silent. Gated by `notifyEnabled() && prNotifyEnabled() && !quietNow()` (`phren.desktop.notify-pr`, default on, Settings › Notifications "Pull request reviews and conflicts"). The checks notification is also sent once per request; the per-session look behind Home's strip is unchanged. GitLab reports only required approvals, never changes requested, so on GitLab only approval and conflicts notify. Notification keys are `pullsKey` (`pulls:<computer>|<project>|<session key>`, parsed by `parsePullsKey`); `shell/needs-notify.js` opens that session on Changes › PRs, else another live session of that project, else the project page (`openProject`), else Home. No extra polling. It polls only while notifications are on or a view follows it: `followChecks(fn)` hands Home's Checks strip each look (the open requests, ordered by `checksStrip`, failing first) and makes the watch look early when the watched sessions change. Home's chips open the session with Changes on PRs (`agents.openPulls`, `changes.showView`). `watchedSessions`, `ciTransitions`, `checksStrip`, `reviewStep`, `reviewLook`, `prKey`, `pullsKey`, `parsePullsKey`, `noteOwnAction` and `reviewNotice` are exported for `src/ui-ci-watch.test.ts`; `src/ui-ci-watch-review.test.ts` runs the watcher with fake timers.
- `shell/project-pulls.js`: Home's Pull requests card feed, `createPullsFeed({ computers, onUpdate, active, ready, canRead, cadence })`. Each `GET /v1/projects/:project/git` (the `/v1/git/pulls` reply with host and directory, no session needed) costs the Hook about ten git subprocesses and a forge call, so reads are sparse: a round every 5 minutes while Home is visible and the window has focus, every 15 without focus (`document.hasFocus()`), none while hidden (a read queued when Home hides is dropped) or from a computer that is stressed or low on battery (`computerReady`, as hover prefetch). Only "hot" projects (a session there moved in the last 7 days, or open requests last time) are read at that cadence; the rest at most every 30 minutes. One `GET /v1/projects/repos` per computer, cached ten minutes. At most 2 requests at once per computer and 4 in all, all through `hookGet` (the daemon's channel pool). A "no host", "sign in" (`auth`, `unknown-host`) or no-checkout answer is skipped for ten minutes; a transient `available: false` (timeout, rate limit, forge offline) never replaces good data: the old rows stay, marked stale (dimmed, ranked below every urgent row, dropped after 20 minutes), with "Couldn't read N projects" under the rows. The Projects page writes the same cache through `rememberProjectGit` and reuses a good answer under two minutes old (`freshProjectGit`; never a stale or unavailable one) unless Refresh forces it. `home/pulls.js` draws the card: `inboxRows` dedupes by repository (web address, else domain + remote + project) + number across computers, preferring a current, fuller, fresher read, and sorts conflicts, changes requested, failing checks, approved and passing, then the rest, newest first; eight rows and "Show all N" (the host's words: "MRs" on GitLab); the viewer's own requests read "you" when the payload names them; a "Refresh" at the foot forces one round. A click opens that project's session on Changes › PRs, or the project's page without one. Hidden with no open requests. Tested in `src/ui-home-pulls.test.ts` and `e2e/pulls-inbox.spec.ts`.
- `shell/merge-when-green.js`: `startMergeWhenGreen({ notify })`, started by `app.js`. Changes › PRs arms the branch's open request with "Merge when checks pass" (`armMerge`, kept in memory only); while anything is armed, one `/v1/git/pulls` per armed request every minute, and `/v1/git/pr/merge` with the armed method and `expectedHeadSha` once `mergeDecision` says its checks pass and the host does not block it. New commits, a failing check, conflicts or a closed request disarm it; each outcome is a notification. `mergeDecision` is exported for `src/ui-merge-when-green.test.ts`.
- `shell/recent.js` and `shell/recent-mru.js`: the Ctrl+Tab recent-chat switcher, `startRecentSwitcher({ open, enabled })` started by `app.js`. `agents.js` calls `noteActiveSession(computer, child)` where a tile becomes active (the same place as `setActiveSession`); the MRU list (`createMru`, cap `RECENT_LIMIT` = 8, kept in memory and `sessionStorage`) is resolved against `store.sessions({ includeOffline: true })` on each press, so vanished sessions drop out. Ctrl+Tab selects the previous chat, further Tab / Shift+Tab move the selection, releasing Ctrl opens it, Esc or window blur cancels, clicking a card opens it; the overlay (`role=dialog` with a `role=listbox`, `aria-activedescendant`, focus restored on cancel) shows only after 150 ms held, so a tap toggles chats without a flash. Nothing else binds Ctrl+Tab (sequential cycling stays `next_tab` / `previous_tab`, prefix+n / prefix+p). Settings › Keys has the toggle (`phren.desktop.recent-switch`, default on, `recentSwitchEnabled()`). Terminals, editors and iframes keep Ctrl+Tab (`ownsCtrlTab`), and a lone chat leaves the key alone. A missed Ctrl keyup is settled by the next keydown, pointerdown or mousemove with Ctrl up (`lostCtrl`: opens the selection when the overlay shows, else cancels); hiding the page cancels; held Tab repeats wait for the overlay then move at most every 150 ms. Cards open on click (or Ctrl+mousedown). The overlay is `aria-modal`, traps focus and keys, and announces the selection through a polite status. Only user-driven activations reorder the list: others wait until the next key or click (`noteUserInput`). Pure helpers are exported for `src/ui-recent.test.ts`.
- `shell/summon.js`: `startSummon(window.phrenDesktop)`, started by `app.js`. The Electron shell registers a system-wide accelerator (`globalShortcut`, IPC `phren:summon-key`) that shows and focuses the window and sends `phren:summon`, which opens ⌘K. The key is kept in localStorage (`phren.desktop.summon`, default `CommandOrControl+Shift+Space`, `""` is off) and set from Settings › Keys, which records it from a keydown (`acceleratorFromEvent`, ⌘/Ctrl or ⌥/Alt required) and reports a key the system refused. Absent in a browser. `acceleratorFromEvent` and `formatAccelerator` are exported for `src/ui-summon.test.ts`.
- `shell/tray.js`: `startTray(window.phrenDesktop)`, started by `app.js`. Sends the shell `trayState(store.needsYou(), trayEnabled())` over IPC `phren:tray` whenever it changes: up to twelve rows `{ key, title, sub }` and a `more` count, or `{ enabled: false }`. The shell draws a menu bar / system tray icon (`electron/tray/`, a template image on macOS) with the count beside it on a Mac and the rows in its menu; its New agent… item sends `phren:new-agent`, which opens the launch sheet; choosing a row sends `phren:open-session` with the row key, which `shell/needs-notify.js` opens. While the icon is on, closing the window on a Mac hides it and the Dock or the icon brings it back. Settings › Notifications turns it off (localStorage `phren.desktop.tray`). Absent in a browser. A row with a known pending approval (`shell/approvals.js`) carries its summary, and the shell gives it a submenu with that summary, Allow, Deny and Open; Allow / Deny come back as `phren:tray-answer` and `approvals.answerKey(key, decision)` answers through `/v1/approvals/answer`. The tray never mounts Home. `trayState` is exported for `src/ui-tray.test.ts`.
- `shell/needs-notify.js`: `startNeedsNotify(window.phrenDesktop, { enabled, openSession })`, started by `app.js`: a native notification for each row that newly needs you (`needsNotice`), carrying its session key. Approval notifications follow `approvals.subscribe` and remember session plus actionId across status reconnects and offline flaps until the approval clears on an online overview or the cached session disappears; plain waiting deduplicates by session. The first overview establishes a silent baseline, including its approvals when their action IDs arrive. Clicking one opens that session including cached offline rows (`phren:open-session`, shared with the tray). On macOS a plain wait (`agentStatus` `waiting`, no approval) takes a typed reply (`hasReply`), whose notification options carry `binding: { target, id, sessionId, conversationId }`, a copy captured at display time and echoed unchanged through Electron as `phren:reply`. `sendReply(key, text, { expected: binding })` checks that every target field and the row identity still match, including cached offline rows, then posts `/v1/prompt` to the captured target. Missing native bindings or replacement conversations are refused with a notice; a gone session or a refused prompt is its own notification. `redact.js` exports browser-safe `redactString(value)`, shared with daemon tracing through `#redact`, and `redactNotice(value)` which adds credential assignments and long encoded secrets to the existing bearer, known API key and private key redaction before notification truncation. The redacted body adds the row's `lastReply` (what the agent said last; overview rows from Hook 0.3.45 on) on a second line, Home shows it under Needs you and Since you left rows, and the Agents sidebar under a detailed row that needs you (not an approval). `needsNotice` and `sendReply` are exported for `src/ui-needs-notify.test.ts`.
- `shell/away.js`: `startAway()`, started by `app.js`, and the shared `away` tracker. Away begins when Home is not shown or the window is hidden or unfocused. Every online overview is observed for working → non-working turns. Settled CI checks (`noteChecks`) and shared usage polls (`observeUsage`, through `quotaBackTransitions`) are collected without extra reads or notification preference gates. Returning after `MIN_AWAY_MS` publishes `{ since, back, rows, checks, events }` to Home's Finished block; `events` contains only quota recoveries. Checks come first; turns and recoveries follow newest first. Each collection retains at most 20 entries during absence; quota baselines/cooldowns use the transition helper's pruning. Recoveries wrap their account/reset title to two lines and show an underlined Usage tag; the whole row opens account usage. Hand-offs appear only as the existing session row's subtitle and tag, without separate away items or hand-off tracking state. Dismiss clears the summary without replaying unchanged usage data. `createAway({ now })` and `endedTurns` are covered by `src/ui-away.test.ts`; `startAway()` returns a cleanup function.

- `shell/warm.js`: `startWarm({ sections, mount, settleMs })`, started by `app.js`. After the first overview with an online computer and a 3 s settle, mounts Projects and Tasks hidden through `sectionHandle`, one per idle callback, so their first reads happen before the first visit. Tested in `src/ui-warm.test.ts`.
- `shell/skeleton.js`: `skeleton({ count, itemClass, widths, wrapClass, label })` → a `role=status` `aria-busy` wrapper of placeholder items reusing the section's own item class (`pj-card`, `tasks-project`, `mem-row`), one `.skel` bar per width (a list of lists varies them per item). Styles in `theme.css` (`.skel`, `.skel-wrap`), still under reduced motion.
- `shell/hook-drift.js`: `hookDrift(merged.computers)` → `{ newest, behind }` from each online computer's overview `phren.version` (no Hook calls), `compareVersions`, `hookVersion`, `updateCommand(version)` (`npx --yes @phren/cli@<v> bridge update`). Home's Computers rows show `Hook <version>`; one behind the newest gets an "update to <newest>" chip that copies the command, and Settings › Computers marks its version the same way. Exported for `src/ui-hook-drift.test.ts`.
- `shell/update-chip.js`: `startUpdateChip(window.phrenDesktop, beforeEl)`, started by `app.js`. The shell's updater (`electron/updates.js`) sends `phren:update` `{ version, current, notes, action }` when a newer release is available (`download`, a build that cannot update itself) or downloaded (`restart`); `notes` are the release body's lines (`noteLines`), which the release workflow takes from `packages/desktop/CHANGELOG.md`. The chip opens What's new; its button sends `phren:update-action`, and Later hides that version (localStorage `phren.desktop.update-skipped`). With no window the shell falls back to a dialog. `updateView` and `noteLines` are exported for `src/ui-update-chip.test.ts`.
- `shell/stalls.js`: `stalledMinutes(child)` (the Hook's `stalled` / `stalledSince` on a working row: screen and transcript unchanged past its threshold), `stallLabel`, `newlyStalled(rows, seen)`, and `backgroundLabel(child)` ("3 background tasks" from the Hook's `backgroundTasks` on a working row, shown as Home's Working sub line when there is no current step and as a sidebar chip). Home's Working rows turn red with "stalled 7m", detailed sidebar rows show it in place of their age, and `shell/needs-notify.js` notifies once per stall (`stalledNotice`, behind the needs-you notification setting). Exported for `src/ui-stalls.test.ts`.
- `shell/muted.js`, `shell/muted-mark.js`: **Mute notifications** for one chat, a per-viewer preference in localStorage `phren.desktop.muted` (a JSON array of row keys, `<computer>/<child id>`, capped at 200, every read and write in try/catch; the `storage` event syncs other windows). The chat header's `⋯` menu has "Mute notifications" / "Unmute notifications" (after Copy session id). A muted chat raises no native notification from `shell/needs-notify.js` (needs-you, "Still waiting" and stalled notices; it is still recorded as announced, so unmuting never replays an old notice), and adds nothing to the dock badge (`app.js`) or the tray (`shell/tray.js`). It still counts in the titlebar, window title and Home's Needs you, and still shows in the sidebar. It carries a small muted bell: `.sb-muted` on its sidebar row (both row styles) and `.chat-muted` in its chat header, both built by `mutedMark(className)` ("Notifications muted"). The decision is the pure `notifiable(row, mutedKeys)` (and `unmutedRows(rows, mutedKeys)`); `pruneMuted(keys, liveKeys, missing, now, graceMs)` forgets a key whose chat has been absent from the overview for 60 s (`GONE_MS`, so one frame without it keeps the mute; `store.js` calls `muted.prune` on every frame with offline computers' rows included). `createMuted({ storage, now })` is the test seam (`has`, `keys`, `set`, `toggle`, `prune`, `reload`, `subscribe`); `muted.subscribe` refreshes store listeners so the badge and tray follow a change at once. CI-watch, merge-when-green and quota notifications are not per-chat and are not muted. Tests: `src/ui-muted.test.ts`, `e2e/chat-mute.spec.ts`.
- `shell/window-title.js`: the window title, `document.title`: `(N) <chat title> — Phren` while the focused tab (of the focused tile) is a chat, `(N) <Section> — Phren` otherwise (Agents with a file, diff, terminal or console tab focused, or no tab, says `Agents`), `Phren` before any section shows; `(N) ` is the needs-you count (snoozed rows left out, muted ones kept) and is omitted at zero, as before. The pure `windowTitle({ needs, chat, section, showChat = true })` builds it and `clipTitle(text, max = 60)` drops control and format characters (`\p{Cc}`, `\p{Cf}`: bidi overrides, zero-width), collapses whitespace and clips to 60 characters with `…`, so a title cannot reorder the line or fake the `(N)` prefix. Settings › Appearance › Window has "Show the chat's title in the window title" (`phren.desktop.title-chat`, per viewer, default on, `titleChatEnabled()`); off, the section name is used instead. `startWindowTitle(read)` (started in `app.js`; `read()` returns `{ needs, chat, section, showChat }` from `store.needsYou()`, the Agents handle's `activeChatTitle()` and `sectionLabel(currentSection())`) rewrites it, deferred one microtask, on `refresh()` (overview frames and `onSectionChange`), on the document event `phren:tabs-changed` and on window focus. Agents' `onActivate` (the one place the focused doc changes: a tab click, a tile focus, a collapsed tile, a close) and `createTiles`' `onBlank` (an empty tile took focus, by a click or a split; it clears `focusedDoc`) record the focused doc of any kind in `focusedDoc` (separate from `activeDoc`, which only chats and files with a child set) and fires the event, as does the last tab closing; `tabs.setTitle` fires it for a rename, and the Settings toggle fires it too. The Electron shell never sets the title after creating the window (no `page-title-updated` handler), so the Window menu, Mission Control, the app switcher and the Windows/Linux taskbar show this string (the macOS hiddenInset window draws no title text); the tray and needs notifications build their text from overview rows, not from the title. Tests: `src/ui-window-title.test.ts`, `e2e/window-title.spec.ts`.
- `shell/snooze.js`: Snooze for Home's Needs you rows, a per-viewer view preference in localStorage `phren.desktop.snoozed` (capped at 50 entries, expired ones pruned; no Hook or CLI call). `snoozes` (`createSnoozes({ storage, now, setTimer, clearTimer })` for tests) keys an entry on the row key plus `snoozeVersion(child)` (status, approval flag, `lastReply`; not `lastChangedAt`, which tab activity bumps), so a new message or a changed state shows the row again at once. A row missing from the overview for under a minute keeps its snooze. At most 50 entries: expired go first, then the oldest created, never the one just added. The `storage` event syncs other windows (`reload()`), and a chat snoozed from Home carries a moon (`.sb-snoozed`, title "Snoozed until …") in the Agents sidebar, which still lists it under Needs you. `onWake(fn(keys, why))` reports snoozes that end by `"time"` or `"manual"` (Wake now); `shell/needs-notify.js` sends one deliberate "Still waiting: <chat>" notification when a snooze ends by time, nothing when snoozing or on Wake now, and an ordinary notice when the row changed meanwhile. Only `snoozable(child)` rows can be snoozed: a chat that is plainly waiting for a reply (`agentStatus` `waiting`, no approval). Approvals, permission requests and blocked agents never are. `needsYou()` / `store.needsYou()` leave snoozed rows out, so the titlebar count, Home's badge and count, the dock badge, the window title and the tray follow; `snoozes.snoozed(rows)` lists them for Home's collapsed `Snoozed (N)` footer with Wake now. One timer is armed for the next wake and re-armed on every change; `app.js` calls `snoozes.start()` once, which also re-checks on visibility and focus so a sleeping laptop wakes rows on time. Home's menu is a keyboard-operable `role=menu` (Enter/ArrowDown opens, arrows move, Escape closes) with 15 minutes, 1 hour and 9:00 local ("Until 9:00" before 9:00, else "Until tomorrow 9:00"). Tests: `src/ui-snooze.test.ts`, `src/ui-snooze-notify.test.ts`, `e2e/snooze.spec.ts`.
- `shell/quiet.js`: quiet hours, `{ on, from, to }` in localStorage `phren.desktop.quiet` (local time; a window may cross midnight), `inQuietHours(date, from, to)` (exported for `src/ui-quiet.test.ts`) and `quietNow()`. `app.js` gates the needs-you, stalled and CI notifications on `!quietNow()`; stalled ones also on Settings' `stallNotifyEnabled()` (`phren.desktop.notify-stalled`). Notifications skipped in quiet hours are not shown later.
- `shell/move.js`: `openMoveSheet({ computer, child })`, from a sidebar row's menu (Continue in…) and the ⌘K command "Continue this session in…" (shown only while a session is open, via `registerCommand`'s `when`). Lists the other harnesses (`moveChoices` over `GET /v1/harnesses`, unusable ones disabled) and, for Claude, the usable non-default accounts (`moveAccounts`); Continue posts `POST /v1/sessions/move { target, to: { harness, account? }, id }` and follows `GET /v1/sessions/move?id=` every 2 s (`moveStatus` words each state) until moved or failed. Reuses `launch.css`. Exported for `src/ui-move.test.ts`.
- `shell/up-next.js`: Home's Up next block. `upNext(byComputer, now, { hours = 12, limit = 4 })` keeps the schedules a Hook owns that are enabled, not running and whose `nextRun` falls in the window, soonest first; `untilLabel` ("in 42m", "in 3h 5m"), `clockLabel` ("21:30", "tomorrow 01:00", the row's tooltip) and `promptLine` (the prompt's first line, the row's sub line). Home keeps each online computer's `/v1/schedules` answer from the poll that already feeds Finished (no extra Hook calls), hides the block when nothing is due, and a row opens Schedules. Rows are keyed by schedule: an unchanged poll or overview update keeps the same buttons (and focus) and only refreshes the wait; changed schedule text updates in place, preserving action controls and focus. Each row has a separate Run now button with a five-second “Run? Yes” / Cancel confirmation, Starting… busy state and four-second Started or Hook error status. `shell/schedule-run.js` shares the Schedules POST `/v1/schedules/run` payload `{ project, id, expectedUpdatedAt }`; Home targets the owning answer’s desktop computer alias. Offline computers, missing schedules capability/routes and running schedules cannot launch; running schedules are omitted by the Up next selector. Timers are cleared when rows disappear or Home is destroyed. Working rows omit whitespace-only activity lines. Long project and computer names truncate with the full name as the title. Exported for `src/ui-up-next.test.ts`.
- Home's Needs you: a row whose agent is simply waiting (`agentStatus` `waiting`, no approval) gets a reply box under it that sends `/v1/prompt` through `sendReply` (`shell/needs-notify.js`). Drafts and the last "Sent" / error stay per session across re-renders, and the block does not redraw while a reply box is focused (it catches up on blur).
- `branch-tasks.js`: `loadBranchTasks(computer, project, branch)` over `GET /v1/projects/:project/tasks?branch=` (null on an older Hook), `completeBranchTask` over `POST …/tasks/complete {id}`, and `renderBranchTasks({ computer, project, branch, state, rerender })`, the card with Done. Shown on Changes › PRs for the current request and in the project page's Code block for the checkout's branch.
- `shell/launch.js`: `openLaunchSheet({ project, computer, role, prompt, title, label, chat })`; `chat: true` is a quick chat (the phren harness with `mode: "chat"`, role, worktree and permission hidden, disabled with a reason when the computer's Hook lacks `quickChat`), opened from a project page's Quick chat and the ⌘K command, the launch sheet over `POST /v1/workspaces/launch`. `prompt` shows an editable First prompt sent as the launch's `brief` (`{id, text}`); Fix it on a failing request (Changes › PRs, the project page's Code block) opens it with `fixItPrompt` from `git-review.js`.
- `shell/usage-rings.js`: `mountUsageRings(el)` over the daemon's `GET /api/usage` (merged across computers with the CLI's `mergeAccountUsage`)). The popover lays accounts out like the phone's Account usage cards: title by email (plus the plan when one email has two), plan line, computers and age, every window with its reset ("not started" for a 5-hour window without one), API credits as dollars with their expiry, and Codex credits. Its text helpers (`accountTitles`, `subscriptionSummary`, `metaLine`, `windowText`, `creditsValue`) are exported for `src/ui-usage.test.ts`.
- `sections/settings.js`: the page list and `mountSettings`; each page is a module in `sections/settings/` (`computers.js`: link and revoke via `POST /api/computers/link|revoke`, health, resources, peers, files; `approvals.js` (read-only standing approval rules per online computer from `GET /v1/approval-rules`; wording in `approval-rule-text.js`, exported for `src/ui-approval-rules.test.ts`; loads when shown, Refresh button, no polling); `keys.js` with the summon row; `appearance.js`; `notifications.js`; `diagnostics.js`; `about.js`), sharing `settings/ui.js` (DOM and request helpers, `toggleRow`) and `settings/prefs.js` (localStorage keys). It re-exports `notifyEnabled()`, `badgeEnabled()`, `ciNotifyEnabled()`, `prNotifyEnabled()` and `stallNotifyEnabled()` from `settings/prefs.js`.
- `sections/projects.js`: the Projects section entry point (`mountProjects`, its only export: state, header, per-computer store reads, routing between grid and page, show/hide/open/destroy). Each feature is a factory in `sections/projects/` over a shared context: `data.js` (pure parsers, knobs YAML, store-tree readers), `grid.js` (project cards), `detail.js` (the page: Summary, Open work, Sessions, Skills, Knobs), `today.js` (the Today block and its midnight rollover), `forge.js` (the Code block, pull request rows, branch tasks), `sheets.js` (modal sheet and form controls) and `dialogs.js` (connect a host, add a project, edit knobs).
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
- `sections/home.js`: Home shell, polling and subscription lifecycle; `sections/home/` owns the conductor, needs-you (replies and keys), finished (away/returns/runs), running-low, working, checks, up-next and computers blocks, with `jobs.js` for heavy jobs and `rows.js` for shared row helpers. Block factories receive their live state and helpers explicitly and keep their own caches. `sections/home.css` is loaded once with `ensureCss`, preserving Home rule order; shared sidebar and Settings rules remain in `theme.css`.
- `sidebar.js`: the sessions sidebar. A compact **filter box** (`.sb-filter` > `.sb-filter-input`, "Filter sessions") sits at the top, above the Status / Computer toggle. Typing keeps the rows whose title, project (folder and label), branch, computer name or harness (`child.agent`, `target.source`) contain every word, case-insensitive, in any order (`shell/sidebar-filter.js`: `filterWords`, `filterText`, `matchesSessionFilter`, `filterSessionRows`, pure, exported for `src/ui-sidebar-filter.test.ts`). It filters the rows before grouping, so Pinned, Needs you, Working, the compact project groups and Computer mode keep their shape (groups and computers left empty disappear; the Computers footer's session counts stay unfiltered). Esc clears it (focus stays; Esc in an empty box blurs it); × clears it too. Nothing matching shows `.sb-nomatch` ("No sessions match") with a Clear button. The text lives in the sidebar's own state: per window, never persisted. `filter_sessions` (default `cmd+shift+e`, [keys.app], "Filter the sessions sidebar" in Settings › Keys and the palette as "Filter Sessions") reveals the sidebar, switches to Agents and focuses the box. In the icon strip (`#sidebar.compact`: the window is under `SIDEBAR_COLLAPSE` = 1440 px or the owner collapsed the sidebar), where the box is hidden, `.sb-strip-filter` (a funnel icon button under the box's slot; title and `aria-label` from `filterButtonLabel()` in `keys.js`: "Filter sessions (⌘⇧E)", "Ctrl+Shift+E" off macOS, following a rebound `filter_sessions`, plain "Filter sessions" when unbound; `aria-pressed` while a filter is active) dispatches `phren:focus-filter`, which `keys.js` handles exactly like the shortcut (`focusFilter`: expand and pin the strip open, focus and select the box; registered before the bindings load). While a filter narrows the rows it carries `.active` (accent colour and a `.sb-strip-dot`), also after the strip is collapsed again; the label stays constant. Hidden when the sidebar is expanded. Tested in `e2e/sidebar-filter.spec.ts` and `e2e/sidebar-strip-filter.spec.ts`.
- `shell/closed-tabs.js`: **Reopen closed chat**. `createClosedStack(limit = CLOSED_LIMIT = 10)` (pure; `push`, `drop`, `size`, `entries`, `reopen(exists)`) keeps the last closed chats of one window, in memory only: `{ key, computer, id, tile?, index?, mode? }` (`closedEntry` normalizes; `tile` is the tile id and `index` the tab position at close). `sections/agents.js` pushes from `createTiles`' `onClose(doc, { tile, index })` (chats only, never during Mirror tab) and `reopenClosedChat()` pops the newest entry that is not already open and still exists in `store.sessions({ includeOffline: true })`, opening it with `tabs.open(doc, { tile, at })`: in its tile at its position when that tile still exists, else last in the focused tile (`at` is dropped with the tile). `reopen(check)` takes a verdict per entry: `ok`, `open` (already open: discarded, never reported as gone), `gone` (discarded; only a computer that is online with its overview loaded can say so) or `unknown` (its computer is not reporting: kept for later, and "That chat's computer is offline" if nothing else reopened). Opening a chat by any route (`onActivate`) drops its entry. When nothing reopens it toasts "That chat is gone" if a closed chat vanished, "That chat's computer is offline" if one waits on its computer, else "No closed chats to reopen". `shell/tabs.js` gained `onClosing(doc, { index })` and `open(doc, { at })`; `shell/tiles.js` gained `onClose(doc, { tile, index })` and `open(doc, { tile, at })`. Agents' handle has `reopenClosedChat()` and `canReopenChat()`. Key `reopen_chat` (default `cmd+shift+o`, [keys.app], "Reopen the last closed chat" in Settings › Keys; ⌘⇧T was already `console`) and the palette command "Reopen closed chat", hidden through `when` while the stack is empty. Terminals, editors and iframes keep the key (`ownsCtrlTab`; Ctrl+Shift+O is Go to Symbol in Monaco). Tested in `src/ui-closed-tabs.test.ts` and `e2e/reopen-chat.spec.ts`.
- `chat.js`: the chat pane; applies preview updates (including clears) on every transcript frame carrying them.
- `chat/composer.js`: owns delivery state for both the pending strip and timeline echoes. `createComposer` takes `submissionCursor()` (the last known transcript line when sending, or `null` until the initial backlog arrives) and returns `applyDelivery({deliveryId,state,reason?})` for pushed receipts, `reconcileTranscript(messages, acknowledgementID?)` for FIFO non-queued user-row matching of pending submissions after their cursor (exact text after whitespace normalization), and `pendingEchoes()` for the timeline. `onDelivery(fn)` notifies state changes, including removals; receipt polling remains the fallback. The optional acknowledgement-ID callback defaults to the row ID; chat supplies `AgentChatHistory.acknowledgementID` so a consumed queue row and its real replacement settle only one submission. The composer retains settlement under both row identities across transcript resets and reconnects. Submissions sent before the initial backlog receive its end cursor when it loads, so its historical rows never settle them. Queued transcript rows and failed submissions never settle deliveries through text matching; only a submission's own late delivered receipt overrides its earlier failure. Delivered receipts reserve their first matching transcript row even after the echo disappears. Removing a send hides its pending strip row and echo but keeps its submission cursor, delivery ID, FIFO reservation and receipt polling; its matching transcript row settles that hidden send rather than a later identical submission. `draftKey(target, computer)` scopes drafts by computer; the target-only key is read for one-time migration when no scoped draft exists.
- `chat/outline.js`: **Prompt outline**. `createOutline({ root, scroll, prompts, reveal, earlier })`, created by `timeline-view.js`, draws `nav.ct-outline` (`aria-label="Prompts"`) along the transcript's right edge, left of its scrollbar (`--ct-sb`): one `button.ct-outline-tick` per LOADED user prompt (`aria-label="Prompt N: <first line>"`). Prompts behind the timeline's fold (`el: null`) are hollow ticks evenly spaced in a compressed top segment (at most 25% of the rail, above a dashed divider); drawn ones follow, placed at their scroll offset over the content height, with `current` + `aria-current` on the prompt in the top quarter of the view. Ticks closer than 10px merge into one standing for a range (`Prompts 12–15`, tooltip and label; clicking jumps to the first); clusters never mix folded and drawn prompts. Hover/focus shows the first line. A folded tick calls `timeline.revealPrompt(id)`: open the fold, scroll to the row and flash it (`ct-outline-flash`, smooth unless `prefers-reduced-motion`; a press during a smooth scroll jumps instantly). While a jump is in flight the timeline is `detached`: renders neither stick to the bottom nor re-anchor, the follow observer and the pane's `isAtBottom`/`scrollToBottom` stand down, and the state clears on `scrollend` (or once the scroll settles at the goal; 3 s cap), a wheel/touch/pointer/key scroll by the reader, or "Jump to latest" (landing at the bottom resumes following). One animation frame after a jump the target is re-measured for late row-height changes. A render that does not stick anchors on the first row in view (by `data-row-id`), so a streamed reply below never drifts a reader who is mid-chat. `↑ earlier` shows only while older history is unloaded (`ctx.hasOlder` / `ctx.loadOlder`, the same loader as scrolling to the top): it awaits the load, then reveals the first newly loaded prompt (never scrolls to 0, which would chain loads). Shown only with >= 3 loaded prompts at a pane >= 520px (`@container chat`), and either folded prompts or drawn content over 2 viewports; never in Console mode. Alt+Up / Alt+Down (focus in the transcript, `.ct-scroll` has `tabindex=-1`; no other binding uses them) jump to the previous/next prompt (Alt+Up from the first drawn prompt reveals the last folded one) and are left alone, not prevented, when there is none that way. Re-placed on render, column/scroll/pane resize, one animation frame at a time; unchanged tick positions are not rewritten. Find's MutationObserver ignores mutations inside `.ct-outline` (`onlyRail` in `find-bar.js`). The pure math (`shouldShow`, `layoutFractions`, `clusterTicks`, `scrollTarget`, `currentPrompt`, `stepPrompt`, `firstLine`, `tickLabel`) is tested in `src/ui-chat-outline.test.ts`; `e2e/outline.spec.ts` uses `longTranscript()` from the fake Hook.
- Copy message (`copyButton` in `chat/timeline-view.js`, styled in `chat/timeline.css`): every settled prompt and agent reply carries a `.ct-copy` button, invisible until its row is hovered or the button has keyboard focus (faint always where `(hover: none)`), that writes that message's own text (a prompt without its `[voice]` marker) to the clipboard and reads "Copied" for 1.2 s. Live reply previews and tool rows have none. `ct-copy` is in find's `SKIP_CLASSES`, so Find in chat never matches the label. Tested in `e2e/copy-message.spec.ts`.
- `chat/prompt-history.js`: the composer's prompt history. `createPromptHistory(list)` walks a chat's sent prompts (newest last, at most 50, blanks and immediate repeats skipped, `pushPrompt`): ArrowUp in an **empty** draft recalls the newest, again goes older, ArrowDown comes forward and ends on the empty box. Typing is never overwritten (a walk only starts from an empty draft and ends once the text is edited), and in a multi-line prompt the keys move the caret until it is on the first (Up) or last (Down) line. The composer ignores the keys while the slash menu is open or a modifier is held, records the text on send, and keeps the list per chat in `phren.composer.history.<same suffix as the draft key>` (`historyKey`). Tested in `src/ui-prompt-history.test.ts` and `e2e/prompt-history.spec.ts`.
- `chat/find.js`, `chat/find-bar.js`, `chat/find-command.js`: **Find in chat, ⌘F / Ctrl+F** (also the palette command "Find in chat"). `chat.js` creates one `createFindBar({ pane, root, before, focusComposer, partial })` per pane and the pane itself owns the key, so ⌘F opens it only while focus is inside a chat pane; the Monaco editor, terminals, Changes and Code keep their own ⌘F, ⇧⌘F still opens Search, and the Electron menu has no Find item. The bar (`.chat-find`: input, `n/m` counter, ↑ ↓, ×) sits above the timeline. Matching is case-insensitive over the text nodes the timeline has drawn (user and assistant prose, tool row titles and summaries, open tool output) and skips chrome (buttons other than tool rows and path buttons, icons, status marks, copy and fold controls, hidden subtrees); a match inside a collapsed tool block opens it when it becomes current. Hits are `<mark class="ct-find-hit">` (`ct-find-current` for the current one); Enter / Shift+Enter step and scroll, Esc (or ×) restores the DOM, clears the marks and focuses the composer. While open, a leading+trailing-throttled (300 ms) MutationObserver on the timeline re-searches and keeps the current hit. The bar says "Searching loaded messages" while turns are behind the fold or older history is unloaded (`timeline.isFolded()`, `history.hasMore`). `find.js` is DOM-light (`createFinder`, `highlight`, `restore`, `textNodes`, `ranges`) and tested on a fake DOM in `src/ui-chat-find.test.ts`; `isFindKey` and `counterText` are exported from `find-bar.js`.
- `chat/markdown-export.js`, `chat/export-command.js`: **Copy / Save chat as Markdown**. The header's `⋯` button opens a small menu (`.chat-menu`: Rename, Copy as Markdown, Save as Markdown…) and the palette has "Copy chat as Markdown" / "Save chat as Markdown…" for the chat pane last used. `chatToMarkdown(messages, meta)` builds the text from the loaded transcript rows (not the DOM): `# <escaped title>`, a `project · computer · harness · date` line, then `**You**` / `**<Agent>**` runs with the message text as written (fenced code keeps its language), tool calls as one-line bullets (`- Ran `cmd` — passed`, `- Edited `path``, outputs omitted) and `[image]`. Before exporting, `chat.js` loads older pages through `/v1/transcripts/history` until none remain or 2,000 rows are loaded (a "Loading earlier messages…" toast shows progress); if rows are still missing the file says `_Earlier messages not included_`. Each raw string (title, message, command) and then the whole text pass through `redactExport` (`redact.js`: the notification redactor without its length cap plus the peer hand-off forms: `mysql -pX`, `curl -u`, `--password x`, Cookie and `*-Key` headers, Slack webhooks, any JWT); redaction comes before escaping or clipping. Code fences a message leaves open are closed, and HTML in a message passes through raw. Closing the pane or Cancel aborts a running export, and a second request says "Already exporting…". Copy uses `navigator.clipboard` and toasts "Copied N messages"; Save downloads `<slug>-<YYYY-MM-DD>.md` through an `<a download>` blob (Electron asks where to save). Tested in `src/ui-chat-markdown.test.ts` and `e2e/chat-markdown.spec.ts`.
- `chat/recall.js`: the composer's recall strip. Once a prompt has three words, a typing pause asks the session's project memory (`GET /v1/projects/:project/memory/search`, 6 results) and shows up to three confident hits (score 0.3 or more) as chips above the editor; a click appends `Phren remembers: <text>` to the prompt, × hides them until the prompt is sent. `recallQuery`, `recallHits` and `withRecall` are exported for `src/ui-recall.test.ts`.

## Exports

```js
// sidebar.js
export function renderSidebar(el, merged, handlers)
//   merged: MergedOverview (src/contract.ts). Re-render fully on every call.
//   handlers.onOpenChat(computerName, child)     // child: OverviewChild with a target
//   handlers.onOpenTerminal(computerName, server) // server: child.target.server or mux.session
//   handlers.onDropFiles(computerName, child, files) // Files dropped on a row: open it, then attach(files).
//     Only chat rows are targets (shell/row-drop.js): a row dragged over with Files gets `.sb-drop` and
//     a floating "Attach to <title>" chip (offline computers are not targets); Escape, dragend, drop or leaving the row clears it.

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
  additions, deletions, totalFiles, files:[{path, status:"M"|"A"|"D"|"R"|"?", staged, additions, deletions, binary}], repository, truncated}`.
  A file staged and also changed again appears twice (staged true and false).
- `POST /v1/diff {target, paths:[]}` → `{files:[{path, status, sections:[{id, kind:"staged"|"unstaged", binary, patch, truncated}]}]}`
  (`patch` is unified diff text; untracked files have no sections; read them whole).
- `POST /v1/git/stage|unstage|discard {target, paths:[...], expectedRepository}`; stage also takes `confirmBulk`, sent only after the inline Stage confirmation.
  Stage all includes collapsed directories. Confirm directories and their contents, binary or uncounted untracked files, and selections over 100 paths; refuse over 500 paths.
  The confirmation lists the count, named directories/binary/unknown files, the first 10 paths and the remaining count, with Stage and Cancel. A Hook staging-gate 409 also opens it.
  `changes/util.js` exports `stagePlan(files, status?) → {paths, directories, binary, unknown, manifest, confirm, error}` for the distinct unstaged selection; confirmation retains that selection and repository. `manifest` records each path's file/dir/binary/deleted type and untracked/counts availability.
  `changes/stage.js` exports `createStaging(state, {scopeBody, repo, render, postStage, readStatus, announce, refresh}) → {stage(files), stageAll(), confirm()}`.
  Stage all refuses a truncated status and reports omitted files. Confirm re-reads status in the saved scope, refuses truncated listings or a changed repository, and reopens review if membership or types changed. Single-file Stage remains available during another confirmation.
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

## Account quota warnings

`shell/quota-warn.js` is pure: `quotaPreferences(value)` validates the enabled
flag and 50–99 percent threshold (default 90), plus the independent default-on
`backOn` recovery notification flag; `quotaSessionKey(session)` keys
computer/harness/conversation; `sessionUsage(session, accounts)` matches the
session's exact local account; `quotaWindows(row, now)` settles 5-hour and weekly
windows; `quotaWarnings(session, row, { preferences, suppressed, seen, now })`
returns notices and their tokens without consuming them; `quotaDestinations`
ranks the move inventory by remaining room, excluding the current login.

`shell/quota-warn-prefs.js` exports `quotaSettings`, `saveQuotaSettings`,
`quotaSuppressed`, `suppressQuotaChat`, `quotaSeen`, `markQuotaSeen`,
`unmarkQuotaSeen` and `loadQuotaState`. Call `loadQuotaState()` before decisions
or edits; mutation functions return promises. Settings › Notifications waits
for hydration and reports read/write failures. State is stored by the daemon,
independently of its HTTP port: authenticated `GET /api/settings/quota-warning`
returns `{ settings: { on, threshold, backOn }, suppressed: string[], seen: string[] }`;
`POST` merges `{ settings?, suppress?, markSeen?, unmarkSeen? }`. The daemon
serializes merges and atomically writes `$XDG_CONFIG_HOME/phren/desktop-quota.json`
(default `~/.config/phren/desktop-quota.json`, mode 0600). Both client and daemon
retain the newest 512 distinct seen tokens. Opt-outs persist per session ID.
A session/window/reset gets one threshold notice and one exhaustion notice;
percentage corrections do not rearm it. First observing an already-high window
counts as its crossing. Missing, stale, ambiguous or reset usage is skipped.

`shell/quota-warn-sheet.js` exports `watchQuotaWarnings(currentSession)` returning
`{ check, close }`, mounted once by Agents. It follows overview changes, active
chat/section changes and `usage-rings.js`'s `followUsage(fn)` (immediate latest
snapshot, then each successful shared minute poll; returns unsubscribe). The
passive card leaves chat interactive and focus untouched. `openChat` exposes
`quotaHost`, a bounded flex-layout slot between interactions and the composer;
Agents supplies it as `currentSession().quotaHost`. The card mounts there,
never on `document.body`, and reduces transcript space without overlaying the
composer at narrow or desktop widths. Console mode suppresses the card. Switch opens
`openMoveSheet({ computer, child, to?: { harness, account }, notice?, selectDefault?: boolean })` with the
best destination selected from usage at click time; exhausted or unknown-room
destinations are never preselected. When none has known room, the hand-off opens
with `selectDefault: false` and explains why; Continue stays disabled until a
destination is chosen. Exhaustion on either window replaces
an open threshold notice; the sheet refreshes percentages and account room on
usage updates. The user confirms the hand-off in Continue in.

`openChat` accepts `opts.onInteractions(pending)` and reports the existing
status stream's approval/question/password cards (initially pending until the
first status). Agents carries this as `currentSession().interactionsPending`;
overview `child.approvalPending` is an additional guard. `quotaInteractionPending`
in the pure module shares the card status predicate. Pending interactions prevent
opening; arriving interactions close the sheet and remove its seen token so it
can reopen after the card clears. No extra status socket is opened.
`moveChoices(inventory, current, currentAccount?)` allows the same Claude
harness when another usable account exists; `moveAccounts(inventory,
{ includeDefault?: boolean })` includes the default when requested.

No Hook additions: `workspacesReader` in `server-routes.ts` assigns
`paneAccountField` to `groups[].children[].account` (`{ id, label, key }`) and
`target.source`/`target.session` identify the harness/conversation. The desktop
OverviewHub forwards those rows unchanged. `/api/usage` (`src/usage.ts`) merges
Hook `/v1/usage?accounts=all` reports into accounts whose `harness` and
`computers[].{name,account}` match that session's computer and Claude account ID;
`windows[]` supplies `usedPercent`/`leftPercent`, `resetsAt`, `exhausted` and
`limited`. Claude sessions without an account reference are skipped. Other
harnesses require exactly one account row on the session's computer. The quota
on dispatch `live_sessions` rows is a separate surface and is not needed here.


### Switch destinations and hand-off chats

`quotaDestinationText(destination, now)` describes each destination's `limiting`
window (tightest active window): percent left, window name, and its reset in
local time (relative under 24 hours, weekday/time thereafter). Missing resets
and exhausted accounts are explicit. The card's Switch target and the Continue
in sheet share `shell/handoff.js`'s pure `movePlan(currentHarness, to,
moveNewChat)` decision and outcome label. Same-family account moves continue in
place. Cross-family moves send `mode: "new-chat"` to the existing
`POST /v1/sessions/move` only when `store.capabilities(computer).moveNewChat`
is true. Older Hooks keep the in-place route and the label explicitly says
"Replaces this chat … (update the Hook for a new chat)". Capability is read again
when confirming a move. The move sheet polls the existing GET route; after a
new-chat move reaches `moved`, it waits for `move.target` in the overview and
opens that chat without closing the original tab.

`shell/handoff.js` also exports `sameChatTarget(a, b)` and
`handoffNotices(child, rows)` for the Hook's optional `handedOffTo` /
`handedOffFrom` references (`{ target, harness?, title? }`, or a target directly).
`shell/handoff-view.js` exports `renderHandoffLinks(container, computer, child)`
and `openHandoffChat(computer, target)`. The latter matches the full target in
that computer's cached overview, opens it in Agents, and returns false while
it is absent. Both sidebar styles and the chat header show "handed off to
<harness>" / "handed off from <title>"; a reference with a target is a button
opening that chat. `openChat.updateOverview(child)` refreshes these labels as
live overview rows change. No Hook fields or routes are added by the desktop.

`shell/usage-windows.js` owns pure `exhausted(windowOrAccount)`, `limitingWindow(account, now?)`,
`leftPercent`, `usedPercent`, `activeWindow`, `compareUsage`, `windowNames`, `resetLabel` and
`windowText` (moved from `usage-rings.js`; `quotaWindows` was removed from `quota-warn.js`).
Limiting windows skip resets/unknown usage and elapsed dates with `now`, retaining first ties.
Reset labels ceil minutes below 24 hours, omit zero components, then use local weekday/time;
credit expiry stays separate. Shared coverage: `src/ui-usage-windows.test.ts`.

### Account room notifications

`shell/quota-back.js` exports pure `quotaBackTransitions(state, snapshot, now?)`
returning `{ state, notices }` (initial state may be undefined), and
`startQuotaBack({ notify, enabled })` returning unsubscribe. Started once by
`app.js`, it follows the shared usage poll without extra requests. Each
computer/harness/account establishes a silent baseline; only an observed
exhausted → available transition emits a notice, after every exhausted window
has cleared. Stale reports retain the last known exhausted windows and their
reset times, so later fresh room still emits a recovery. Missing or unknown
reports clear the baseline; explicit `reset` windows remain known room even
when the merger flags them stale. Only `exhausted: true`, or `usedPercent >= 100`
when that flag is absent, establishes exhaustion; rounded `leftPercent` never
does. Cooldowns suppress repeated transitions for ten minutes; each poll drops
expired entries and keys for computers/accounts absent from the snapshot.
Disabled settings, quiet hours and unhydrated preferences consume transitions
silently. Settings › Notifications exposes the independent
“Notify when an account has room again” toggle using the existing daemon quota
settings route and file (`settings.backOn`, default true for older files).
Notifications name the account, computer and window; their keyless shell click
focuses the desktop and leaves its current chat and section in place. Covered
by `src/ui-quota-back.test.ts`.
### Account usage overview

Rings show the limiting window. An exhausted window draws a full danger-coloured
ring labeled "Exhausted" with that window’s reset, regardless of its reported percentage.

`shell/usage-rings.js` exports `openUsage()`, which opens the existing titlebar
usage popover even without account rings. Both the `usage` app action
(Cmd/Ctrl+Alt+U; Ctrl+Shift+U is reserved for Linux Unicode input) and
“Show account usage” in the palette call it. Escape closes the dialog and
returns focus; the palette restores its invoking focus before running a command.
`sortUsageAccounts(accounts)` returns a sorted copy: exhausted accounts first,
then the highest active window percentage, unknown usage last, ties in report
order. Reset windows do not constrain the order. The overview retains merged
account cards with harness names, all reporting computers, every window,
reset times, exhaustion, missing data and unreachable computers. Within each
card, windows use the same exhausted-first, highest-percent ordering; reset
and unknown windows follow active known usage, with stable ties. Off macOS,
Ctrl+Alt bindings match the reported character without physical-key fallback;
Ctrl+Alt letters pass through editable fields, terminals and the editor.
AltGraph events are ignored by key matching and dispatch on every platform.

The usage popover uses viewport-fixed positioning, clamped to 16 px horizontal
gutters and at most the viewport width minus 32 px. Below 600 px it fills that
width; account names, window names and values wrap. Ring clicks retain the
ring group's right anchor and normal 320 px size on wide windows. Keyboard
and palette opens have no anchor and center under the titlebar. Positioning
refreshes on resize and usage renders; closing removes the resize listener.

### Home running low

`shell/home-usage.js` exports pure `runningLow(overview, usage, preferences, now)`:
open online chats matched by `sessionUsage`, at the configured threshold or
exhausted, ordered exhausted first then by usage with stable ties. Stale,
ambiguous, reset, expired and unknown windows are omitted. This live inventory
is independent of notification enablement, seen tokens and chat opt-outs.
Home follows the shared usage feed while visible and hydrates quota settings
before rendering. Chat and Switch are separate keyboard buttons; overview and
usage refreshes retain focus by session and action. `openQuotaSwitch` in
`quota-warn-sheet.js` shares the warning card's destination selection and
`openMoveSheet` flow, including cross-family new-chat capability handling.

The shared move sheet focuses its first enabled control before loading inventory,
traps Tab and programmatic focus inside the dialog, and closes with Escape from
any control. Closing removes its listeners and returns focus to the invoker;
`openMoveSheet` and `openQuotaSwitch` accept an optional `returnFocus` callback
for callers whose controls can be replaced. Home resolves its current Switch
button by session key on close and suspends its keyboard shortcuts while any
sheet backdrop, visible dialog role or open native dialog is present.
### Project git host Connect

Projects' Code block lives in `sections/projects/forge.js`. When its project git
read reports `available: false`, `reason: "auth"` for GitLab or gitboy, it shows
Connect only when `store.capabilities(computer).projectHostToken` is true.
The project sheet shows the displayed host domain and “Sends the token to <api host>”, links to the same token page
as Changes and accepts a password field, clearing it on submission or close.
`project-host-token.js` exports `projectHostTokenRequest(project, host, token)`,
`connectProjectHost(computer, project, host, token)` and `hostTokenError(error)`.
Connect posts `{ token, expectedHost: host.apiHost ?? host.domain }` to
`/v1/projects/:project/git/host-token` on the selected computer, without a pane.
Success refreshes the Code block; `host-changed` says "The project's remote
changed. Reopen to review the new host." and disables retry in that sheet.
The Hook uses the GET route's checkout lookup, refuses `409 host-changed`
before token use, and returns `404 no-checkout` when no checkout exists.
Changes' existing Connect captures a copy of the host on its rendered card and
sends that card's API destination as `expectedHost` to
`/v1/git/host-token`. Unit coverage: `src/ui-project-host-token.test.ts`.

The Hook returns `host.apiHost` in project git info, pane git status and pull
lists, resolved from the global API override (including port) or the default
API address. The Hook pins the checked endpoint through validation. A Changes
refresh awaiting status cannot replace the destination attached to the still
visible card's submit handler. Coverage: `src/ui-changes-connect.test.ts`.

### Session list hand-offs

`handoffRow(child, rows)` in `shell/handoff.js` derives row dimming, the
“Handed off to <title>” subtitle and “→ <harness>” / “← from <title>” tags.
Callers supply rows from the same computer; current overview titles take
precedence over saved reference titles. Tags link only to exact targets still
present in that overview. Sidebar reconciliation includes the resolved decoration
so target renames and removals refresh existing rows without reordering them.
`renderHandoffRow` shares tag rendering; `decorateHomeHandoff` keeps Home's
chat and tag buttons separate inside a full-width row for Working, Needs you
and Finished sessions. Tags follow the subtitle in the shared metadata line;
destination subtitles wrap to at most two lines. Rendering is covered by
`src/ui-handoff-view.test.ts`.

Sidebar Enter/Space navigation leaves nested buttons, links and inputs their
native activation, including hand-off tags. Enter on the row itself still opens
that chat. Covered by `src/ui-keys.test.ts`.

## Citation freshness

Finding items may include `citationFreshness: { state: "current" | "changed" |
"unknown", checkedAt: string, head?: string, lastCommit?: { sha: string,
summary: string, authoredAt: string } | null }`. Dates are ISO UTC. The field is
omitted when never checked or not checkable; `unknown` means gitboy could not
answer. This additive field does not change a finding's lifecycle status.

`citation-freshness.js` exports `freshnessNote(item)` → `{ label, detail } | null`
and `freshnessChip(item, className)`, using `dom.js`. Only `changed` shows the
warning chip “May be out of date” in Memory beside the lifecycle chip and in
chat recall. Its title is `<file> changed in <sha7> “<summary>” (<date>)`, with
the file from `citationData` or the raw `phren:cite` comment and a short UTC date
such as `Oct 14`. Without `lastCommit`, it reads `<file> changed since this was
written`. Current, unknown and missing fields are silent. Chip rows wrap on
narrow windows. `isStale(item)` and `staleCount(items)` back the Memory
Findings chip “May be out of date (N)” (`aria-pressed`, shown only when N > 0,
combined with the type chips and search, cleared on project change); it uses the
loaded findings and makes no request. Covered by `src/ui-citation-freshness.test.ts` and the desktop
Memory browser smoke test.

Memory's rail has a **Sync now** button (`store-sync.js`, `createSyncControl`;
"Sync primary store" when the computer has several stores; disabled with the
title "Computer offline" when none is online). It reads `GET /v1/tasks/stores`
for the primary store's `{storeId, repository, branch}` and POSTs
`/v1/store/pull-now`, which only queues the pull and reports no outcome. The
line reads "Sync requested", then the desktop reads `GET /v1/store/head` at 2, 4,
8, 16 and 15 s (a failed read is skipped): a changed head says "Memory updated"
and reloads Memory; otherwise "Sync requested — no new changes so far". Only the
POST failing shows an error. Repeat clicks wait 10 s. **Results are approximate
until the Hook reports pull outcomes**: the head is a working-tree snapshot, so a
local edit also counts, and a late pull is missed; the desktop never says "Up to
date" or counts changes. Tested in `src/ui-store-sync.test.ts` and
`e2e/sync-now.spec.ts`.

Home’s Computers block reads `computer.resources.heavy` from the shared overview
store, as Settings › Computers does, with no extra Hook requests. Jobs sort by
CPU descending, show at most three plus “+N more”, and hide when empty or the
computer is offline. A disconnect clears observation times, and each reading
removes jobs absent from it. Each shows its name, CPU percentage (100% is one
core) and “seen 5m” for time observed continuously by this mounted Home (the Hook
does not provide process start time). The tooltip explains the duration.
Computer and PID keyed job rows preserve focus through polls and reordering.
Hook update controls stay mounted while resource readings change. A pane matched
by computer, server and pane ID opens its current session with Home’s
`openSession`. Resource workspace labels differ from session workspace IDs.
Unmatched panes and jobs without panes are plain text with an explanatory
tooltip. Long names truncate, with full names on hover, and computer metadata
wraps on narrow screens. Covered by `src/ui-home-jobs.test.ts`.

### Home Active tasks

`sections/home/active-tasks.js` renders after Up next and hides when empty. It shows unchecked Active tasks across every available store and project on online computers, newest `createdAt` first (undated tasks last), capped at six. Keyed rows retain Launch controls and focus across polls. Each row truncates its text, project and computer; Launch opens `shell/launch.js`'s `openLaunchSheet` with the task line as the brief preview and its project, computer, store ID, stable task ID and document revision. Task sheets keep the project and computer fixed, show only task-supported harnesses, and submit to `/v1/tasks/launch`, which resolves the selected store’s checkout and generates the task brief; generic sheets retain their editable brief and project launch flow. `+N more` opens Tasks and calls its `filterSection("Active")` handle; Show all tasks clears that filter.

`shell/task-cache.js` shares store discovery and per-computer/store/project task reads between Home and Tasks, including in-flight requests, for 60 seconds from request start (in-flight requests are still shared). Home reads on show and every 60 seconds while visible, dropping offline rows immediately; hide/destroy stops its timer and ignores late answers. Tasks writes update the shared document cache; conflict/deletion reloads force a fresh read. Tasks retains its existing per-store/project navigation under the Active filter.


### Project page Today

`shell/project-today.js` (`todayGroups`, `TODAY_ROWS`) groups what a project did on the local day for the `Today` block at the top of its page (`sections/projects/today.js`): chats (the page's own session rows whose `lastChangedAt` is today, each opening the chat in Agents), pull requests (the git host data the Code block already loaded: the checkout's `current` request and the open list, counted when `updated` is today, with a Merged pill when `state` says so; the host reports no opened/merged instant) and memory (the project's findings through `savedToday`, so the UTC-date handling and dedupe are Home's). Findings come from `loadFindings` in `sections/home/saved-today.js`, the same five-minute cache Home uses, so a project page view costs at most one `GET /v1/projects/:project/memory` (none while cached) and no per-request pull reads. Five rows per group; `Show all N` expands; empty groups are hidden and the whole block is hidden when nothing happened today. A finding opens Memory through `openSaved`.

### Home Saved today

`sections/home/saved-today.js` renders after Active tasks and hides when nothing was saved today (or shows "Couldn't read what was saved today." when every read failed). Tasks are the Active and Queue items whose `createdAt` falls inside the local day, from the shared task cache. Findings come from `GET /v1/projects/:project/memory`, read once per store and project from the preferred computer ("This computer" first), kept five minutes, at most two in flight per computer, one burst at a time; they are fetched when Home is shown (stale or missing) or when a computer first comes online (missing only, debounced), never on a timer. The Hook writes a finding's `created` as a UTC date, so `shell/saved-today.js` counts a finding as today when its date is one of the one or two UTC dates the local day spans (`utcDatesOfDay`); findings have no time of day and read "today" after the timed tasks. Items seen from several computers collapse by store, project and id. Eight rows show; `Show all N` expands; the day rolls over at local midnight. A finding opens Memory with the project selected and its text filter (`memorySearchFor`, Memory has no id target); a task opens Tasks through `openTask`, which also lands on the row after a cold store load. Exported for `src/ui-saved-today.test.ts`.
### Home Working stop

`sections/home/working.js` owns keyed online working rows with separate chat and
Stop buttons. Stop is a square icon at the end, titled and named `Stop <session
title>`, and calls `shell/pause-all.js`'s `liveStop` (Escape to that row's target).
Clicks stop propagation. The control stays focusable while busy, ignores repeat
activation until an overview leaves working or five seconds pass, and reports
failures inline for four seconds. Polls retain Stop and
restore chat focus when metadata or row order changes. Idle and offline sessions
have no Stop control. Home's existing approval keyboard shortcuts are unchanged.

### Palette memory across projects

With no project scope, `?` searches every online computer; `??` always does so.
The Projects handle's `projects()` supplies computer, name and `lastSeen` from
its existing repo/store discovery. The newest 12 computer/project pairs are
searched, with at most four `/v1/projects/:project/memory/search` reads in flight.
An AbortController cancels reads on a new query, mode change or close; stale
answers cannot paint. The palette shares its four pending reads across queries;
the daemon holds four memory-search slots until the Hook request settles,
including SSH teardown after a browser disconnect. The proxy forwards a per-request
AbortSignal on an incomplete request close or response close before finish.
Results merge by distinct query tokens `matched` descending, then Hook score,
then project `lastSeen` recency, capped at 20.
Each row labels project and computer and opens that exact Memory destination.
A capped search shows “Searched N of M projects” (N successful reads); failures
are reported without dropping successful results. Scoped `?` retains its quick
chat action. Palette input retains focus while asynchronous results arrive.
Coverage: `src/ui-palette-memory.test.ts`.

### Continue by account across computers

The shared `shell/move.js` sheet (also opened by quota Switch through
`quota-warn-sheet.js`) reads the session computer's health capabilities via
`store.capabilities(computer)`. With `moveToComputer`, it requests
`GET /v1/sessions/move/computers?project=<registered project>` from that Hook.
It prefers the session's reported `child.project`; otherwise it reads
`/v1/projects/repos` and chooses the longest registered `directory` ancestor
of `child.cwd`, matching complete path segments. Its optional `project` field
is the registered name; `name` is only the checkout basename. If `project` is
absent, canonical names from `/v1/tasks/stores` are matched to that checkout
through `/v1/projects/locate` (four reads at a time). A session in `project/src`
uses the registered project's name, never `src`. An unresolved project shows
an error and preserves local moves; it never guesses from the basename.

The answer is `{ computers: [{ name, self, online, hasCheckout, harnesses:
[{ source, usable, accounts?: [{ id, label, email?, plan?, fiveHourLeft?,
weekLeft?, fiveHourResetsAt?, weekResetsAt?, usable, current }] }] }],
localClaudeLogins }`. “Claude accounts” comes first, with one button per login
including self: email (or label), plan, computer, `5h N% · week N%` and each
known reset. Unknown usage reads “unknown”. The current login is marked
“Current account” and disabled. Offline computers, absent checkouts and
unusable logins remain visible with disabled reasons. “Other harnesses” follows
with local and peer destinations. This sheet has no model or effort pickers.
Account rows retain their nodes through selection and busy/error updates.
Arrow keys and Tab reach enabled rows within the focus trap; Escape closes and
returns focus to the invoker. Continue waits for account discovery to finish.
Older Hooks retain their existing local harness/account choices.

Choosing a self account posts a local move with `to: { harness: "claude",
account }`; peer accounts also include `to.computer` and `mode: "new-chat"`.
Conductor peer rows require the session Hook's `moveConductorToComputer`,
otherwise show “Update <computer>'s Hook to move the conductor”. Submission
rechecks the source capabilities. The Hook owns the hand-off and role transfer.
Status polls the source Hook; `handedOffTo: { computer, target }` opens the
peer chat once present in the overview (falling back to the selected computer
and `move.target`). Peer 404/409 errors remain visible and permit retry.

The exact single-login hint remains when `localClaudeLogins <= 1`, with its
copyable `phren bridge accounts add <name>` command. It additionally offers
“Add a Claude account on <computer>…” when that computer's own health declares
`claudeAccountAdd`. The local action is available independently of
`moveToComputer`; online peers get their own health-gated actions. The action
opens an inline slug form within the same focus trap. Slugs are 1–32 lowercase
letters or digits with internal hyphens; `default` is reserved. Cancel restores
the action's focus; launch errors stay editable. Submit rechecks that Hook's
capability, posts `/v1/accounts/claude/add { slug }`, closes the sheet on success,
and opens the returned live pane immediately through Agents' `openPane(computer,
target)`. Both muxes use the known-pane console tile and carry the returned
server and pane through `/pty`. For local tmux, the bridge resolves that pane's
actual session/window/pane IDs, attaches that session and selects its window
and pane on the returned server's socket, never using an untargeted attach. Remote
panes use the Hook's existing SSH pane attachment path. Interactive login opens
without waiting for a transcript or overview session. The Hook runs the login command; the client never builds shell commands.
Coverage: `src/ui-move.test.ts`.

The move inventory's `computerId` is the stable Hook identity, not its verified
peer name. The sheet resolves it to a configured desktop computer from that
computer's overview identity or `/v1/health computer.id`; it falls back to a
matching name only when an ID is absent. Conflicting or unlinked identities
never receive desktop reads or login requests. Their add/open actions are
disabled with a link-in-desktop reason; the source Hook can still move there.
Move requests keep the Hook peer name in `to.computer`; account addition,
capabilities and opening the returned pane or landed chat use the mapped
desktop alias, including `handedOffTo.computer` resolution.

After a confirmed move, the sheet checks the shared overview for up to 30
seconds without further move-status reads. If the chat never appears, it shows
“Moved to <computer> — open it from there” and releases its controls. An
in-flight account-add blocks Escape, Close and replacement sheets until its
pane opens or its error returns; failed adds refocus the editable slug field.
The single local add action moves into the single-login hint instead of being
duplicated. Its `.move-add-account` class wraps long names within narrow sheets
with automatic height and a 34 px minimum.

A missing, unusable or partial `self` inventory is supplemented with the local
harness inventory, retaining local Claude accounts and other harnesses. When
`current` is absent, the session's Claude account ID is also excluded. Local
tmux login attachment uses `attach-session -t <session>` followed by explicit
`select-window` and `select-pane` commands in the same tmux queue. Regression
coverage lives in `src/ui-move.test.ts` and `src/pty-bridge.test.ts`.

Continue account rows put identity above a single compact usage line, such as
`5h 62% · week 80% · resets 6 PM`. The reset is the tightest remaining window
with a known future reset. `usage-windows.js`'s `resetLabel` accepts an optional
third argument `{ clock: true }`: local clock time today, weekday and clock on
later days, omitting zero minutes. Existing warning callers keep their relative
reset wording. Raw timestamps are never rendered in the sheet.

The move body uses normal block flow within a shrinking scrollport, with margins
between fields instead of compressible grid tracks. The header and footer remain
outside that scrollport; the sheet is bounded by the dynamic viewport minus its
backdrop padding. At scroll end the complete single-login hint and its unique,
full-width add action stay above the footer. The account usage line never wraps;
long identity text can wrap independently.
