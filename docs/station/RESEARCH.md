# Phren Station: research notes

Compiled 2026-10-07 for [DESIGN.md](DESIGN.md). Five surveys were run in parallel
(Moshi, T3 Code, other references, the Phren Hook, the phren-apps repo) and
checked against public source, bundled docs and the local installs on the Mac
mini. Versions: Phren CLI 0.3.33, phren-apps 1.0.5, moshi-hook 0.4.16 (daemon
running 0.3.26), Herdr 0.9.1 (docs 0.9.3), T3 Code main `12865b4`
(stable v0.0.45), Codex CLI 0.157 line.

Sections: [Moshi](#1-moshi-and-moshi-hook), [T3 Code](#2-t3-code),
[Codex app](#3-codex-app-and-app-server), [cmux](#4-cmux), [Herdr](#5-herdr),
[VS Code remote and code-server](#6-vs-code-remote-code-server-openvscode-server),
[Zed and ACP](#7-zed-remote-and-acp), [other fleet products](#8-other-2026-fleet-products),
[the Phren Hook](#9-the-phren-hook-what-a-station-reuses),
[the phone apps](#10-the-phone-apps-what-a-station-shares),
[Phren's design language](#11-phrens-design-language), [cross-cutting takeaways](#12-cross-cutting-takeaways).

## 1. Moshi and moshi-hook

**Correction to the brief: moshi-hook is closed source.** The Go module path
is `github.com/rjyo/moshi`, a private monorepo. Public pieces are only the
Homebrew tap (`rjyo/homebrew-moshi`, which mirrors `docs/{api,hooks,usage,windows}.md`),
a `moshi-skill` repo and an obsolete TypeScript predecessor. Release tarballs
ship no LICENSE (SBOM says NOASSERTION). The bundled `docs/api.md` (1,442
lines) is the real spec and is excellent. Go, 24.5 MB arm64 binary with the
web client embedded, 104 tagged releases in five months (about daily), a solo
maker. The iOS app is React Native; the desktop app is Tauri over the same web
client.

**Five wire surfaces** (api.md):

1. Local Unix socket, agent hook subprocess to daemon, newline JSON, auth by
   file mode. Frames `approval.request`, `session.update`, `session.closed`,
   `session.bind` up; `approval.response`, `ack`, `error` down.
2. HTTPS to `api.getmoshi.app`, bearer `hostSecret`: host register, Easy Pair
   bootstrap, inbox events, usage snapshots.
3. WSS to the cloud for the approval round trip and push fan-out (`hello`,
   `approval.request`, `approval.decision`, `ping`).
4. Host gateway on `127.0.0.1:24543`, **no auth, loopback only**. The phone
   reaches it with an SSH local forward on its own terminal connection.
5. CLI JSON over SSH exec as preflight: `moshi-hook context|servers|cwd-list --json`.

**Cloud carries only summaries**: inbox rows capped at 200/80/256 characters,
usage windows, approval decisions, push. Transcripts, diffs, files and
previews never leave the SSH path. Pro licensing is enforced server side.

**Connections**: SSH (keys or password, jump hosts), Mosh (UDP, Pro) and
Eternal Terminal (TCP 2022, Pro). No host discovery; Tailscale is plain
networking, picked first by Easy Pair. **Easy Pair** is one QR flow that
installs an Ed25519 key in `authorized_keys` and pairs the daemon secret;
`host list` and `host revoke` manage keys. Docs warn to turn Tailscale SSH off
because its port 22 hijack hangs key auth.

**Sessions live in the multiplexer**, never in Moshi: tmux, Herdr (preferred,
hooks mandatory) or Zellij. `moshi DIR` is `exec tmux new-session -A -s <basename>`.
The gateway normalizes both muxes into a two-level tree (workspace/tab or
session/window, panes lazily) with `agentStatus` working|blocked|done|idle|unknown,
`title` read from each agent's own records, `model`, `contextRemaining`,
`statusChangedAt` (plus `statusChangedAtApprox` after restarts). The tree
rebuilds every 5 s at rest and every 1 s for 3 s after a hook event; the
agent watch ticks at 250 ms; every `/events` frame is a partial merge.

**Multi-host desktop pattern** (the one most relevant to a station):
`/hosts/<name>/*` on the web listener reverse-proxies HTTP and WS to
`127.0.0.1:24543` on `<name>` through `ssh -W` with `ControlMaster=auto`,
`ControlPersist=10m`, `BatchMode=yes`. `GET /v1/pty?mux=…&host=<name>` runs
the multiplexer attach through a local `ssh -t` on a locally owned PTY, so
terminal bytes never traverse the remote daemon. `POST /v1/hosts/forward`
opens same-port `-L` forwards (max 16). A `GET /v1/version` capability probe
gates host switches; 404 blocks the switch with an upgrade message.

**Hooks for 20 agents.** Claude gets SessionStart, UserPromptSubmit, Stop,
SessionEnd, PermissionRequest, Notification, and Pre/PostToolUse only for
AskUserQuestion and ExitPlanMode (per-tool hooks are deliberately not
installed). Remote approve/deny is typed into the agent's own TUI after
re-reading the screen (409 if the dialog changed). Codex is hooks plus rollout
tailing. OpenCode is an in-process Bun plugin.

**Transcripts** stream raw JSONL rows with physical line numbers and
SHA-validated resume cursors; every harness is rewritten into Claude-shaped
rows so clients keep one reducer. **Diff viewer and file browser** are an
embedded SPA (`/apps/diff/<session>/`) with hunk staging, history, branches,
PRs and an fs watcher; **no editing**. The web client is Vite/Rolldown,
xterm.js with fit, web-links and WebGL addons, KaTeX, JetBrains Mono, Pierre
diff components.

**Copy**: the transport doctrine (GET for bounded snapshots, POST for user
mutations returning an ack, WS for live state; an ack proves delivery, never
state), the single `/events` stream with client-sent `watch` config and
partial merges, the multi-host `ssh -W` proxy with local PTY attach, Easy
Pair, verified TUI answers, doctor-as-data, titles from the agent's own
records, `statusChangedAt` honesty.
**Avoid**: zero-auth gateway and `--listen 0.0.0.0`, cloud-only approvals,
screen scraping as primary truth (Moshi must disable it on EL10 tmux and
cannot use it on Herdr), hard failure on version skew, the 20-agent adapter
matrix.

Sources: getmoshi.app docs (connections, hooks, chat-view, diff-viewer,
multiplexer, tailscale, desktop), `https://cdn.getmoshi.app/hook/v0.4.16/…tar.gz`
docs, `moshi-hook <cmd> --help`, `doctor --json`, `/opt/homebrew/opt/moshi-hook/README.md`.

## 2. T3 Code

MIT, `pingdotgg/t3code`, 26k stars, 100+ commits in the last 30 days. **One
Node "environment" server per machine** (Effect 4, SQLite WAL, 60 migrations,
event-sourced V2 orchestrator) serves three clients: React 19 web
(TanStack Router, Tailwind, Tiptap, `@pierre/diffs`), Electron 44 desktop
(main spawns the server as a child; the renderer is an ordinary remote
client), and Expo mobile. Transport is Effect RPC over WebSocket
(`packages/contracts/src/rpc.ts`, 182 methods, streaming subscriptions) plus
HTTP for large snapshots. Capabilities are advertised in the environment
descriptor; clients gate UI on flags, never versions.

**Connection model.** Routes to one environment: LAN pairing (`t3 pair` QR,
scoped bearer/DPoP session), `tailscale serve` HTTPS, desktop-managed SSH
(installs a 70 MB single-executable server into `~/.t3/runtime`, port
3773), and the hosted T3 Connect relay (Clerk, Cloudflare Durable Objects,
one-time DPoP bootstrap; the relay never proxies app traffic). A saved
environment holds an **ordered route list**; the driver connects over the
first that answers, preflights faster routes every minute and on network
change, learns the server's current addresses, and has a stable environment
ID independent of address. Threads never move between machines; optional
auto balance picks the least-loaded machine only at creation.

**Threads.** Durable app-owned threads; worktree optional but first class;
pinned/active/settled/snoozed/archived inbox with ordering, five-second undo
and server-side auto-settle; per-turn hidden-ref Git checkpoints
(`refs/t3/checkpoints/…`) drive diffs and "edit from here", which fails
closed when the provider cannot roll back its conversation.

**Agents.** Eight drivers. Claude via `@anthropic-ai/claude-agent-sdk`
`query()` with `canUseTool` approvals and runtime `setModel`,
`setPermissionMode`, `interrupt`, `forkSession`. Codex via `codex app-server`
JSON-RPC with a generated client. **Correction to the older Phren finding:
threads now share one app-server per provider instance, not one child per
thread.** Every session gets a thread-scoped bearer to T3's own `/mcp`;
outside agents connect to it with OAuth and a runtime-mode ceiling.

**Terminal.** Server-owned node-pty sessions keyed by thread, 5,000 lines /
8 MiB retention, reattach from any client; the renderer is a `libghostty-vt`
WebAssembly core, not xterm.js.

**Editor and diff.** `@pierre/diffs` and `@pierre/trees`, inline comment
annotations that become composer context, lightweight file editing through
Pierre's `EditProvider` (no Monaco or CodeMirror), full PR flow across five
forges.

**Release.** Vite+, oxlint, nightly every 30 minutes, stable promotes a
nightly; installers 140 to 210 MB; Node 26 single-executable CLI.

**Copy**: environment as authority and client as view; ordered route lists
with learned routes and jittered backoff capped at five minutes; capability
flags; subscription scope separate from cache lifetime; server-owned
terminal retention; typed composer context (diff hunk, terminal range, file
line, PR); the settle/snooze inbox; Stop-boundary checkpoints.
**Avoid**: thread-owns-process as the primary object and its 7k to 8k line
per-provider adapters; hosted relay as the default remote path; the
Electron-bundled server and installer size; worktree-per-thread defaults
with shared-directory refusal rules; shadow provider homes per account.

Sources: repo `docs/internals/{overview,connection-runtime,remote,providers,terminal-runtime,t3-connect,environment-auth}.md`,
`docs/user/*`, `apps/server/src/orchestration-v2/Adapters/{ClaudeAdapterV2,CodexAdapterV2}.ts`,
`packages/client-runtime/src/connection/*`, and the 2026-09-27 report on
Omarchy (`~/research/t3code-report.md`).

## 3. Codex app and app-server

The Codex macOS app (2026-02) merged into one ChatGPT desktop shell on
2026-07-09 with a Chat / Work / Codex mode toggle. Sidebar: projects contain
threads; a thread runs in Local or Worktree mode; Codex-managed worktrees live
under `$CODEX_HOME/worktrees` (about 15 kept, snapshot then auto-delete unless
pinned). Diffs appear in the thread with line comments that go back as a
prompt; "Open in editor" hands off. **Codex Remote** (GA 2026-06-25) drives
Codex on a connected host from the phone through an authenticated relay with
per-phone, per-host QR pairing; the docs say not to expose app-server
transports on a shared network.

**app-server protocol** (`codex-rs/app-server`, Apache-2.0): JSON-RPC 2.0
over stdio, WebSocket (`--listen ws://127.0.0.1:4500`, bearer or capability
token, bearer only on wss or loopback) or Unix socket (WebSocket framing on
the socket; the Hook already uses this). `initialize` then `thread/start`,
`turn/start`, streamed `item/*` notifications, `turn/steer`, `turn/interrupt`.
Approvals are **server-to-client requests** answered `accept | decline |
acceptForSession | cancel`. The v2 catalog is wide: `thread/*`, `project/*`,
`fs/{readFile,writeFile,readDirectory,watch}`, `command/exec`,
**`process/spawn` with a PTY** (`writeStdin`, `resizePty`, `outputDelta`),
`environment/add` (a remote exec server owns files and processes while the
local app-server owns the thread), `remoteControl/*` (pairing codes with
expiry, revocable client list), and an experimental `app-server daemon`
(pid/lock/settings trio, hourly self-update). `codex --remote <url>` attaches
the TUI to any endpoint, with no reconnect.

**Copy**: one JSON-RPC surface over stdio, Unix socket and WebSocket;
approvals as server-initiated requests with `acceptForSession`;
"who owns the thread" separated from "where the filesystem is"; revocable
pairing. **Avoid**: cloud relay as the only cross-machine path; bearer
tokens over plain `ws://` off loopback.

## 4. cmux

`manaflow-ai/cmux`: native macOS Swift/AppKit on libghostty, GPL-3 client,
BUSL web parts. A window holds workspaces (vertical tabs) of split terminal
or browser panes; sidebar rows show branch, PR, cwd, listening ports and the
last notification; agents get icons. Notifications via OSC 777/99/9 or
`cmux notify`, a blue ring on the pane plus an unread badge and "jump to
latest unread". Socket API at `/tmp/cmux.sock`, newline JSON, ancestry-gated
access by default. **Remote hosts**: `cmux ssh user@host` uploads a versioned
`cmuxd-remote` (SHA-256 against an in-app manifest) that multiplexes over the
SSH stdio channel: SOCKS/CONNECT so browser panes see the remote localhost, a
reverse tunnel so remote processes can call the local CLI, PTY persistence
with resize, reconnect backoff 3 to 60 s. macOS only.

**Copy**: sidebar metadata set by agents, the ring and unread-jump attention
model, per-host daemon uploaded on first connect, OSC notifications as an
agent-agnostic signal. **Avoid**: macOS-only client, the GPL/BUSL split.

## 5. Herdr

Single Rust binary, Apache-2.0, "no electron". A persistent headless server
owns panes and processes; TUI clients attach. Workspace (per repo or task) →
tabs → panes. Sidebar agent state `working | blocked | done | idle | unknown`,
from the process in the pane, screen manifest rules, and integration reports
that win over heuristics.

**Socket API**: newline JSON on `~/.config/herdr/herdr.sock` (protocol 22
locally), `session.snapshot`, `pane.read` (sources visible, recent,
recent-unwrapped, detection), `pane.send_text|send_keys|send_input`,
`agent.*`, `events.subscribe` for `pane.created|closed|updated|focused|
agent_detected|agent_status_changed|output_matched|scroll_changed`,
`workspace.*`, `tab.*`, `worktree.*`. **No raw output stream event** over the
socket; a GUI polls `pane.read` or uses the CLI bridges
`herdr terminal session observe w1:p1` (read-only JSON stream) and
`herdr terminal session control w1:p1 --takeover` (bidirectional JSON bridge
"for third-party UIs").

**Remote**: `herdr --remote <host>` and `herdr machine add <label>` attach a
local client to a remote server over SSH (the remote supplies visible content
and session state; SSH compression requested); several machines in one window
with a combined agent list and **independent reconnects** (backoff to two
minutes, a link must stay healthy a minute before fast retry). One profile
targets one remote session. Saved profiles hold only an opaque id, label,
SSH target, session and enabled flag. **No web or GUI client** ("works on
your phone without a mobile app or web dashboard" means an SSH client).
Plugins: `herdr-plugin.toml` with actions, events, panes and link handlers;
Phren's `integrations/herdr/` is one.

**Copy**: five-state status with reports beating heuristics, the machine
profile shape and per-machine reconnect independence, `agent_session` as the
resume handle, the observe/control bridges as a per-pane transport.
**Avoid**: expecting a web client; opening Herdr sockets from the station
(the Hook already fronts Herdr).

## 6. VS Code remote, code-server, openvscode-server

Remote-SSH installs VS Code Server into `~/.vscode-server`, forwards a port,
and splits extensions (UI local, workspace remote, including the extension
host, terminals and git). URIs `vscode://vscode-remote/ssh-remote+<host><path>`
open a folder on a host from any app. Remote Tunnels go through Microsoft's
dev-tunnels service (10 per account, no service hosting, pre-release license).
**code-server** (MIT): patched VS Code over HTTP, password or none, Open VSX
only, `/proxy/<port>/` for dev-server previews, one instance per user.
**openvscode-server** (MIT): upstream-tracking, `--connection-token` in the
URL (`?tkn=`), designed for browsers. Embedding Microsoft's own VS Code Server
is not licensed.

**Copy**: the UI-vs-workspace split as the mental model for station vs Hook;
connection-token-in-URL for a tailnet-only service; port proxies for
previews. **Avoid**: building a full editor; depend on Microsoft tunnels.

## 7. Zed remote and ACP

Zed runs the UI locally and `zed-remote-server` on the host (project,
buffers, LSP, tasks, git, terminals, agent servers). It shells out to system
`ssh` with one ControlMaster per project (reuses yours via `ssh -G` /
`ssh -O check`), multiplexes RPC, terminals and tasks over it, and ensures a
version-named binary in `~/.zed_server/` (download on the host, or upload via
sftp). The binary's `proxy --identifier <id>` mode starts the daemon if
needed and bridges its `{stdin,stdout,stderr}.sock` trio to the SSH session;
exit codes tell the client whether to reconnect. Wire format is
length-prefixed protobuf. Key auth only.

**ACP** (agentclientprotocol.com, Apache-2.0): JSON-RPC over stdio between an
agent subprocess (`session/new`, `session/prompt`, `session/update`,
`session/cancel`) and a client that implements `session/request_permission`,
`fs/read_text_file`, `fs/write_text_file` and `terminal/create|output|
wait_for_exit|kill|release`. Registry agents: Claude Agent, Codex, Gemini,
OpenCode, Copilot, Cursor, Pi. Since early 2026 ACP agents run on the remote
project's server.

**Copy**: proxy-mode daemon with pid and socket trio, ControlMaster reuse,
version-named binaries with download-or-upload fallback, ACP's client-side
terminal methods as the shape for "agent runs there, UI renders the PTY".
**Avoid**: a bespoke protobuf RPC; ACP covers only agents that speak it, so it
complements the Hook's pane model rather than replacing it.

## 8. Other 2026 fleet products

- **Conductor** (conductor.build, Mac): workspace = worktree + branch +
  terminal + diff + review; checkpoints; Conductor Cloud (Vercel Sandbox
  microVMs); an alpha API; Conductor for iOS (2026-10-02, cloud workspaces
  only).
- **Claude Code desktop, Code tab**: sessions sidebar, per-session worktree
  toggle (`<project>/.claude/worktrees/`), drag-and-drop panes (chat, diff,
  browser, terminal, file, plan, tasks, subagent, iOS Simulator), pop-out
  windows, diff line comments as one prompt, PR monitoring with auto-fix.
  Environments Local, Cloud, SSH (installs Claude Code on the host), WSL.
  Deep links `claude://code/new?ssh_host=…&ssh_folder=…&q=…`.
- **Claude Code Remote Control**: `claude remote-control` registers with
  Anthropic's relay; claude.ai/code and the mobile app steer it; Trusted
  Devices with biometric step-up. Vendor relay plus QR pairing, like Codex
  Remote, cmux's iOS plan and Conductor iOS.
- **Emdash** (open source desktop): worktrees with one agent each across 34
  CLI agents, Remote Projects (saved SSH connection) and Remote Tasks
  (provision/terminate scripts per task), tmux for persistence.
- **Vibe Kanban**: Rust server + web UI, issues → workspaces → sessions,
  remote projects, an MCP server.

## 9. The Phren Hook: what a station reuses

Verified in `packages/cli/src/bridge/` at 0.3.33 (line numbers in the Hook
survey; key facts only here).

**Transport and auth.** The Hook is an HTTP server plus a `ws` server bound to
a Unix socket, `<bridge>/hook.sock`, mode 0600. No TCP listener, no TLS, no
token: identity is entirely SSH. A client's restricted key line is
`restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 … phren-iphone`;
the gateway accepts exactly four verbs (`transport.ts`):
`phren-hook v1 pipe` (one HTTP request or one WebSocket per exec, since every
reply is `Connection: close`; `socat`/`nc -U` when installed),
`phren-hook v1 web 127.0.0.1 <port>` (loopback relay for previews),
`phren-hook v1 shell <b64 folder> [agent]` (login shell or one agent on the
SSH PTY, nothing persists) and `phren-hook v1 terminal <server>` (attach a
whole Herdr session or tmux server on the SSH PTY). Pairing is `phren pair`
(TCP 47291, one-time code proven by HMAC both ways, host key pinned).
Computers enroll an ed25519 dispatch key (`phren bridge enroll-computer`,
`phren bridge link`) and list peers in `<bridge>/hooks.yaml` (0600, at most
32, pinned host keys); each peer call is one bounded OpenSSH process with a
temp `known_hosts`, `StrictHostKeyChecking=yes`, `IdentitiesOnly`, no agent,
no forwarding. Two-way links form **sets**; one conductor per set.

**Routes.** About 130 `/v1/*` routes behind per-module `hookRoutes`
(`modules/registry.ts`): health and inventory, workspaces and launch, prompt
and keys and secrets, model and settings switches, uploads, transcripts and
history, approvals and questions and sudo, git (status, log, branches, pulls,
tree, worktrees, stage, unstage, discard, commit, push, pr), files (read-only
checkout browser, byte ranges with a stat version, reference resolution),
the code index, the memory store (trees and blobs with compare-and-swap
writes), tasks, schedules, dispatch and hand-off and grants and sets and
authority and owner inbox, speech, simulators, web servers, resources, usage,
push. Five WebSockets: `/v1/overview`, `/v1/transcripts`, `/v1/status`,
`/v1/speech/live`, `/v1/speech/transcribe`. **At most 16 WebSocket clients
per Hook; a seventeenth evicts the oldest.** Every reply carries
`X-Phren-Protocol: 1`; `capabilities` in `/v1/health` is the feature
negotiation.

**Terminal model.** `TerminalProvider` (`terminal.ts`) with Herdr and tmux
implementations: snapshot, list panes, processes, `readScreen` (visible or
recent, ANSI optional), send keys, prompt, create, start agent, focus, close,
rename. **No route streams PTY bytes and no route exposes `readScreen`.** A
real terminal is the SSH PTY path only. Pane identity comes from Herdr's
reported session or from the transcript file descriptors of the foreground
processes, cached about 2 s.

**Multi-machine is client-side fan-in.** The phone keeps one SSH identity and
one overview socket per computer. Hooks forward only whitelisted one-shot
reads to peers (health, usage, resources, workspaces for `live_sessions`,
owner inbox, subagents) plus dispatch and hand-off writes. There is no
generic peer proxy and no cross-Hook overview stream.

**Existing web surfaces.** `phren web-ui` is loopback-only (`127.0.0.1:3499`,
per-run UUID token, CSRF) and serves memory and the 3D graph, never sessions
or terminals. The VS Code extension talks to the MCP server over stdio. The
graph renderer in `packages/cli/browser/graph/` is the one piece of UI shipped
as the same JS to the web UI, VS Code and both phones.

**Shared shapes.** Zod schemas in `protocol.ts` (`targetSchema`, providers,
session ids, `approvalDecisions`, `OfflineCode`, `PERMISSION_MODES`),
`hookRequest` in `client.ts`, `AGENT_CONNECTIONS.md`, `docs/api-reference.md`,
and 44 conformance fixtures under `fixtures/conformance/`. No OpenAPI, no
generated client.

**Gaps for a station**: (a) no live terminal stream per pane, (b) no write
route for checkout files (only store CAS writes and git actions), (c) no
LSP (the code index gives definitions, references and outlines), (d) no
server-side overview aggregation across Hooks, (e) no desktop identity beyond
SSH keys, and the 16-socket cap is shared with the phone.

## 10. The phone apps: what a station shares

Two fully native apps, no cross-platform framework, no codegen: iOS SwiftUI
(about 107k lines across the app, `PhrenKit` and `PhrenLive`) and Android
Kotlin/Compose (about 75k lines; `phrenkit` is a hand port of PhrenKit plus
the SSH transport over sshj and a from-scratch terminal emulator). Route
strings are hand-written in `PhrenLive/Sources/PhrenLive/*Connection.swift`
and `phrenkit/.../live/*.kt`; decoding is lenient by policy and features are
gated on `/v1/health` capabilities.

**Shared today**: the CLI-generated conformance fixtures (byte-identical
mutation tests), the graph renderer bundle, and the design docs under
`apps/ios/design/` (controls, chat, code, conductor, schedules, sessions,
terminal, navigation, mascot). Everything else exists twice.

**Feature map** (each screen's routes are listed in the full survey):
Agents overview with sessions grouped working and needs-input first, computers
below, the conductor slot, usage rings; Chat (transcript and status
WebSockets, prompt with `deliveryId` reconciliation, keys, uploads, model and
effort, settings, permission mode, approvals and questions as radio cards,
secrets, sudo, worker tree, live reply preview, slash suggestions, context
picker); Talk mode (ElevenLabs over the Hook or the Apple voice, dictation,
read aloud); Terminal (a real PTY over an SSH channel running
`phren-hook v1 terminal` or `v1 shell`, SwiftTerm, phone key bar and
gestures); Changes (git status, log, branches, PRs, tree, worktrees, stage,
discard, commit, push, PR; per-file diffs with syntax color); Code (index
views, dossiers, notes); Schedules (the store's `schedules.yaml` plus Hook
run state and history); Projects (grid, add, knobs, skills, launch on a
computer with role, harness, model, effort, worktree); Tasks (store file
plus the Hook's task contract); Memory (graph, list, files, maintenance;
store read through GitHub or the Hook's store routes); Conductor (grants,
sets, make, stop, dispatch receipts, authority; the owner inbox is a card
inside the conductor chat, not a screen); Computers (health, resources,
usage, web servers through a loopback CONNECT proxy, simulators, files);
Settings (themes, terminal, speech, notifications, stores, GitHub, Hook
health); Notifications (Live Activities, local notifications, optional
APNs or the push relay).

**Connection model**: per-computer `LiveHost` entries (address, port, user,
pinned host key, the Hook's computer UUID, color), one Ed25519 key per host
in the Keychain, one pooled SSH connection per computer with up to eight
channels, no hub, no Bonjour, Tailscale by convention. One overview socket
per computer held open; polling only while it is down; backoff 30 s to 5 min.
Each computer is independent with Offline, Busy, Slow and Verify states and
last-known sessions cached on disk. Sends are attempted once and reconciled
by `deliveryId`.

**A desktop needs**: a keyboard-first terminal, several panes and chats at
once, an editor (no checkout write route exists), bulk keyboard actions,
larger transcript windows, Hook configuration. **Phone-only**: push and
Live Activities, the Apple and Whisper speech stacks (the ElevenLabs routes
are reusable), haptics and the touch kit, Siri and widgets, camera QR, the
loopback preview proxy.

**No shared-contract or codegen plan exists.** The repo's stated model is to
ship the same JS rather than a transcription (the graph). The natural shared
layer for a station is the TypeScript already in `packages/cli`; anything
Swift and Kotlin only (chat timeline, tool cards, offline policy, usage
merging, delivery reconciliation) would be a third port unless lifted into a
shared package first.

## 11. Phren's design language

From `apps/ios/DESIGN.md`, `design/controls.md`, `design/sessions.md`,
`design/chat.md`, `design/mascot.md`, `Phren/DesignSystem/PhrenTheme.swift`,
`PhrenAppearance.swift`, `Shared/PhrenThemeColors.swift`, the App Store set
(`~/Projects/phren-appstore-screenshots/2026-10-01/`) and the PR screenshots.

- **Palette (Charcoal, the default)**: background `1E1E1E`, sunken `141618`,
  surface `282A2C` (cards `323437` in widgets), raised `3C3F42`, tool panel
  `121416`; text white, secondary `ECEDEE`, muted `A4A9B1`, dim `999FA8`;
  accent lavender `B994F4` (hover `DCC5FF`, solid `7450A7`), link `C2AAFF`;
  state working lavender, waiting amber `E0BC7F`, done green `8AC8AC`, danger
  `EF9898`. Computers get their own host color (cyan or green in the
  screenshots). Chat text stays white and grey whatever the theme; chat
  semantic colors are path `7FB6F0`, branch `F0A06E`, running `E8C07A`,
  finished `8AC8AC`, note `8B9098`.
- **Themes**: Charcoal, Amethyst (deep violet), Graphite (warm charcoal),
  Slate (cool slate, cyan `70DBE8` action), Dev's Choice (true black), plus a
  custom editor with named slots (background, text, panels, cards, accent,
  links, session project, session title, session meta, three states, phren
  card surface, border and accent, inline code).
- **Measurements**: spacing 4, 8, 12, 16, 20, 24; radii 10 (cards and small
  controls), 12 (question options), 14, 18, pill; rows 44 minimum, 56 for a
  title over a caption; 28 icon tiles; 0.18 s easing; no continuous
  decorative animation; Reduce Motion honored.
- **Chrome**: a pill tab bar (Projects, Agents, Tasks, Memory, Settings); the
  title at the left and a pill cluster of icon buttons at the right; grouped
  cards on a flat canvas; small-caps section labels with counts ("WORKING ·
  1", "NEEDS INPUT · 1", "IDLE · 2", "COMPUTERS"); a session row is a
  provider glyph inside a status ring, the project name in lavender, a branch
  in monospace, the computer in its host color, an age, the title below, a pin
  at the right, and a left accent bar for working or needs-input; a "Start a
  conductor" card at the top; computer rows and "Add computer" below the work.
- **Chat**: monospaced transcript; user bubble at white 8 percent; tool cards
  (Read, Patch, Shell) with a check mark and a disclosure; inline diffs with
  hunk headers and word-level tint; "Codex asks" approval cards with radio
  rows Approve, Allow for this project, Allow everywhere, Deny; the composer
  with plus, terminal, people and provider glyphs at the left and mic plus a
  talk or send disc at the right; a quiet activity line ("Thought for 27s").
- **Memory**: the 3D wireframe graph on near-black with lavender project
  labels; the pixel-art brain mascot (48 px frames, nearest-neighbor, a
  quiet gesture timeline).
- **Voice**: "Your memory. Your agents." Plain short sentences, no em dashes,
  nothing the product does not do.

## 12. Cross-cutting takeaways

1. Every serious product has a per-machine daemon with a pid, lock and
   settings trio, a version-named binary and an attach or proxy mode. The
   Hook already is this. The station's job is the client side and one
   pairing story.
2. Two protocol shapes dominate: JSON-RPC with server-initiated approval
   requests (Codex, ACP) and newline-JSON method sockets (Herdr, cmux). The
   Hook's HTTP plus WebSocket routes are equivalent and need no replacement.
3. The sidebar is the UI primitive everyone converged on: computer →
   workspace → pane rows with agent state, branch, PR, ports and the last
   notification, with an unread ring and "jump to latest". Herdr's five
   states and "reports beat heuristics" is the right status model.
4. Multi-host desktops use the user's own SSH: Moshi's `ssh -W` reverse proxy
   with local PTY attach, Zed's ControlMaster per project, cmux's uploaded
   daemon. T3's ordered route list with learned routes is the best reconnect
   discipline.
5. Nobody embeds VS Code. They keep a light file pane and a diff viewer with
   line comments that become a prompt, and link out ("Open in VS Code, Zed").
6. Worktree-per-task is table stakes but must stay optional for Phren,
   whose sessions routinely share a checkout.
7. Phones all go through a vendor relay with QR pairing. Phren's phones
   already reach the Hook over Tailscale; the station is the desktop peer of
   that model, not a new relay.
