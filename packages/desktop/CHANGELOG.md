# Phren desktop changelog

Phren desktop versions on its own (`packages/desktop/package.json`). The
Release desktop app workflow publishes a version's section here as its
GitHub release notes, and the app shows them when that version is available.

## [0.1.10] - unreleased

- Home shows “Running low” chats at the configured usage-warning threshold, most constrained first, with account, reset time and Switch into the existing account or harness hand-off flow. The block hides when every open chat has room.

- A service-refused usage window draws a full red ring labeled “Exhausted” with its own reset, even when its reported usage is below 100%.

- Usage reset labels share the warning's wording: whole hours omit zero minutes, partial minutes round up, and resets a day or more away show the local weekday and time in warnings, account usage and ring tooltips.

- Quota recovery notifications retain exhausted accounts through stale reports, avoid treating rounded 0% room as exhaustion, and discard expired or removed-account cooldowns.
- Native notifications announce when an exhausted account has room again, naming the computer and the limit that reset. Settings › Notifications can turn them off; first observations stay silent and repeated recoveries are quiet for ten minutes.
- Account usage fits narrow windows with 16 px gutters and wrapping labels and values; keyboard and palette opens center under the titlebar, while ring clicks keep their wide-window anchor.

- Preserve AltGr character input in fields, terminals and the editor; account usage windows now show the most constrained first within each account.

- Open account usage with Cmd/Ctrl+Alt+U or “Show account usage” in the command palette; the shared overview lists accounts and windows with the most constrained first, and Escape closes it and returns focus.

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
