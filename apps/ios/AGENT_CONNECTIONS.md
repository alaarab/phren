# Phren Hook connections

Phren Hook is the computer-side service shipped with `@phren/cli`. The iPhone
connects over SSH with a separate device key and a pinned host key. There is no
third-party gateway dependency or public listener.

## Transport and identity

`phren bridge install` copies a self-contained Node bundle into
`~/.local/share/phren/bridge/versions/<version>` and activates it through a stable
`current` link. A LaunchAgent or systemd user service owns its lifetime.

The restricted SSH dispatcher accepts `phren-hook v1 pipe`,
`phren-hook v1 terminal <server>`, and `phren-hook v1 web <host> <port>`.
The pipe relays HTTP/WebSocket bytes to a mode-0600 Unix socket in a mode-0700
directory. Terminal attaches an existing Herdr server through an SSH PTY.
The web command relays bytes only to the literal loopback address `127.0.0.1`
or `::1` and a decimal TCP port from 1 through 65535. Supplied commands are
never executed as shell text. Device keys keep SSH's `restrict` option and
explicit PTY permission; generic SSH forwarding stays disabled.

Local web previews use a separate authenticated HTTP CONNECT proxy on a random
iPhone loopback port. Its remote connection uses the allowlisted web command
over pinned SSH. Each preview has a fresh credential; requests without it never open
a remote channel. WebKit receives that credential through its private data
store's proxy configuration, not page JavaScript or a query parameter.

The health/workspace response identifies `product: phren-hook`, protocol 1, the
helper version, a durable computer ID, and capabilities. Mutating agent requests
carry the complete server/workspace/tab/pane/provider/conversation tuple. The
helper checks a fresh Herdr snapshot and the pane's session identity before
input. It never falls back to the focused pane or newest transcript. The iPhone
also checks its saved host UUID and pinned host key before connecting.

Known limitation in Herdr 0.8.2 / protocol 20: `agent.prompt` and
`agent.send_keys` accept a pane target but no expected conversation identity.
Validation and dispatch are separate RPCs. Replacing the pane's conversation
between them can therefore redirect input. Rechecking cannot eliminate this
race; an atomic expected-session check inside Herdr is required. The Hook never
automatically retries a prompt whose delivery is uncertain.

