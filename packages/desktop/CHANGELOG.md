# Phren desktop changelog

Phren desktop versions on its own (`packages/desktop/package.json`). The
Release desktop app workflow publishes a version's section here as its
GitHub release notes, and the app shows them when that version is available.

## Unreleased

### New

- **Copy session id** in a chat's menu copies the agent's own session id, for resuming it elsewhere.
- Home shows when it last loaded ("Updated 12s ago") and has a **Refresh** button that reads everything again; a failed refresh keeps what's shown and says so.
- **Prompt history** in the chat composer: ArrowUp in an empty box brings back the last prompt you sent in that chat, again for older ones, and ArrowDown comes forward to an empty box.

### Fixed

- Project cards say "1 open task" and "1 finding" instead of "1 open tasks".

## [0.1.12] - 2026-10-17

### New

- **Pull requests on Home**: every open pull or merge request across your projects, the ones that need you first.
- **Find in chat**: Cmd/Ctrl+F searches the open conversation and steps through matches.
- **Switch between recent chats with Ctrl+Tab**: hold Ctrl to see your last eight chats and their status.
- **Snooze** a chat that's waiting on you from Home; it comes back when the time's up or something new happens.
- **Saved today on Home**: what you and your agents saved to memory or tasks today, across projects and computers.
- Notifications when a pull request you're working on gets changes requested, is approved, or hits conflicts.
- **Today on each project page**: the project's chats, pull requests and memory from today in one place.
- **Prompt outline** in long chats: a rail of your prompts to jump between them (Alt+↑/↓).
- Chats open instantly when you rest the pointer on them in the sidebar first: Phren loads the conversation ahead of the click.
- **Copy or save a chat as Markdown** from its menu, with credentials removed.
- The command palette remembers what you use: recent picks show first, and frequent ones rank higher.
- Chats say when they've lost their computer and are reconnecting, with Retry when it takes a while.
- **Sync now** asks a computer to pull its Phren store and refreshes Memory when the store changes.
- Memory can show only findings that may be out of date, so you can review what changed under them.
- Settings › Computers shows whether each computer can reach its linked computers.
- Settings shows each computer's standing approval rules.
- Dragging files over a chat in the sidebar now says which chat they'll attach to, and tab drags no longer look like file drops.

### Changed

- Times like "5m ago" read the same everywhere in the app.

### Fixed

- Settings fits narrow windows.
- Chats fit narrow windows: the title, send button and pane actions stay visible, and the Changes panel opens on demand.
- Web previews and terminals share each computer's SSH connection limit with chats instead of overrunning it. Terminals and previews hold at most half of a computer's channels, so chats always have room; a waiting terminal says so, a preview with no channel answers 503, and idle preview connections close after a minute.

## [0.1.11] - 2026-10-16

### New

- **Continue on another computer, by Claude account.** Continue in… lists every Claude login on this and linked computers with email, plan, 5-hour and weekly remaining and reset time, then the other agents. Pick one to open the chat there with a hand-off. Conductor chats move with their role (needs Phren Hook 0.3.54).
- **Add a Claude account** from the same sheet: it opens a sign-in pane on that computer for you to log in, and computers with a single login show the `phren bridge accounts add <name>` command to copy.
- **Search memory across projects** from the command palette with `??` (or `?` without a project scope), with ranked, labelled results.
- **Run now from Home's Up next**, with inline confirmation, launch status and errors.

### Fixed

- Home's Working rows no longer show blank activity lines.

## [0.1.10] - 2026-10-16

### New

- **Home shows what's next and what's running.** Up next lists the scheduled prompts due in the next 12 hours on every online computer. Active tasks shows the six newest open tasks across projects, each with Launch. Each computer lists its busiest jobs (builds, simulators, workers), and clicking one opens the chat that started it. Working rows get a Stop button that stops an agent without opening it.
- **Running low and Switch.** Home shows chats at your usage-warning threshold, most constrained first, with Switch into another account or harness. The warning now also appears on computers with a single Claude login, including weekly limits. A native notification says when an exhausted account has room again (Settings › Notifications).
- **Account usage overview.** Open it with Cmd/Ctrl+Alt+U or "Show account usage" in the command palette; accounts and windows list the most constrained first, exhausted windows draw a full red ring, and reset times read the same everywhere.
- **Hand-offs in session lists.** Original chats name their destination with a tag that opens it, new chats name their source, and Home's Finished feed includes hand-offs and accounts that got room back while you were away.
- **Citation freshness.** Memory and chat recall mark findings whose cited file changed on gitboy since they were written as "May be out of date".
- **Connect a GitLab or gitboy token from a project's Code block**, with the destination host shown and confirmed before anything is sent.

### Improved

