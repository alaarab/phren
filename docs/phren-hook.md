# Phren Hook

Phren Hook connects the phren iPhone and Android apps to agents already running
on your computers. New users: [Get started](get-started.html) walks through the
whole setup. It is part of the open-source Phren CLI and runs independently of
other phone or terminal applications.

## Install on each computer

Requires macOS or Linux, Node 20 or newer, Herdr or tmux 3.0+, SSH, and `lsof`.
Linux uses a systemd user service; macOS uses a LaunchAgent in your signed-in
user session. Without Herdr the Hook uses tmux; see [Without Herdr: tmux](#without-herdr-tmux).

```sh
npx --yes @phren/cli@0.3.11 bridge install
npx --yes @phren/cli@0.3.11 bridge doctor
```

Keep Tailscale connected on the iPhone and computer for remote access. Funnel and
public ports are unnecessary.

### Connect the phone: `phren pair`

```sh
phren pair
```

`phren pair` turns on the Hook module, installs Phren Hook if needed, and prints
a QR code. In Phren, choose **Agents → Add computer → Scan pairing code**. The
phone makes its own SSH key and sends the public half to this computer, which
adds one restricted `phren-iphone` line to `~/.ssh/authorized_keys`. Can't scan?
Choose **Enter code** and type the address and six-character code the terminal
shows.

The QR code carries the computer's Tailscale and LAN addresses, the SSH user,
the SSH host key fingerprint (pinned by the phone) and a one-time code. The code
never crosses the network: the phone proves it with an HMAC over its public key,
and the computer answers with an HMAC over its host fingerprint, so a phone that
typed the code by hand pins the right host key too. The listener (port 47291)
accepts one phone, closes after five wrong codes, and times out after five
minutes (`--minutes` up to 30). SSH itself must be on: Remote Login on macOS,
`sshd` on Linux.

The manual route still works: in Phren, choose **Enter details** under Add
computer, copy the SSH authorization line into that user's
`~/.ssh/authorized_keys`, then verify the computer's SSH fingerprint. Existing
Phren device keys are migrated with a backup by the installer.

### Memory without GitHub

A paired computer also serves its phren store to the phone (`memoryStore` in
`/v1/health`): the Projects, Tasks and Memory tabs read the store's working tree
through the Hook, and edits are written back with a compare-and-swap on each
file's git blob sha. Files the store ignores stay off the phone. GitHub is only
needed for sync away from the computer and for team stores.

Updated web previews require a helper advertising `webPreview: "ssh-exec"`.
Released 0.2.14 builds without that capability need an updated CLI build before
running `bridge install`; repeating the released command above does not add it.
The installer removes generic forwarding from recognized device keys. Previews
then use the dispatcher's loopback TCP command, keeping private Unix sockets
inaccessible through SSH forwarding. Update the helper and authorization lines
on every computer before installing the updated phone app, then reconnect SSH.
An older helper produces an explicit update instruction in the app.

On macOS the installer loads the LaunchAgent into `gui/<uid>` when someone is
logged in at the screen. Over an SSH login with no screen session that domain
does not exist, so it loads into `user/<uid>` instead and says so; run
`bridge install` again after a screen login to move it into `gui/<uid>`. When
launchd refuses the job or the Hook does not become ready, the error prints the
`launchctl bootout`, `bootstrap` and `kickstart -k` lines for the domain it
used.

The forced command is a small POSIX shell gateway. For the phone's byte pipe it
hands off to `socat - UNIX-CONNECT:<socket>` when socat is installed, or to
`nc -U <socket>` when that nc understands Unix sockets, and only otherwise
starts the node gateway. The installer detects the forwarder and records the
choice in `installed.json`, so a loaded computer does not pay for a fresh node
process on every connection. Every other SSH command (loopback web previews,
project shells, Herdr terminals) always uses the node gateway. The service is
installed at a lower nice value (`Nice -5` in the launchd plist and the systemd
unit) so the Hook daemon keeps the CPU ahead of the workers it supervises.

For unreleased fixes from a local checkout, build and install that checkout's
helper instead of reinstalling the published package. If the `code` module is
enabled, build its workspace package first:

```sh
pnpm --filter @phren/code build
```

Then build the CLI:

```sh
pnpm --filter @phren/cli build
```

If `code` is enabled, link that built package into the store before installing
the Hook. The installed Hook runs from a copied bundle, so it needs the store
link even when the CLI can see the workspace sibling directly:

```sh
node packages/cli/dist/index.js modules enable code
```

Then install and check the Hook:

```sh
node packages/cli/dist/index.js bridge install
node packages/cli/dist/index.js bridge doctor
```

Install the helper on every connected computer before updating the phone app.
The installer restarts its user service and preserves existing authorization and
agent configuration. Review new or changed Codex hook definitions in `/hooks`;
Phren does not answer Codex's or Claude's trust screens. It marks a folder trusted
only when the Hook chose it: a dispatched or scheduled project's folder and a
worktree it created, before starting Claude or Codex there (see
[footprint](footprint.md#folder-trust-for-launches-the-hook-places));
`PHREN_PRETRUST=off` turns that off. Scheduled headless Codex runs also pass
`--skip-git-repo-check` (see [schedules](schedules.md)).

## What connects

Workspace snapshots optionally include `contextUsedPercent` for a tab with one
verified Codex agent. The helper reads the latest reported token count and
context-window limit from a bounded transcript tail, caches unchanged files,
and limits concurrent lookups. Optional enrichment returns partial results after
1.5 seconds; later requests omit metrics while the bounded pending work drains.
Missing limits, ambiguous panes, and unavailable observations omit the metric.
No extra request per iPhone row is needed.

- Codex, Claude Code, and Copilot conversations, with exact pane/session identity.
  phren's coding agent (`phren agent` or `phren-agent`) is wired the same way:
  its `.runtime/sessions` event log is the transcript, and it reports
  SessionStart/UserPromptSubmit/Stop to the Hook itself. Under tmux it is
  recognized from its process whichever entry point started it; under Herdr it
  switches on once Herdr reports the `phren` agent kind.
  opencode is supported too: its session ids are `ses_…`, identity comes from
  Herdr's opencode integration, and a Phren-installed opencode plugin mirrors the
  session into the same `.runtime/sessions` event log.
  Codex 0.157 and later run conversations in one shared background daemon
  (`codex app-server`), so the pane's own `codex` process holds no rollout and
  Codex's callbacks run inside the daemon with the environment of whichever
  pane first started it. For such a pane the Hook reads the rollouts the
  daemon holds open (else today's and yesterday's in `~/.codex/sessions`) and
  picks the conversation whose `session_meta` folder is the pane's and that
  began after the pane's Codex started. The only Codex pane in a folder follows
  its most recently active conversation, so `/new` and `/resume` follow too;
  several Codex panes in one folder each take the earliest conversation begun
  after they started. A callback from inside the daemon is placed on the pane
  that shows its conversation and never records a pane binding.
  Codex 0.155.1 and later run tools from a JavaScript script (code mode) and
  record each action as its own item. The chat shows those items as the calls
  the terminal shows: commands with their folder, output (last 4,000
  characters) and exit code, edits as patches, MCP calls under
  `mcp__<server>__<tool>`, and viewed images with the picture. The script
  itself is hidden when every tool it called is recorded as an item; a failed
  script stays with its error.
- Chat history, incremental transcript updates, real token counts, image uploads,
  stop, and project context from Phren's memory and skills.
- Native Herdr terminals, named servers, workspaces, tabs, and pane navigation.
- Without Herdr, tmux: Claude Code, Codex, OpenCode, Copilot and phren-agent
  sessions in your own tmux servers, and sessions the phone starts in a hidden
  tmux server (see below).
- Without Herdr or tmux: "Open a terminal instead" starts a shell or the chosen
  agent straight over SSH in the project folder. Terminal only; it ends with the
  connection and has no chat, transcript, or approvals.
- Codex/Claude approvals through Phren's lifecycle callbacks while you watch a
  conversation or the foreground session overview. Codex asynchronous questions
  can be answered in chat when the installed Codex supports its exact-thread
  inbox command (`codex queue --thread … --message …`). The Hook runs the real
  `codex` binary for this, skipping the session wrapper `phren init` can put at
  `~/.local/bin/codex`. Synchronous questions and unsupported provider
  interactions open in Phren's terminal.
- Git diffs, local HTTP app discovery, and SSH browser previews.
- The project's code index, when the `code` module is on and the project has
  been indexed: what changed, finding functions and types by name, file outlines,
  definitions, where each is used, and the most and least used.
- Local project activity history, retained on the computer.

From a project, the iPhone can open a new session on a computer:
`POST /v1/workspaces/launch` creates a Herdr workspace (or a tab in one) in
the project's directory and starts Codex, Claude Code, Copilot or OpenCode
in its pane, returning once Herdr has detected it ready. Otherwise
the helper does not start coding agents for you. Text updates depend on when
that agent writes its transcript; usage numbers are never estimated. In Codex,
review the installed Phren callbacks in `/hooks`. Resume existing sessions if
needed to load new callbacks. Ambiguous conversation identities disable sending.

`GET /v1/projects/locate?project=<name>` says where a project lives on that
computer, existing folders only: the activity journal (every folder an agent
session ran in, newest first), Herdr's saved workspaces, phren's registered
path, then the usual project roots. The phone's "Open on a computer" fills its
folder from this rather than from the store's `sourcePath`, which belongs to
whichever machine added the project.

`GET /v1/projects/repos` lists the git checkouts on that computer for the
phone's "Add project": where agents have worked, Herdr's saved workspaces,
then one level under the usual project roots, each marked whether phren there
already tracks it. `POST /v1/projects/add` with `{"directory"}` enrolls an
existing checkout, or with `{"cloneUrl"}` (https or `git@` GitHub-style URLs
only) clones it into `$PROJECTS_DIR` or the first usual root first, with the
computer's own git credentials, never a token from the phone. Either way it is
`phren add` with the store's default ownership, followed by a commit and, when
the store has a remote, a pull and push so the phone can fetch the new project.
The reply says `store: pushed | committed | unchanged | error`.

The `code` module serves the phone's indexed file tree, search, outlines,
definitions with linked findings, where each function or type is used, what
changed, the full most-used ranking and per-file change chips. Code opens from the project, a session's Changes band or chat
header. Reads accept a registered store selector; notes and reindexing use POST.
A dossier note saves a finding before optional conductor delivery and retains
the originating session when opened from chat. Missing indexes return 404 with
the indexing command. Recorded file changes trigger a 500 ms debounced refresh;
a HEAD change requests a full scan. See [Code index](code-index.md) and the
[complete route table](api-reference.md#hook-routes).

`GET /v1/projects/files` reads files inside a discovered checkout, capped at
2 MiB per file and 500 directory entries. `POST /v1/git/tree` browses one
directory of a session's working tree, with descendant file counts and a
snapshot version. Its bounded cache expires after two seconds; status refresh
and mutations invalidate it. Indexed projects add per-file change chips
without making an index a requirement for file browsing.

`GET /v1/models?source=claude` reads Claude Code's own cached model catalogue,
preserving names, order and default and filtering out rows requiring a newer
client. Codex uses app-server model discovery; OpenCode uses `opencode models`.
The phone waits for this response before drawing its picker. See
[model catalogue](api-reference.md#model-catalogue) and
[files read by Hook](footprint.md#hook-reads-from-installed-agents).

The iPhone explicitly renews a 25-second approval watch with
`GET /v1/workspaces?watchApprovals=1`. Ordinary overview reads do not hold prompts.
Pending tabs expose `approvalPending`; the exact conversation's status stream
provides the action ID, input and expiry. Requests wait at most 55 seconds (a
Codex pane on a Phren-owned app-server has no limit, see below), then
return to the agent's terminal prompt without approving anything. Answers are
single use and validated against the exact provider conversation. An opencode
permission ask is not a lifecycle callback: the plugin writes it under the
store's `.runtime/approvals`, and the Hook watches that directory, maps the ask
to its pane through the recorded session binding or Herdr's opencode session id,
and pushes it to registered phones with the ask's title and message. The same
`POST /v1/approvals/answer` route writes the plugin's answer file.

On iOS, a request received in an open chat or discovered from the foreground
session overview can create a Live Activity with Deny and Approve on the Lock
Screen and Dynamic Island. Tapping either authenticates
and opens Phren, which uses its existing pinned SSH connection and protected
Keychain key. The widget contains no credentials or executable tool input.
Expired requests lose their buttons. The phone also offers local notifications
for approvals and the next scheduled prompt, with separate switches in Settings.
It checks saved computers during a brief background lease and optional iOS
background refreshes. These need no APNs key or relay, but cannot promise
delivery while the phone is suspended. Approval IDs are deduplicated on the
device, and tapping rechecks the live request. Direct APNs remains an optional,
separate path for owners with their own credentials.

### Codex panes on a Phren-owned app-server

A Codex worker the Hook launches (a dispatch, a scheduled run, or a phone
launch with role `agent`) runs on its own `codex app-server`, one per pane,
instead of a Codex the Hook types into. Conductors keep the typed path.

- **Launch.** The Hook creates the pane, then starts
  `codex app-server --listen unix://<bridge>/codex-servers/<id>/app.sock`
  (folder 0700) detached, with the pane's own terminal variables (so Codex's
  hooks inside the server report that pane) and `PHREN_CODEX_SERVER=<id>`.
  It starts the thread itself (`thread/start` with the folder, the model and
  `config.model_reasoning_effort`), and the pane runs
  `codex resume <thread> --remote unix://<socket>`: the TUI is a second client
  of the Hook's thread. A brief is sent as the thread's first turn before the
  pane starts, and its acknowledged turn id is the dispatch receipt.
- **Sending.** `POST /v1/prompt` to such a pane starts a turn on its thread
  (`turn/start`) and answers `{ "ok": true, "delivered": true, "turnId": … }`
  as soon as Codex acknowledges it. Nothing is typed. A slash command is the
  TUI's own and is still typed; a server that cannot be reached falls back to
  typing. A turn started while one is running steers it, the way Codex's own
  clients do.
- **Approvals.** Command, file-change and permission requests arrive as server
  requests and become the same approval card and push as a held
  PermissionRequest, answered over RPC (`accept` or `decline`, a permission
  grant or none) with no 55-second hold: the card stays until someone answers.
  Answered in the pane's TUI first, the card goes away. The PermissionRequest
  callback for these threads returns at once, so there is one card, not two.
  Questions (`request_user_input`) and MCP elicitations stay in the pane.
- **Escape.** `/v1/keys` Escape on such a pane with a running turn declines the
  thread's parked requests, then interrupts the turn (`turn/interrupt`).
- **Restart.** Servers outlive the Hook. A restarted Hook reads
  `<bridge>/codex-servers/*/server.json`, reconnects to each live server and
  rejoins its thread; Codex replays requests still waiting, so their cards come
  back. Each 5-second tick forgets a server whose process ended and stops one
  whose pane closed, or whose pane or terminal server has shown no Codex for
  two minutes.
- **Returns.** Each registered thread's running turn and its last finished turn
  (id and status: `completed`, `interrupted`, `failed`) are kept in its
  `server.json` for the returns loop.

`PHREN_CODEX_APP_SERVER=off` in the Hook's environment keeps every Codex launch
on the typed path. A server that fails to start falls back to it for that
launch.

Known gaps: `/new` or `/resume` typed in such a pane moves the TUI to another
thread the Hook does not follow (the pane's identity stays the first thread
until the pane closes); approvals push only for the three request kinds above.

### Approval push with your own APNs key

Instant approval and schedule alerts while Phren is suspended come from the
Hook straight to Apple (APNs), with no relay. They need an APNs key from the
Apple developer account that signs the app, set up on each computer:

1. In the developer account, open Keys, create a key with Apple Push
   Notifications service enabled and download `AuthKey_<KEYID>.p8`. Note its
   Key ID and your Team ID.
2. Copy the `.p8` into the Hook's directory
   (`~/.local/share/phren/bridge/`, or `$PHREN_BRIDGE_HOME`) and make it
   readable only by you: `chmod 600 AuthKey_<KEYID>.p8`.
3. Write `apns.json` beside it, also mode 600:

   ```json
   {
     "keyId": "<KEYID>",
     "teamId": "<TEAMID>",
     "topic": "com.phren.ios",
     "privateKeyPath": "AuthKey_<KEYID>.p8"
   }
   ```

   `keyId` and `teamId` are the 10-character IDs from the developer account.
   `topic` is the app's bundle id. A relative `privateKeyPath` is resolved
   from the directory of `apns.json`. `PHREN_APNS_CONFIG` points the Hook at
   a different file.
4. Restart the Hook (`phren bridge install`) and run `phren bridge doctor`.

The Hook loads the key at startup. Files that other users can read, or that
belong to someone else, are ignored. Until a key loads, the Hook still accepts
phones that register for push (the reply to `POST /v1/push/register` carries
`configured: false`), but it leaves `approvalPush` out of its capabilities,
`GET /v1/push/status` and `/v1/health/details` report `configured: false`,
`phren bridge doctor` prints these steps as a warning, and the phone's
Settings → Notifications says "Instant approval alerts need an APNs key on the
computer" with the computer's name.

The transcript socket also carries live reply previews. Claude reads pane text
after the current prompt, with its styles, and turns Claude's bold back into
Markdown `**bold**`; Codex and OpenCode supply delta text. Updates are capped at
twice a second, stay out of history, and give way to the completed entry. Chat
sends steering to working harnesses immediately and reads their queued state
from transcripts. Local pending bubbles identify a connection, startup or held
prompt that prevents delivery.

### Without Herdr: tmux

When no Herdr server answers and `tmux` (3.0 or newer) is installed, the Hook
drives tmux instead. Install tmux, run `phren bridge install`, and the phone
lists your tmux servers:

- `tmux`: your own tmux server (the default socket), while it runs. Agent
  sessions you start there with `ssh server` then `tmux` then `claude` show up
  in the phone's list with chat, status, approvals and the terminal.
- `tmux-<name>`: any other tmux server of yours that answers, such as one
  started with `tmux -L work` (`tmux-work`). The Hook looks for sockets in
  `$TMUX_TMPDIR/tmux-<uid>/` and `/tmp/tmux-<uid>/`, at most 16 servers.
  A server started with `tmux -S <path>` elsewhere is not found.
- `tmux-phren`: a hidden tmux server on its own socket, where sessions the phone
  starts run. It starts with the first launch. Each launch is a tmux session
  named after it, with the agent started under your login shell in the project
  folder; when the agent exits the pane keeps a shell. To look at it on the
  computer: `tmux -L phren attach` (detach with `Ctrl-b d`; the agents keep
  running).

With Herdr running as well, your own tmux servers (`tmux`, `tmux-<name>`) are
listed beside it, so an agent started over ssh with `tmux new -s app` then
`codex` shows up next to your Herdr sessions. Phone launches still go to Herdr,
and an already-running `tmux-phren` remains listed so its sessions stay reachable.
Each source is identified as `herdr` or `tmux`; tmux is not a Herdr server.

What works:

- Discovery: the Hook lists every pane with `tmux list-panes -a` and names the
  agent from the pane's foreground processes (`ps`), not from tmux.
- Identity: from the SessionStart, UserPromptSubmit, Stop and PermissionRequest
  callbacks Phren installs for Claude Code and Codex, which record the pane's
  conversation, from the transcript the agent's process holds open (`lsof`),
  from the rollout a Codex app-server daemon holds for the pane's folder,
  from the conversation phren's OpenCode plugin records per process, and from
  Copilot's process log.
- Status, per harness:
  - Claude Code, Codex and phren-agent: the last callback event. A submitted
    prompt or a tool call is working, a finished turn or a new session idle, a
    permission request blocked until it is answered from the phone or its
    dialog leaves the terminal. Before the first event (a folder-trust screen,
    or a session started before the Hook was installed) Claude and Codex show
    unknown and sending waits; type anything in the terminal, or answer the
    screen from the phone, to start it. phren-agent shows idle until its first
    event.
  - OpenCode: what phren's OpenCode plugin records for the process
    (`.runtime/sessions/opencode-status-<pid>.json` in the store) from
    OpenCode's own busy/idle and permission events. Restart OpenCode sessions
    started before this update so they load the new plugin; until then they
    show idle.
  - Copilot: its session log (`~/.copilot/session-state/<id>/events.jsonl`).
    A prompt is working, a permission request blocked until it completes, the
    turn that ends with the final answer (or `session.idle`, an abort) idle.
- Dialogs without a callback: Claude's auto-mode fallback and Codex, OpenCode
  and Copilot terminal dialogs have no PermissionRequest behind them. While a
  pane is working, the Hook reads its screen at most once every 3 seconds
  (`PHREN_DIALOG_THROTTLE_MS`); a dialog there marks the pane blocked, which
  puts the question on the phone, and the pane goes back to working when the
  dialog is gone. Only a harness's own dialog counts: Claude's and phren-agent's
  numbered rows with their "Esc to cancel" footer, Codex's and Copilot's
  choice rows, OpenCode's "Permission required" prompt.
- Chat, sends (pasted as one bracketed paste, then Enter), keys, approvals, the
  terminal (`phren-hook v1 terminal tmux` attaches the phone's SSH terminal to
  the server), and launching Claude Code, Codex, Copilot or OpenCode into
  `tmux-phren`.
- Dispatch: `phren dispatch` and the `dispatch` MCP tool, run from an agent in
  a tmux pane, remember that pane (from `TMUX` and `TMUX_PANE`) for the
  workers' return notices, as they do in Herdr.
- Diagnosis: `phren bridge doctor` prints a `terminal` section (the provider
  each running server uses, the tmux version, whether it can start agents, the
  owner's servers and whether the hidden server runs), and `phren status` and
  the Hook's `/v1/health/details` carry the same. `phren canary` starts its
  test conductor in `tmux-phren` when there is no Herdr.

Not verified yet: a real Claude Code, Codex, Copilot or OpenCode on tmux end to
end with the phone (automated tests drive a real tmux with stand-in agents), and
the phone's terminal attach over SSH. `PHREN_TMUX=off` keeps the Hook on Herdr
alone.

## Maintain and diagnose

```sh
npx --yes @phren/cli@0.3.11 bridge status
npx --yes @phren/cli@0.3.11 bridge update
npx --yes @phren/cli@0.3.11 bridge rollback
npx --yes @phren/cli@0.3.11 bridge uninstall
```

`update` installs the version of the CLI you invoke; choose an explicit newer
version when upgrading. The standalone bundle survives npm cache cleanup.
`rollback` activates the prior installed version; it leaves migrated key
restrictions in place. Rolling back to a helper without `ssh-exec` previews
therefore keeps previews unavailable until the helper is updated again.
`uninstall` stops the service
and removes Phren's agent callbacks, retaining local data and backups. Remove
Phren's public keys from `authorized_keys` to revoke phone access.

If the phone cannot connect, check Tailscale and SSH first, then run `bridge doctor`
on that computer. Verify Herdr is running and the device's current authorization
line includes the Phren dispatcher and `pty`. On Linux, enable user lingering if
you need the service to continue after logout. Hook errors on macOS are recorded
in `~/.local/share/phren/bridge/service.log`; on Linux use
`journalctl --user -u phren-hook`.

`GET /v1/health` reports the computer's 1-minute load average and CPU count
(`load`) and, when the node gateway was the path, its own cost from process
start to the first response byte (`gatewayMs`). The iPhone shows a computer as
"Slow to answer" when the load is more than four times its CPU count or the
gateway took over 1.5 seconds, keeping the last snapshot visible instead of
calling it unreachable.

### Offline reasons

When the Hook cannot reach this computer's Herdr or a linked peer, its error
response keeps the human `error` text and adds a stable `code`, so a client can
say why without matching sentences. A remote Hook's code travels on unchanged
through the peer that asked it. The same `code` appears on unreachable rows in
`/v1/health/details` `peers` and in `live_sessions`' `unreachable` list.

| `code` | Meaning |
| --- | --- |
| `herdr-not-running` | Herdr's socket does not exist: Herdr is not running. |
| `herdr-stale-socket` | The socket exists but nothing listens on it. |
| `herdr-permission` | The socket belongs to another user or is not a socket. |
| `herdr-unreachable` | Any other socket failure; the text names the errno. |
| `herdr-timeout` | Herdr accepted the request but did not answer in time. |
| `ssh-unavailable` | This computer could not start `ssh`. |
| `dispatch-key-missing` | This computer has no private dispatch key; run `phren bridge enroll-computer`. |
| `peer-offline` | SSH to the peer failed; the text keeps ssh's first line and exit code. |
| `peer-timeout` | The peer's Hook did not answer within the wait. |
| `peer-key-not-enrolled` | The peer refused this computer's dispatch key. |
| `peer-host-key-mismatch` | The peer's SSH host key does not match its pin. |

### Health and the canary

`GET /v1/health/details` answers whether phren is healthy on this computer, and
the phone's Settings → Health (or Health on a computer's page in Agents) shows one
section per computer from it. `phren status` prints the same data under Health.
It reports:

- `versions`: Phren Hook, Herdr, Claude Code, Codex, Copilot and OpenCode, each
  from `--version` (3 second limit, cached 5 minutes), or `missing` when absent.
- `stores`: each registered store's branch and ahead/behind against its upstream
  as last fetched (nothing is fetched), the last push outcome background sync
  recorded, and the failure while it is failing.
- `schedules`: whether the scheduler is ticking and the newest run in
  `schedule-runs.jsonl` (schedule name, project, status, reason, time).
- `peers`: every computer in `hooks.yaml`, probed through its verified Hook with a
  5 second limit. `listsBack` is false when that computer's own `hooks.yaml` does
  not list this one (matched by pinned host key or name), so a one-way link
  shows; it is null for a Hook too old to say.
- `push`: whether direct APNs is configured (`apns.json`).
- `canary`: the last `canary.json`.

Nothing in it is a secret, a file's contents or a store path.

`phren canary` (or `POST /v1/canary`) exercises the real paths once: it launches
a Claude conductor named `phren-canary` in a temporary folder through the same
launch path the phone uses, then closes that workspace and deletes the folder,
even on failure; checks that every `schedules.yaml` parses and the scheduler
ticked in the last two minutes (no schedule runs); reads one idle session's
transcript, read only; and lists live sessions everywhere, failing on an
unreachable computer. Each step records `ok`, `failed` or `skipped` with the
reason and duration in `canary.json` in the bridge directory. It never types into
an existing pane and never touches schedules or tasks. The Hook runs it once a
day when `PHREN_CANARY_DAILY=1` is in its environment or after
`phren canary --daily on` (`--daily off` stops it).

### Terminal approvals reach a closed phone

Some approvals have no hook behind them: an agent draws a numbered dialog in
its terminal (Claude Code's fallback prompts, Codex's command approvals,
OpenCode and Copilot dialogs). Every five seconds the Hook looks at each pane
that is waiting or blocked; when push is configured it reads that pane's
dialog and sends one notification per dialog ("Codex needs your approval"
with the dialog's text), whether or not a phone is watching. Approve from the
notification types the dialog's yes or allow row, Deny its no or deny row (or
Escape), after checking the pane still shows the same dialog. A pane that stops
waiting withdraws its notification; an answer after that is refused.

A permission the Hook held for the phone does not go dead when its 55-second
hold ends and the agent falls back to its terminal prompt. The Hook reads the
Yes and No rows the agent draws and keeps the request's own details (the
command, the tool's fields), so the tab stays marked as waiting on a permission
(`approvalPending` in `/v1/workspaces`) instead of plain "blocked". The
notification already on the phone keeps working for ten minutes: Approve or
Deny held on the lock screen (behind Face ID or the passcode) types that
dialog's row, and no second notification is sent. For Claude only the row's
digit is typed, since Claude takes a digit at once and an Enter after it could
land on the next permission. Tapping the notification opens the session's
details on the phone, led by the request, through `POST /v1/push/target`,
which names the session without answering it.

### Spoken replies for talk mode

The phone's talk mode reads an agent's replies aloud. `POST /v1/speech` with
`{ "text": "…" }` (1 to 2,000 characters, usually one sentence) voices the text
with ElevenLabs' `eleven_flash_v2_5` model and streams the audio back as raw
16-bit little-endian mono PCM at 24 kHz (`X-Phren-Audio:
pcm_s16le;rate=24000;channels=1`). The Hook advertises it as the `speech`
capability.

With `"timestamps": true` (the `speechTimestamps` capability) the Hook calls
ElevenLabs' `with-timestamps` endpoint instead and answers JSON: `{ "audio":
"<base64 PCM, same format>", "audioFormat": "pcm_s16le;rate=24000;channels=1",
"alignment": { "characters": [...], "starts": [...], "ends": [...] } }`, the
times in seconds from the start of the audio, or `alignment: null` when
ElevenLabs sent none. The alignment covers the words spoken, after the Hook
strips the reply's markdown, so `characters` joined is the spoken text. The
phone uses it to highlight the word being read in the chat.

The key is this computer's ElevenLabs key (see [the ElevenLabs key](#the-elevenlabs-key)),
used only in the request to ElevenLabs and never returned, even in errors.

The voice is, in order: the request's own `voice` (an ElevenLabs voice id the
phone picked), this computer's setting, else River (calm, neutral). Set it with
`phren bridge speech-voice set <voice-id>` (`show` prints it, `clear` removes
it); it lives in `~/.local/share/phren/bridge/speech.json`, is read on every
reply (no restart), and install and update leave it alone. The old
`PHREN_SPEECH_VOICE` environment override is still read when nothing is
stored, and copied into the setting then; `phren bridge update` also moves it
from the LaunchAgent, and keeps every environment key it doesn't manage.
`GET /v1/speech/voices` (capability `speechVoices`) answers `{ voice, source,
defaultVoice, voices: [{ id, name, category?, description? }] }` from the
account's ElevenLabs voices, for the phone's picker. Failures answer JSON with a
`code`: `speech-unconfigured` (503, no key), `speech-unreachable` (502),
`speech-rejected` (502, key refused), `speech-quota` (402), `speech-voice` (502,
unknown voice), `speech-invalid` (400), `speech-busy` (429) or `speech-failed`
(502). ElevenLabs' own error text is not passed on. When the phone hangs up, the
ElevenLabs request is cancelled. Each call is billed to that ElevenLabs account.
When the route fails, or the phone is offline, the phone uses its best
installed Apple voice.

The helper exposes a private Unix socket, not a public HTTP port. SSH keys stay
in the iPhone Keychain. Images and activity remain local to the computer; see the
[protocol and storage limits](../packages/cli/src/bridge/AGENT_CONNECTIONS.md).


### Dictation through ElevenLabs Scribe

When the phone's Settings > Voice > Input is ElevenLabs Scribe, dictation goes
through the computer the chat is on. `WS /v1/speech/transcribe` takes 16 kHz
mono 16-bit PCM as binary frames and relays it to ElevenLabs' `scribe_v2_realtime`
model with voice-activity commits, using the same ElevenLabs key as
`/v1/speech`. The query can carry `language` (an ISO 639 code) and up to 50
`keyterm` values, the phone's project vocabulary. The Hook answers with text
frames `{"type":"partial","text":…}` and `{"type":"committed","text":…}`; the
phone's one text frame, `{"type":"commit"}`, commits what's left when the
person stops. Errors arrive as `{"type":"error","code":…,"error":…}` with fixed
messages (`transcribe-unconfigured`, `transcribe-rejected`, `transcribe-quota`,
`transcribe-busy`, `transcribe-limit`, `transcribe-failed`), never ElevenLabs'
own text. A socket lasts at most ten minutes. The Hook advertises it as the
`transcribe` capability; each use is billed to that ElevenLabs account.

### The ElevenLabs key

Spoken replies and Scribe dictation use one ElevenLabs key per computer. The
Hook looks for it, per request, in this order:

1. `ELEVENLABS_API_KEY` in the Hook's environment. This is ElevenLabs' own
   variable, which its SDKs and the ElevenLabs MCP server (`elevenlabs-mcp`)
   read too.
2. `~/.local/share/phren/bridge/elevenlabs.json`, `{"apiKey": "…"}`, mode 600.
   Like `apns.json`, it is machine config: it never goes into the synced store,
   and a file other users can read is ignored.
3. Once, when that file doesn't exist: `elevenlabs_api_key` in
   `~/.config/mina-trailer.json`, the old location. The Hook copies it into
   `elevenlabs.json` with mode 600 and reads only the new file after that. The
   old file is left as it is.

The Hook runs as a LaunchAgent or systemd service and doesn't see your shell's
environment, so store the key in the file:

```sh
phren bridge speech-key set            # paste the key; it isn't echoed
printf %s "$ELEVENLABS_API_KEY" | phren bridge speech-key set
```

The key is read from stdin, never from the command line, so it stays out of
`ps` and shell history. To use one key for phren, the SDKs and an MCP server,
export `ELEVENLABS_API_KEY` in your shell profile and pipe it into
`phren bridge speech-key set` once, as above. `phren doctor` (the `speech-key`
check) and `phren bridge doctor` (`speechKey`) say whether this computer has a
key and where it comes from, without showing it. Neither route changes the
`speech` and `transcribe` capabilities: a computer without a key still offers
them and answers `speech-unconfigured` or `transcribe-unconfigured`.
