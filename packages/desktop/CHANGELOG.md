# Phren desktop changelog

Phren desktop versions on its own (`packages/desktop/package.json`). The
Release desktop app workflow publishes a version's section here as its
GitHub release notes, and the app shows them when that version is available.

## [0.1.7] - unreleased

- A new version shows as a chip in the titlebar with What's new, and Download or Restart to update.
- Home's Computers rows show each Hook's version; one behind the newest gets its update command to copy.
- A session waiting on you shows what the agent said last in the Agents sidebar.
- ⌘K lists the projects on every computer and opens one's page.
- A working session with no output for five minutes reads "stalled" on Home and in the sidebar, with a notification.
- Allow or Deny an approval from the menu bar icon's menu, or start a new agent from it.
- Since you left also lists the pull requests whose checks passed or failed while you were away.
- Quiet hours in Settings › Notifications, and a separate switch for stuck-agent notifications.
- Continue a session in another agent (Codex, Claude on another account, OpenCode, Copilot) from its sidebar menu: it writes a hand-off and the new agent picks up in the same folder.
- Reply to an agent that is waiting on you right from Home.
- Quick chat: ask phren about a project from its memory, without tools, from the project page or ⌘K; ⌘K's `?` search offers to ask the question in one.
- Launching Phren again brings back a window the menu bar icon hid.

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