- The titlebar fits windows from 360 px: section icons, compact counts and navigation that scrolls within the bar; wide windows keep their labels.
- Sheets keep keyboard focus inside, close with Escape and return focus; Home rows keep focus across polls; Home approval shortcuts pause while a dialog is open.
- Account usage fits narrow windows; AltGr character input works in fields, terminals and the editor.

### Fixed

- Task launches from Home keep their store and computer, so same-named projects open the right checkout.
- Home job links, offline computers and usage switch destinations (the current login is never offered).
- Quota recovery notifications through stale reports and rounded 0% values.

## [0.1.9] - 2026-10-15

- When the account a chat runs on nears its usage limit (90% of the 5-hour or weekly window by default; Settings › Notifications), a card above the composer shows the usage, when it resets and how much the other accounts and harnesses have left, with Switch, Not now and Don't ask again for this chat. Switching to another Claude account continues the chat in place; switching to Codex, OpenCode or Copilot opens a new chat with a hand-off (Hook 0.3.48), and the two chats link to each other. Settings and opt-outs persist across launches.
- Narrow schedule editors wrap conflict notices and timing controls inside the scrolling body; unchanged schedule refreshes preserve list buttons and focus.
- Schedule edits and Pause/Resume use the Hook's merge route when supported, preserving newer fields and showing the latest version after a conflict; removed schedules close the editor and validation errors stay on the form.
- Settings › Computers shows each Hook's git writes without a repository check, counted by client since the Hook started, and identifies Hooks too old to report. Reads refresh when the page opens.
- Leaving Settings › Computers cancels pending health reads; reopening starts fresh without waiting for an old request to time out.
- Narrow Computers cards put their buttons below the text and give git-write diagnostics the full row, keeping versions and actions from overlapping.

## [0.1.8] - 2026-10-14

- Cmd/Ctrl+1–9 open the titlebar's sections, as advertised; Open session 1–9 has no default shortcut now (sessions keep prefix+1–9, and `session_N` can still be bound).
- On Linux and Windows the Herdr prefix (Ctrl+B) works: the sidebar shortcut on the same key no longer swallows it, and the key after the prefix always goes to the prefix chord.
- Schedule saves hold the schedules.yaml lock (shared with `phren schedule`) across read, check and write, so two saves at once keep both edits.
- Removing a remote computer's last note of a day deletes that file on the computer too, compare-and-swapping on its sha.
- Deleting a file in this computer's store takes the store writers' lock across the sha check and the delete.
- Turning Node extensions off while the extension host is still unpacking cancels its start.
- A daemon that never reports ready is stopped and reaped instead of left running.
- A bad WebSocket frame (a terminal paste over the size limit) closes that socket instead of crashing the daemon.
- Push-to-talk shows its failure toast when the Hook refuses the message.
- A send whose answer was lost (502, timeout) is retried under its own delivery id instead of failing and coming back as a draft, and attachments upload once across retries. If it still gets no answer, it stays as Unknown, keeps asking the Hook for its state, and offers Retry under the same id.
- Responses proxied from a Hook are served with `nosniff` and a sandbox CSP, so repository files never run as a page on the app origin.

- Removing a pending chat send hides it while keeping its place, so its transcript row cannot settle a later identical send or hide that send's failure.
- Released Claude questions and served OpenCode questions appear as answer cards in chat.
- Answering a pending question from a chat card works for Claude and OpenCode as well as Codex.
- Stage all refuses truncated listings, staging confirmations recheck file membership and types, and single-file Stage works while another confirmation is open.
- Changes asks before staging folders, binary or unknown untracked files, or more than 100 paths, and keeps checks in the Hook’s order.
- Notifications retain approval history across reconnects, open cached offline sessions, bind replies to the original conversation, and redact credentials.
- Offline sessions no longer count as live attention; replacement approvals notify again, sidebar error and unknown states stay visible, and Review and Conductor share return labels.
- SSH masters verify their own atomically written host pin and authenticate only with the desktop private key, never an inherited SSH agent.
- SSH master sockets cover the full host pin and current private key with 96-bit isolation; replaced connections cannot overwrite the new computer's overview or capabilities.
- Replacing a connection discards pending handshakes; relinking after key rotation closes the original SSH masters and refreshes the overview.
- Connections follow the configured Hook server, refresh capabilities on heartbeats, time out while waiting for a channel, and verify changed SSH keys and host pins on relink.
- Chat excludes the initial backlog from early sends and settles identical pending sends in order, keeping failed sends failed until their own delivered receipt arrives.
- Reconnecting chat keeps settled queue and transcript rows from settling another identical pending prompt or stopping its delivery polling.
- Consuming a queued prompt and then receiving its real transcript row settles only that submission, keeping repeated prompts pending.
- Queued transcript rows keep chat deliveries pending until consumed, late delivered receipts clear earlier failures, and transcript confirmation tolerates whitespace changes.
- Chat keeps repeated prompts pending until their own delivery settles, clears finished reply previews, and saves drafts separately for each computer.
- Home stops reading in the background when you're not on it; the menu bar keeps its approvals without it.

