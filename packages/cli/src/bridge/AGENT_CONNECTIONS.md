# Phren Hook agent connections

Phren Hook is a local daemon installed separately with `phren bridge install`.
The iPhone reaches its private HTTP/WebSocket Unix socket through a forced-command
SSH key. Protocol version 1 and the existing phone message shapes are preserved.
The daemon does not log requests, prompts, transcripts, or tool arguments, and it
does not read or forward provider sign-in credentials. Account usage comes from
agent-reported limits and local usage snapshots.

## Transport and trust boundaries

The recognized Phren device key uses `restrict,pty` and the installed dispatcher.
Generic SSH forwarding is disabled. The dispatcher accepts only:

- `phren-hook v1 pipe`: byte relay to `hook.sock`.
- `phren-hook v1 terminal <server>`: an existing Herdr terminal through SSH PTY.
- `phren-hook v1 web <127.0.0.1|::1> <port>`: byte relay to **any loopback TCP
  port** from 1 through 65535. This is not limited to discovered HTTP servers;
  the key holder can reach other services listening on those ports.

Server names use `^(?!\.\.?$)[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$` and are encoded
in binding paths. The dispatcher and service pin the same `PHREN_BRIDGE_HOME`
and `PHREN_HERDR_HOME`. The service sets umask 0077; launchd also sets `Umask` 63.
The bridge root is 0700, sockets and state files are 0600, and the installer
pre-creates `service.log` with mode 0600.

`agent.sock` is separate from the phone pipe. Local agent callbacks register
process/terminal bindings, record before/after shell changes, and request watched
approvals. **This is a same-user trust boundary:** another local process running
as the user can call this socket and record changes under another conversation's
key. The process checks establish the pane's foreground processes, not the
identity of the process sending the callback. Local transcript files, agent
configuration, and binaries also remain under that user's control.

## Conversation identity and delivery

Targets contain `server`, `workspace`, `tab`, `pane`, `source`, and `session`.
The full target must match a current Herdr pane. Identity comes from Herdr's
explicit session ID, foreground processes' open transcript descriptors, or a
lifecycle binding to the same terminal and foreground PIDs. A folder or recently
modified transcript never selects the conversation.

Descriptor-based identities are cached for about two seconds per server, pane,
terminal ID, provider, and PID set; concurrent lookups share the same work.
Sending checks bypass the cache. At most 16 WebSocket clients remain connected;
a seventeenth closes the oldest client.

After `agent.prompt` returns, the Hook takes a fresh snapshot and rechecks
`paneIdentity`. A mismatch or unavailable check returns
`{ "ok": true, "deliveryUncertain": true }`. It never retries. Herdr resolves the
pane occupant at dispatch time, so this reports uncertainty after a race; it
cannot make delivery atomic with validation. Escape/stop retains Herdr's existing
contract.

## Routes

All ordinary routes use the private HTTP pipe; transcript and status streams use
WebSockets on the same socket.

| Route | Purpose and boundary |
| --- | --- |
| `GET /v1/health` | Protocol, capabilities, computer identity. |
| `GET /v1/muxes` | Running Herdr servers. |
| `GET /v1/workspaces`, `/v1/workspaces/panes` | Workspace overview, pane identity, context, branch, activity and watched approvals. |
| `POST /v1/workspaces/launch` | Create a workspace/tab and start the selected agent. |
| `POST /v1/workspaces/create`, `/focus`, `/rename`, `/close` | Existing workspace actions. Creation uses the same launch admission limits. |
| `GET /v1/projects/locate` | Existing project candidates from activity, Herdr, store registration and local search roots. |
| `GET /v1/activity`, `/v1/usage` | Activity metadata and agent-reported account limits. |
| `WS /v1/transcripts`, `/v1/status` | Bounded transcript backlog/tail/history and live status. |
| `GET /v1/transcripts/history`, `/v1/transcripts/blob` | Target-bound older rows and separately requested original embedded images. |
| `POST /v1/prompt`, `/v1/keys` | Send text or Escape after validating the live destination. |
| `POST /v1/upload` | Bounded file/image upload under the selected conversation. |
| `GET, POST /v1/files` | List/store files sent by the phone outside any conversation. |
| `GET /v1/uploads/image` | Bytes of one image the phone uploaded, by absolute `path`; only a real file inside the Hook's own uploads folder whose bytes are an image, at most 8 MiB. |
| `POST /v1/diff` | Pane repository diff and authorized optional `paths`, grouped by repository. |
| `GET /v1/web-servers` | Discover local web servers; discovery does not constrain the SSH web relay. |
| `GET /v1/simulators`, `/v1/simulators/apps`, `/v1/simulators/screenshot` | Booted simulators, installed apps and a selected device screenshot on macOS. |
| `POST /v1/simulators/action` | Validated simulator lifecycle, launch, URL, tap, home/lock and text actions. |
| `POST /v1/approvals/answer` | Answer an exact, live watched approval request. |
| `POST /v1/questions/answer` | Existing unsupported-question response; answer in the terminal. |

Creation resolves `cwd` with `realpath`, requires an existing directory under the
user's real home or within a `locateProject` candidate, and sends the resolved
path to Herdr. At most one creation/launch is in flight, and at most six attempts
are admitted per minute; excess requests return HTTP 429.

