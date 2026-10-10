# Phren desktop

Phren desktop is the owner's cockpit for every computer in the fleet. It shows
what needs you, the agents that are working, and the conductor, and it does
everything the phone app does. It also adds tiled chats and consoles, a
review station and a code editor.

It is a client of each computer's Phren Hook, like the phone. Nothing new
listens on the other computers: the desktop reaches them over SSH with its own
key.

Status: owner-only and unreleased (branch `feat/desktop-spike`). Several
features need Hook changes that ship with the next CLI release; see
[What needs the next CLI release](#what-needs-the-next-cli-release).

## Run it

From this checkout:

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
node packages/desktop/dist/src/main.js link user@host --name Linuxbox
node packages/desktop/dist/src/main.js revoke Linuxbox
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

⌘K opens the palette (sessions, files, commands). The launch sheet
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
  **Node extensions run as you**: they could read the desktop key and reach
  every linked computer. They are therefore off until you turn them on in
  Settings › Extensions.
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