## [0.1.7] - 2026-10-14

- Home has one Finished block, right after Needs you: what ended while you were away comes first (with Dismiss), then recent worker returns and scheduled runs. It replaces Since you left and Recent returns.
- On macOS, Node extensions run in a sandbox that keeps them away from this desktop's key, its SSH connections and the Hook; everywhere, they start without the desktop's secrets in their environment.
- Home reads once at startup instead of twice.
- Settings › About shows the desktop and each computer's Hook version, with Copy for a bug report (computers numbered, not named).
- Drop an image on a session in the Agents sidebar to open it with the image attached to its next prompt.
- A new version shows as a chip in the titlebar with What's new, and Download or Restart to update.
- Home's Computers rows show each Hook's version; one behind the newest gets its update command to copy.
- A session waiting on you shows what the agent said last in the Agents sidebar.
- ⌘K lists the projects on every computer and opens one's page.
- A working session with no output for five minutes reads "stalled" on Home and in the sidebar, with a notification; one working only on background tasks says how many.
- Allow or Deny an approval from the menu bar icon's menu, or start a new agent from it.
- What finished while you were away also lists the pull requests whose checks passed or failed.
- Settings › Notifications is grouped (what notifies, quiet hours, where the needs-you count shows), with quiet hours and a separate switch for stalled-agent notifications.
- Continue a session in another agent (Codex, Claude on another account, OpenCode, Copilot) from its sidebar menu or ⌘K: it writes a hand-off and the new agent picks up in the same folder.
- Relinking a computer you removed works without restarting the desktop.
- A web preview only answers on its own 127.0.0.1 address, so the desktop's sign-in cookie never reaches the previewed server.
- Reply to an agent that is waiting on you right from Home.
- Quick chat: ask phren about a project from its memory, without tools, from the project page or ⌘K; ⌘K's `?` search offers to ask the question in one.
- One name for starting an agent everywhere: New agent (⌘K, project pages, the menu bar).
- Launching Phren again brings back a window the menu bar icon hid.
- Projects opens faster: cards show as soon as the list is known, and a store file shared by several computers is read once (78 Hook requests down to 32 with three computers).
- Sections no longer wait on a Hook health check before their first read, and Tasks shows the project you were on (or the one an agent is working in) as soon as its tasks arrive, with the rest filling in.
- Previews and Review's trains no longer re-read every computer on each agent update, only on their own timer or when a computer comes or goes.
- Projects and Tasks load in the background a few seconds after Phren starts, so the first visit opens instantly; Tasks re-reads on open only when its last read is over 30 seconds old.
- Projects, Tasks and Memory show placeholder cards and rows shaped like their content while they load, instead of a Loading line.
- ⌘1–⌘9 (Ctrl+1–9 on Linux) open the titlebar's sections in order; each pill's tooltip shows its shortcut.
- Schedules and Conductor read once when first opened (they read up to three times), and resting the pointer on Review, Projects, Fleet or their sections starts their first read before the click.

## [0.1.6] - 2026-10-13

- Summon Phren with ⌘K open from any app: ⌘⇧Space (Ctrl+Shift+Space on Linux and Windows), changed in Settings › Keys.
- A menu bar icon (system tray on Linux and Windows) shows how many sessions need you and opens one; on a Mac, closing the window keeps Phren running there.
- Reply to a waiting agent from its notification (macOS); clicking a notification opens its session.
- Since you left: Home lists the turns agents finished while you were away.
- What an agent said last shows under Home's rows and in its notification (Hook 0.3.45).
- ⌘K lists the open pull requests on watched sessions.

## [0.1.5] - 2026-10-13

- Merge when checks pass, armed from Changes › PRs.
- Composer recall: what Phren knows about the prompt you are typing.
- Branch tasks on the pull request and the project's Code block.
- Fix it on a failing check launches an agent with the failure.
- A Checks strip on Home.
- Ask Phren's memory from ⌘K with `?`.
- Projects' Launch agent opens the shared launch sheet.

## [0.1.4] - 2026-10-13

- Seen this before on a failing check.
- Notifications when a session branch's checks fail or pass.
- A typed answer stays in a question or password card; no writes to a closed terminal.

## [0.1.3] - 2026-10-13

- Phren remembers card in Changes.
- Project Code block with host, branch, pull requests and checks.
