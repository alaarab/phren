# Phren desktop

Phren desktop is the owner's cockpit for every computer in the fleet. It shows
what needs you, the agents that are working, and the conductor, and it does
everything the phone app does. It also adds tiled chats and consoles, a
review station and a code editor.

It is a client of each computer's Phren Hook, like the phone. Nothing new
listens on the other computers: the desktop reaches them over SSH with its own
key.

Status: owner-only. Installers are on GitHub releases. Several features need
Hook changes that ship with the next CLI release; see
[What needs the next CLI release](#what-needs-the-next-cli-release).

## Install

Download the newest build from the
[latest release](https://github.com/alaarab/phren/releases/latest):

- macOS, Apple Silicon:
  [Phren-mac-arm64.dmg](https://github.com/alaarab/phren/releases/latest/download/Phren-mac-arm64.dmg).
  Open it and drag Phren to Applications.
- Windows, x64:
  [Phren-win-x64.exe](https://github.com/alaarab/phren/releases/latest/download/Phren-win-x64.exe).
  Run it; it installs for your user. The build is not code-signed yet, so
  SmartScreen asks first: choose **More info**, then **Run anyway**. Uses
  Windows' own OpenSSH client, which has no connection sharing, so each Hook
  request opens its own connection.
- Linux, x86-64:
  [Phren-linux-x86_64.AppImage](https://github.com/alaarab/phren/releases/latest/download/Phren-linux-x86_64.AppImage).
  `chmod +x` it and run it. AppImages need FUSE 2 (`fuse2` on Arch).

The app brings its own Node. It needs this computer's Hook (the `phren` CLI
with its Hook running), plus `ssh` for other computers and Herdr or tmux for
consoles.

The macOS build is not signed with a Developer ID yet, so macOS blocks the
first open. Open it once, then choose **Open Anyway** in System Settings ›
Privacy & Security (on macOS 14 and earlier, Control-click the app and choose
Open). Or clear the quarantine flag:
`xattr -dr com.apple.quarantine /Applications/Phren.app`.

Updates: the AppImage and the Windows install download a new release in the
background and install it when you restart. The macOS app checks every six hours and offers the
download; it will update itself once the builds are signed. A new version
shows as a chip in the titlebar: click it for What's new (that version's
section of `packages/desktop/CHANGELOG.md`) and Download or Restart to update.
`PHREN_DESKTOP_UPDATES=off` turns the check off.

### Release it

Bump `version` in `packages/desktop/package.json` and add its section to
`packages/desktop/CHANGELOG.md` (the release notes and the app's What's new;
the workflow fails without one), then push a
`desktop-v<version>` tag or run the **Release desktop app** workflow with that
version. It builds both installers and publishes them, with the
`latest-mac.yml` / `latest-linux.yml` files the updater reads, as the
repository's latest release. To build locally after building the packages
below: `node packages/desktop/scripts/package.mjs --mac` (or `--linux`); the
files land in `packages/desktop/release/`.

macOS signing and notarization turn on when the repository has these secrets:
`MAC_CSC_LINK` (a base64 `.p12` of a Developer ID Application certificate),
`MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`. Without them the app is signed ad hoc.

## Run it from a checkout

```bash
pnpm install
pnpm --filter @phren/desktop-kit build
pnpm --filter @phren/desktop build
pnpm --filter @phren/desktop app      # the Electron window
# or the daemon alone, opened in a browser:
node packages/desktop/dist/src/main.js
```

The Electron shell starts the daemon on the system Node (it needs `node-pty`)
and passes it a session token over a private pipe. The daemon listens on
`127.0.0.1` and serves the UI as `http://localhost:<port>`.

The VS Code editor host is a separate Vite build:
`pnpm --filter @phren/desktop-editor build`. Without it, files open in plain
Monaco.

## Link computers

The desktop has its own SSH key, separate from the phone's and the
conductor's dispatch key. It is revocable per computer.

```bash
node packages/desktop/dist/src/main.js enroll                  # create the key, print its authorized_keys line
node packages/desktop/dist/src/main.js link user@host --name Devbox
node packages/desktop/dist/src/main.js revoke Devbox
node packages/desktop/dist/src/main.js list
```

`link` installs the key with your own SSH login and pins the computer's
ed25519 host key in `<bridge>/desktop.yaml`. Settings › Computers can also
link and revoke computers. Without `desktop.yaml`, the desktop falls back to
the Hook's `hooks.yaml` peers and the dispatch key.

## Sections

The titlebar pills:

| Section | What it holds |
|---|---|
| Home | The conductor (open or start one), who needs you (Enter approves, P allows for this project, D denies, O opens), working agents, recent worker returns, each computer's load |
| Agents | Sessions by status or by computer, centre tiles, the right tool panel (Changes, Files, Search), a bottom terminal |
| Review | Worker returns with reports and diffs, line comments sent back as one prompt; Trains: open pull requests per repository with checks and release authority |
| Conductor | The running conductor, dispatches and returns, the owner inbox, standing grants, computer sets, release authority |
| Projects | Every project with its summary and counts; skills, knobs, add a project, launch an agent there |
| Tasks | Active, Queue and Done with readiness; create, edit, complete, move, launch as an agent |
| Memory | Findings, the review queue (approve, reject, edit), notes, truths, topics and the 3D graph, for any computer's store |
| Code | What changed, most used and code notes from the code index |
| Schedules | Scheduled prompts, the next runs, history, run now, edit |
| Previews | Every computer's local web servers and simulators |
| Settings | Computers and their health, keys, extensions, themes, notifications |

Changes shows a **Phren remembers** card over the changed files, like
gitboy's pull request card: the findings that cite those files or a function
in them, with a count on each file that has some. A citation opens the file at
that line. A failing check on the branch's pull request shows **Seen this
before**: the findings and truths that match it, with **Ask the agent** to
put the failure and the finding in the chat. **Fix it** (there and on the
project page's Code block) opens the launch sheet for a new agent with a first
prompt you can edit: the request, its branch, each failing check with its
message and link, and what Phren remembers about them. The current pull
request, and the project page's Code block for the checkout's branch, list the
open Phren tasks that name that branch or its issue number, with **Done** to
complete one.

The desktop also notifies you when the pull request of a working (or recently
active) session's branch turns failing or passing. It asks each project's Hook
every two minutes, at most six projects. Turn it off in Settings ›
Notifications.

⌘K opens the palette (sessions, the open pull requests on watched sessions,
projects on every computer, files, commands). From any other app,
⌘⇧Space (Ctrl+Shift+Space on Linux and Windows) brings Phren forward with the
palette open; change or turn off that key in Settings › Keys. A menu bar icon
(system tray on Linux and Windows) shows how many sessions need you and lists
them; choose one to open it, or Allow / Deny an approval from its submenu. On a Mac, closing the window while the icon is on
keeps Phren running there. Turn it off in Settings › Notifications. Clicking a "needs you"
notification opens that session; on a Mac, one for an agent that finished and
waits on you takes a typed reply, sent as its next prompt. Come back after a
minute or more away and Home's "Since you left" lists the turns agents
finished meanwhile, the pull requests whose checks passed or failed and accounts
whose limits reset. The same feed collects while another section is open.
Recovered accounts show two-line titles and an underlined Usage tag that opens
account usage. Hand-offs stay on their existing session row without an extra item. Dismiss clears these entries together. Home's Computers rows show each Hook's version and flag
one older than the newest seen, with its update command to copy. A working
session that has shown no output for five minutes reads "stalled" on Home and
in the sidebar, with a notification. Settings › Notifications sets quiet
hours, when no notifications are shown (the badge and the menu bar still count).
A session's sidebar menu has Continue in…, which hands it to another harness or
Claude account in the same pane with a written hand-off (Hook `sessionMove`).
Quick chat (a project's page, or ⌘K) starts phren's own agent with no tools, to
ask about a project from its memory (Hook `quickChat`). A Needs you row on Home
whose agent is simply waiting has a reply box that sends its next prompt. The launch sheet
("+ New agent") recommends a computer from its load and account quota.

## Chats, consoles and tiles

A session opens as a chat: the phone's timeline, tool cards, approval and
question cards, and the phone's composer. The composer has attach, console,
subagents, workers, the model menu, dictation, talk mode and stop. Its
**Chat | Console** switch shows the agent pane's own terminal instead. Hold F5
anywhere to talk to the conductor.

The centre is tiled like Herdr's panes, and every tile has its own tabs.
Herdr's key names apply, so overrides in `~/.config/herdr/config.toml` (and
`~/.config/phren/desktop.toml`) carry over:

| Keys (prefix ⌃B) | Action |
|---|---|
| v / minus | Split side by side / top and bottom |
| h j k l | Focus the tile in that direction |
| ⇧ + h j k l | Move the tab to the tile in that direction |
| ⌃ + h j k l | Swap with that tile |
| ⌥ + h j k l | Move the divider |
| z | Zoom the tile |
| t | Chat / Console |

⌘\ and ⌘⇧\ split too. You can drag a tab onto a tile's edge to split there.
**Mirror tab** rebuilds the tiles like the focused session's Herdr tab. The
layout is saved and restored.

## Desk first

While you type or move the mouse in the focused desktop window, the desktop
tells each Hook that you are at the desk. Approval alerts then wait instead
of buzzing the phone. An alert reaches the phone only if it is still pending
once the desk has been idle for 60 seconds.

## Trust and safety

- The daemon refuses writes without `Content-Type: application/json`, the
  `X-Phren-Desktop` header and a same-origin `Origin` or `Sec-Fetch-Site`. It
  refuses any `Host` but its own, so other local web pages cannot drive it.
- The session cookie lives on `localhost` only. Web previews are served from
  `127.0.0.1` relay ports, so a previewed app never receives it.
- Remote store data is untrusted. The memory mirror accepts only canonical
  blob ids, and every download must hash to its id.
- VS Code web extensions run in an isolated `{{uuid}}.localhost` frame.
  **Node extensions run as you**, so they are off until you turn them on in
  Settings › Extensions. Their host starts with no desktop secrets in its
  environment, its own HOME and temporary folder, and a connection token made
  fresh on every start. On macOS it also runs under `sandbox-exec`, which
  denies the bridge folder (the desktop key), the SSH connection sockets, the
  Hook, Herdr and tmux sockets and the SSH agent. They can still read and
  change your other files. On Linux and Windows only the environment and
  folders are separate, so the key stays readable there.
- Electron grants notifications, the clipboard and the microphone to the
  app's own origin only.

## What needs the next CLI release

These rely on Hook routes that are on this branch but not in the released
CLI. Until then, the desktop shows a disabled control with a reason, or falls
back:

| Feature | Hook change | Capability |
|---|---|---|
| Console (one pane's terminal) on other computers | `phren-hook v1 pane` | `paneTerminal` |
| Desk-first approvals | `POST /v1/push/presence` | `deskPresence` |
| The desktop's own socket pool (it never evicts the phone's) | `X-Phren-Client` pools | — |
| Fast memory sync | `POST /v1/store/blobs` | `memoryStoreBatch` |
| Mirror tab on other computers | `GET /v1/workspaces/layout` | `paneLayout` |
| Safe concurrent saves | per-file write lock in `file-write.ts` | — |
| What an agent said last on Home rows, sidebar rows that need you and notifications | `lastReply` on overview rows | — (absent field) |

## Packages

- `packages/desktop`: the daemon (`src/`), the plain-ESM UI (`ui/`, see
  `ui/CONTRACT.md`) and the Electron shell (`electron/`).
- `packages/desktop-kit`: client logic ported from the Android kit
  (transcripts, the chat timeline, tool presentation), tested against the
  Kotlin tests and the conformance fixtures.
- `packages/desktop-editor`: VS Code's editor and extension host
  (monaco-vscode-api), built with Vite into `packages/desktop/ui/editor-host`.

Tests: `pnpm vitest run packages/desktop packages/desktop-kit`, and the UI
smoke tests against a fake Hook with
`pnpm exec playwright test -c packages/desktop/playwright.config.ts`.

The RC-only `browser-test` job in `.github/workflows/ci.yml` runs both the CLI
and desktop Playwright suites when dispatched with `release_candidate=true`.
Before the desktop suite, it builds `@phren/desktop-kit`, `@phren/desktop` and
`@phren/desktop-editor` (including the Monaco host) with
`pnpm --filter <package> build` from the repo root. On failure, the desktop HTML
report, traces and screenshots in `coverage/desktop-playwright/` are uploaded
as the `desktop-playwright` artifact with three-day retention. PR CI continues
to run builds, lint and docs only.