Rechecked on 2026-09-11: the installed binary still reports 0.8.2 / protocol 20.
Released Herdr 0.9.0 also lacks this support: its
[agent parameter definitions](https://github.com/herdrdev/herdr/blob/v0.9.0/src/api/schema/agents.rs)
accept only `target`, `text`, and optional `wait` for prompts, and `target` and
`keys` for keystrokes. Its
[target resolver](https://github.com/herdrdev/herdr/blob/v0.9.0/src/app/terminal_targets.rs)
uses the current pane or agent name. Upgrading to that release does not close
this gap. Supplying an invented expected-session field is ineffective.

Task `d78a0916` remains open. Its prompt and stop replacement-race cases in
`packages/cli/src/bridge/bridge.test.ts` are executable expected failures: the
fixture replaces the conversation when Herdr receives the mutation, after all
snapshot checks, and records the actual recipient. An unexpected pass fails the
suite so the case can become a normal regression when the limitation is fixed.

Closing the task requires the following upstream contract and client checks:

- Herdr must accept the caller's expected provider and native conversation ID
  (or an opaque conversation-generation token supplied with the snapshot) on
  both prompt and key requests. Pane and terminal IDs alone are insufficient:
  an existing terminal can start a new conversation.
- Herdr must compare that expectation while committing input to the same live
  agent runtime. A mismatch, missing identity, replaced process, or changed
  conversation must reject the request before any text, Enter, or Escape is
  written. Queued and delayed prompt submission must preserve that binding.
- Support must be discoverable from the running server, including named
  servers. The Hook must send the expectation only under that supported
  contract and never silently fall back to an unguarded mutation after a
  rejection. Any unsupported capability must be explicit to the client.
- Regression tests must cover replacement between snapshot and dispatch,
  replacement before queued input is written, same-provider replacement in an
  unchanged terminal, absent identity, rejection without writes, successful
  delivery to an unchanged conversation, and no retry after an uncertain reply.

Herdr's public newline JSON socket API provides snapshots and targeted controls.
Conversation identity comes from a reported Herdr session ID, a transcript file
descriptor held by the foreground process, or a Phren lifecycle callback bound to
that terminal and process. Directory names are for project association only.

## Conversation protocol

- `GET /v1/health`, `/v1/muxes`, `/v1/workspaces`, `/v1/workspaces/panes`
- `WS /v1/transcripts`: backlog, append, and older frames with provider JSON rows
  and stable line numbers. History requests include `beforeLine`.
- `GET /v1/transcripts/history`: the same exact target tuple plus a positive
  `beforeLine`, returning one older page without first reading the latest page.
- `WS /v1/status`: exact-conversation activity, pending approval, and capabilities.
- `POST /v1/prompt`, `/v1/keys`, `/v1/upload`, `/v1/diff`
- `POST /v1/approvals/answer`: one exact pending callback, with approve or deny.
- `GET /v1/transcripts/blob`: bounded images from an exact transcript row/block.
- `POST /v1/workspaces/{create,rename,focus,close}` with an explicit server.
- `GET /v1/web-servers`, `/v1/activity`

Transcript readers retain bounded pages, wait for complete JSONL rows, detect
truncation/rotation, skip individual legacy rows over 64 MiB, exclude private reasoning and sidechain messages, and close
when a live conversation identity changes. Reconnection sends a fresh backlog;
the app merges by stable line identity. Input is attempted once. A missing reply
never triggers an automatic resend. Usage comes from actual provider events.

Frames include `type`, `source`, `session`, `entries: [{line, raw}]`,
`totalLines`, `startLine`, `hasMore`, and optional `reset`. Lines are absolute,
zero-based JSONL row numbers; `beforeLine` is exclusive. Metadata-only pages
still advance `startLine`; clients continue until a visible message or the end.
History requests are bounded and queued during a busy WebSocket poll. Newer
clients use the HTTP history route, falling back to WebSocket only on 404.
Abort/rotation releases outstanding reads. A shared sparse byte index avoids
repeatedly parsing whole transcripts; its LRU holds at most 32 files. The app
keeps a 4,000-message / 12 MiB window and can page backward past that window;
the Latest action restores recent history after older paging evicts it.

The chat stream replaces recognized embedded image blocks with placeholders,
including images inside structured tool results. Original transcript rows remain
unchanged for image retrieval; text and arbitrary tool arguments are preserved.
The app also checks the normalized message count before expanding a Claude row:
more than 4,000 visible blocks in a frame produces an explicit error while
preserving loaded history. It waits for an explicit reconnect or session change
instead of repeatedly decoding the rejected frame. Full tool output is presented
in pages of at most 120 display lines or 4,000 characters, with the complete text
retained for navigation and Copy.
Expanded semantic diffs likewise render at most 120 rows at a time within a
scrolling page; their existing parser limit and full-patch Copy are unchanged.

Provider lifecycle and usage examples live in
`PhrenKit/Tests/PhrenKitTests/Fixtures/hook-events.json`; both Swift and the
bundled Hook's tests read this file. Add provider variants there when extending
the allowlist or parser. Current activity overrides older historical working
events. Token details describe the latest reported model response: Codex's
input includes cached input; Claude's raw input, cache reads, and cache writes
are added to obtain total input. Reasoning tokens, when reported, are included
in output. These counts are neither account quota nor conversation totals.

SSH terminal receive credit follows rendered bytes. Terminal output has a
bounded buffer and supports cancellation without closing remote shells. The
app's existing terminal gestures, keyboard dock, and reconnect policy apply.

## Local agent callbacks

Codex and Claude callback configuration preserves other hooks and includes
SessionStart, UserPromptSubmit, Stop, and PermissionRequest. Copilot callbacks
register SessionStart and UserPromptSubmit. They use a separate `agent.sock`
that the phone's dispatcher cannot reach. Callbacks never create agents.

Phren waits for an approval while the exact conversation is watched, or while
the foreground overview explicitly renews its 25-second watch with
`watchApprovals=1`. Ordinary overview reads do not hold requests. Without a
watcher or service, the agent continues its normal permission workflow.
An unanswered callback returns no decision after 55 seconds. The user can grant
or decline the current action; it never installs an always-allow rule. Codex
requires review of new hook definitions in `/hooks`. Existing sessions may need
to resume to load their provider's hook configuration.

Pending tabs expose `approvalPending`; exact status frames include `expiresAt`.
The chat keeps its permission explanation, Open terminal, and Deny/Approve
controls above the composer. Requests received in chat can also create a Live
Activity: actions authenticate and open the app before using its protected SSH
key. The widget receives display text and an opaque local ID, while a private
protected record binds the host, pane, conversation, action and expiry. Claims
are consumed before sending and never automatically retried. New requests while
iOS suspends the app require a push relay; this integration does not supply one.

Question dialogs and unsupported interactions stay in Phren's native terminal.
The protocol reports these capabilities explicitly. No blind terminal keystrokes
are used to answer a provider's structured approval.

Primary provider contracts:
[Codex hooks](https://developers.openai.com/codex/hooks),
[Claude hooks](https://code.claude.com/docs/en/hooks), and
[Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference).
Herdr's installed `herdr api schema --json` is the control contract (protocol 20
was used for validation).

## Storage and migration

Recognized `phren-iphone` restricted keys gain the new dispatcher and PTY access,
with a timestamped backup and a concurrent-change check. Migration removes
`port-forwarding` and `permitopen` options. OpenSSH's
[Unix-socket forwarding handler](https://github.com/openssh/openssh-portable/blob/master/serverloop.c)
also accepts keys granted generic forwarding; TCP `permitopen` constraints do
not isolate private Unix sockets. Other keys and custom forced-command policies
are untouched, and quoted option contents are preserved.

After deploying a CLI build with these changes, run `phren bridge install` on
each computer to update both the helper and recognized authorization lines.
Replacing a device key line alone does not update an old helper. The app checks
`capabilities.webPreview == "ssh-exec"` before opening a preview and gives an
explicit update instruction for older helpers, including released 0.2.14 builds
without that capability. Existing authorizations remain permissive until this
migration runs; merely updating the app does not change remote keys. Active SSH
connections retain the options negotiated at authentication, so reconnect after
migration. These source changes do not deploy or restart a running service.
The iPhone keeps its host/keychain identities, store mappings, and drafts. Old
external-app preferences are ignored. Existing third-party helpers remain intact.

Uploads are private, validate common image headers, cap individual images at
8 MiB and total retained storage at 256 MiB, and expire after 14 days when another
image is uploaded. The local activity journal retains two files of roughly 2 MiB
and contains status/provenance, not prompts or transcript text. Uninstall leaves
local data and SSH backups available for manual recovery.

Chat drafts use an ordered actor repository. Immutable image digests are
computed once; text edits avoid rescanning or rewriting unchanged image files.
Per-target revisions reject delayed writes after a newer save or clear.
Backgrounding and switching conversations flush the captured target's draft.
Custom themes use a versioned collection and preserve unreadable or newer
schema bytes under a recovery key before accepting edits.

Web previews retain the remote port under `phren-preview.localhost`, so relative
CSS, scripts, uploads, and WebSockets share the app origin. Deliberate links to
unrelated pages open outside the privileged WebKit view. Apps that hardcode a
different origin or depend on local TLS certificates may need their development
server's public/base URL configured for the preview origin.

## Verification

Build the CLI before running `packages/cli/src/bridge/bridge.test.ts`. It starts
the real bundled service with disposable Unix sockets and synthetic provider
logs, checks strict target validation, stream append/rotation, image boundaries,
private callback isolation, and stale approval rejection. No Moshi helper is used.
`packages/cli/src/bridge/security.test.ts` also checks key restriction migration,
loopback preview dispatch and rejection of injected destinations, and malformed
WebSocket upgrades that must leave the helper available.

`PhrenLive` tests cover pinned SSH, protocol handling, cancellation, web previews,
and byte bounds. `PhrenHookEndToEndTests` can target a disposable local sshd and
named `phren-hook-standalone` Herdr server via `PHREN_HOOK_SSH_FIXTURE`. Its input
is restricted to a workspace the test creates and closes.

Run `phren bridge doctor` on each deployment computer. A passing Mac check does
not establish that a second computer has installed the service.
