# Phren Hook

Phren Hook connects the Phren iPhone app to agents already running on your
computers. It is part of the open-source Phren CLI and runs independently of
other phone or terminal applications.

## Install on each computer

Requires macOS or Linux, Node 20 or newer, Herdr, SSH, and `lsof`. Linux uses a
systemd user service; macOS uses a LaunchAgent in your signed-in user session.

```sh
npx --yes @phren/cli@0.3.0 bridge install
npx --yes @phren/cli@0.3.0 bridge doctor
```

Keep Tailscale connected on the iPhone and computer for remote access. Funnel and
public ports are unnecessary. In Phren, add the computer under Agents, copy its
SSH authorization line, add it to that user's `~/.ssh/authorized_keys`, then
verify the computer's SSH fingerprint. Existing Phren device keys are migrated
with a backup by the installer.

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
helper instead of reinstalling the published package:

```sh
pnpm --filter @phren/cli build
node packages/cli/dist/index.js bridge install
node packages/cli/dist/index.js bridge doctor
```

Install the helper on every connected computer before updating the phone app.
The installer restarts its user service and preserves existing authorization and
agent configuration. Review new or changed Codex hook definitions in `/hooks`;
Phren does not bypass Codex's trust checks for interactive sessions. Scheduled
headless Codex runs are the documented exception: they pass
`--skip-git-repo-check` and write `trust_level = "trusted"` for the project
directory into `config.toml` (see [schedules](schedules.md)).

## What connects

Workspace snapshots optionally include `contextUsedPercent` for a tab with one
verified Codex agent. The helper reads the latest reported token count and
context-window limit from a bounded transcript tail, caches unchanged files,
and limits concurrent lookups. Optional enrichment returns partial results after
1.5 seconds; later requests omit metrics while the bounded pending work drains.
Missing limits, ambiguous panes, and unavailable observations omit the metric.
No extra request per iPhone row is needed.

- Codex, Claude Code, and Copilot conversations, with exact pane/session identity.
  The experimental phren-agent is wired the same way (its `.runtime/sessions`
  event log is the transcript, and it reports SessionStart/UserPromptSubmit/Stop
  to the Hook itself) and switches on once Herdr reports the `phren` agent kind.
  opencode is supported too: its session ids are `ses_…`, identity comes from
  Herdr's opencode integration, and a Phren-installed opencode plugin mirrors the
  session into the same `.runtime/sessions` event log.
- Chat history, incremental transcript updates, real token counts, image uploads,
  stop, and project context from Phren's memory and skills.
- Native Herdr terminals, named servers, workspaces, tabs, and pane navigation.
- Without Herdr: "Open a terminal instead" starts a shell or the chosen agent
  straight over SSH in the project folder. Terminal only; it ends with the
  connection and has no chat, transcript, or approvals.
- Codex/Claude approvals through Phren's lifecycle callbacks while you watch a
  conversation or the foreground session overview. Codex asynchronous questions
  can be answered in chat when the installed Codex supports its exact-thread
  inbox command (`codex queue --thread … --message …`). Synchronous questions
  and unsupported provider interactions open in Phren's terminal.
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
provides the action ID, input and expiry. Requests wait at most 55 seconds, then
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

## Maintain and diagnose

```sh
npx --yes @phren/cli@0.3.0 bridge status
npx --yes @phren/cli@0.3.0 bridge update
npx --yes @phren/cli@0.3.0 bridge rollback
npx --yes @phren/cli@0.3.0 bridge uninstall
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

The key is this computer's ElevenLabs key (see [the ElevenLabs key](#the-elevenlabs-key)),
used only in the request to ElevenLabs and never returned, even in errors. The voice is River (calm, neutral); set `PHREN_SPEECH_VOICE` in the
Hook's environment to another ElevenLabs voice id. Failures answer JSON with a
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