`/v1/diff` accepts extra `paths` only within the pane repository, the phren store,
the conversation's locally recorded `phren_changes` roots/paths, or paths found
by `namedPaths()` in local shell-tool command rows of that conversation. The
phone cannot supply its own command as authorization. Paths resolve through
symlinks before scope checks; deleted paths resolve through their nearest
existing parent. Relative Git pathspecs starting with `:` are rejected, and
file paths passed to Git are literal pathspecs. Merely being somewhere under home
does not grant access to a second repository. Diff responses contain file patches,
not just status/provenance.

Uploads remain limited to 8 MiB each, 256 MiB total, and 14-day retention. Image
extensions require matching image bytes. Files are stored in private bridge
upload folders with generated names.

## Transcript export

Public user/assistant text, tool calls/results, lifecycle events, and usage keep
their provider shapes, including `type` and `message.content` blocks. Private
reasoning and sidechain messages are excluded. Image blocks keep their positions
and types; bytes are fetched separately through the target-bound blob route.
This is not a general content-secret scanner: ordinary public text, tool inputs,
and tool-result content can still contain file contents or sensitive text.

Claude top-level fields are allowlisted: `type`, `uuid`, `parentUuid`, `timestamp`,
`message`, `gitBranch`, `cwd`, `requestId`, `isMeta`, `isSidechain`,
`isCompactSummary`, `phrenQueued`, `phrenQueueKey`, and `phrenBackground`, plus
fields added by the exporter. Provider metadata such as `toolUseResult`
(including original files), `permissionMode`, and `wireToolInputs` is dropped.
Codex `event_msg.error` payloads export only `type` and string `message`.

Codex response-item user messages and Claude string-content user rows are
excluded when their trimmed text starts with `<environment_context>`,
`<user_instructions>`, `<permission_profile`, `<system-reminder>`, or
`<turn_context>`. A mention later in ordinary text does not hide the turn.

Claude queue messages preserve these phone markers:

- `phrenQueued: true` and `phrenQueueKey`: only an ordinary enqueue whose trimmed
  content does not start with `<` becomes a user bubble. Internal XML-like
  queues, including cross-session messages, do not become the person's bubble.
- `type: "phren_queue_consumed"`: every string-content removal emits only its
  SHA-256 content key and timestamp, including internal removals. The key scheme
  is unchanged.
- `phrenBackground: true`: task notifications become system rows whose user-role
  string content is a rebuilt `<task-notification>` block. Only direct
  `task-id`, `tool-use-id`, `status`, and `summary` tags survive; summaries are
  capped at 500 characters and other values at 200. The full original envelope
  is never forwarded: `output-file`, `result`, `usage`, `diagnostics`, and
  `worktree` are dropped. This is a small allowlisted status/summary envelope,
  not a size-limited copy of subagent output.

## Shell changes and local storage

`phren_changes` attaches an object keyed by tool-use ID to shell-result rows.
Each value is an array of `{ root, path, status, added, removed, patch }`, with
optional `redacted: true`. These are before/after working-tree patches and can
contain source text. For secret-looking basenames and Git binary files, `patch`
is empty and `redacted` is true; names, status and line counts remain visible.
The guard covers `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`,
`*.p12`, `*.pfx`, `*.keychain-db`, `credentials.json`, `*.credentials.json`,
`.netrc`, `.npmrc`, `.pypirc`, and `*.tfstate`. Loaded legacy records are also
validated and redacted before export.

The Hook copies the repository index into a per-repository scratch folder under
the bridge root. `GIT_OBJECT_DIRECTORY` points there for add, write-tree and
diff; the real object directory is a read-only alternate. Capturing untracked
files does not create unreachable blobs or trees in the repository. Scratch
objects are deleted after diff computation or cancellation; abandoned snapshots
expire after 30 minutes, and startup removes scratch from previous runs.
Git work uses a two-process pool and AbortSignals with a 2.5-second hook budget.
Unavailable or over-budget snapshots are omitted without blocking the agent.

`changes/*.jsonl` is retained for at most 30 days and 256 MiB total, pruned at
service startup and daily. Each conversation file is bounded to 16 MiB. Loaded
rows are Zod-validated as `{ toolUseId: string, files: ChangedFile[] }`; malformed
rows are skipped. An LRU holds at most 16 conversations and their load state.
Tab activity persists SHA-256 signatures instead of titles/labels, preserves
change timestamps, migrates old plaintext signatures, and prunes entries for
servers absent from each activity pass.

## Simulator confinement

Simulator lifecycle and discovery use `/usr/bin/xcrun`; the native helper is
compiled with `/usr/bin/swiftc`. Touches and keys require the user to grant the
helper Accessibility access in macOS System Settings. The helper identifies the
Simulator application and its device window, raises that window, and checks
before **every** event that Simulator is still the frontmost application.
Every mouse/key event uses `postToPid(app.processIdentifier)`; no event uses the
system-wide HID event tap. Losing focus fails with `focus lost`.

Hook input invocations and builds are serialized. Text is capped at 500 UTF-16
code units; C0 controls and DEL are rejected, except newline with explicit
`submit: true`. The optional submit field authorizes newlines in the supplied
text; it does not implicitly append one. Launch bundle IDs cannot start with
`-`; unknown actions return HTTP 400.

Builds write `simtap.<uuid>` before an atomic rename to `simtap`, chmod the
binary 0700, and record `{ sourceSha, binarySha }` in its sidecar. The Hook hashes
the binary again immediately before each execution and rejects a mismatch.
This check and PID confinement do not establish a security boundary against
another process running as the same local user.
