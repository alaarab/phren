# Phren Hook connections

Phren Hook is the computer-side service shipped with `@phren/cli`. The iPhone
connects over SSH with a separate device key and a pinned host key. There is no
third-party gateway dependency or public listener.

## Transport and identity

`phren bridge install` copies a self-contained Node bundle into
`~/.local/share/phren/bridge/versions/<version>` and activates it through a stable
`current` link. A LaunchAgent or systemd user service owns its lifetime.

The restricted SSH dispatcher accepts `phren-hook v1 pipe`,
`phren-hook v1 terminal <server>`, `phren-hook v1 shell <base64url folder> [agent]`,
and `phren-hook v1 web <host> <port>`.
The pipe relays HTTP/WebSocket bytes to a mode-0600 Unix socket in a mode-0700
directory. Terminal attaches an existing Herdr server through an SSH PTY. Shell
needs no Herdr: it starts a login shell, or one of codex/claude/copilot/opencode,
directly on the SSH PTY in a folder that passes the workspace-creation rules
(under home or a located project); the phone offers it when no Herdr server is
running. It is terminal-only, ends with the connection, and has no chat identity.
The web command relays bytes only to the literal loopback address `127.0.0.1`
or `::1` and a decimal TCP port from 1 through 65535. This reaches any loopback TCP
listener on the computer, not only web previews, so the device key is worth as
much as a local login (the terminal command already grants one). Supplied
commands are never executed as shell text. Device keys keep SSH's `restrict` option and
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
When Codex holds parent and subagent logs in one process, the lifecycle binding
selects its conversation only if that conversation is among the open logs.
Unbound or conflicting identities remain unavailable for chat and attachments.

## Conversation protocol

- `GET /v1/health`, `/v1/muxes`, `/v1/workspaces`, `/v1/workspaces/panes`
- `GET /v1/projects/locate?project=<name>`: where the project lives on that
  computer (activity journal, Herdr's saved workspaces, phren's registration,
  search roots), existing folders only.
- `GET /v1/projects/repos` and `POST /v1/projects/add`: "Add project", the
  computer's untracked checkouts, and enrolling one (or cloning a GitHub URL)
  with `phren add` there; the computer pushes its store so the phone can pull.
- `GET /v1/projects/files?project=<name>&directory=<located folder>&path=<relative path>`:
  browse a discovered checkout read-only. Roots are revalidated on every request;
  traversal, symlinks, `.git`, and special files are refused. Listings have at most
  500 entries and file responses contain at most 2 MiB of content, base64 encoded.
- `GET /v1/models?source=<harness>`: the computer's model catalogue. Claude
  reads its newest cached terminal catalogue, filters by installed client
  version and retains names, order and default. Codex uses app-server and
  OpenCode uses its model command. Results are cached for ten minutes.
- `/v1/code/*`: registered-store symbol reads, tree summaries, paged usage,
  recent changes, reindexing and line notes. Session entry points keep their
  explicit note recipient. See the [route table](../../docs/api-reference.md#hook-routes).
- `POST /v1/git/tree`: one directory with descendant file counts and a snapshot
  version. The bounded cache expires after two seconds; status refresh and
  mutations invalidate it. The phone retains expanded paths and loaded children.
  `ignored: true` (the Show ignored switch) adds git-ignored entries, marked.
- `POST /v1/git/worktrees`: the repository's other worktrees with branch, commits
  ahead, uncommitted files and the worker editing there when known. The phone
  sends a row's `id` back as `worktree` on the git routes, `/v1/diff` and
  `/v1/files/range`; the computer resolves it only against its own listing.
- `WS /v1/transcripts`: backlog, append, and older frames with provider JSON rows
  and stable line numbers. History requests include `beforeLine`. Live preview
  frames carry `{preview: {turnStartedAt, text}}` or `{preview: null}` without
  entering history or advancing its cursor. Claude reads anchored pane text;
  Codex/OpenCode read deltas, with updates capped at twice a second. A final
  entry clears its preview immediately.
- `GET /v1/transcripts/history`: the same exact target tuple plus a positive
  `beforeLine`, returning one older page without first reading the latest page.
- Provider `source` values: `codex`, `claude`, `copilot`, `phren` (the
  experimental phren-agent, its `session-<uuid>.events.jsonl` under the store's
  `.runtime/sessions` is the transcript; active once Herdr labels the pane `phren`),
  and `opencode`, session ids are `ses_…`, and the Phren-installed opencode
  plugin mirrors its session to `opencode-<session>.events.jsonl` in the same
  event shape phren-agent uses. opencode loads plugins at startup, so a session
  started before the install has no transcript or session id until restarted.
- `WS /v1/status`: exact-conversation activity, pending approval, capabilities,
  and the pane's current git `branch` (read on the computer, cached ~10s).
  The model name comes from the transcript instead: Claude rows carry
  `message.model` and `gitBranch`; Codex `turn_context` rows are exported
  with only their `model`.
- `POST /v1/prompt`, `/v1/keys`, `/v1/upload`, `/v1/diff`
- `POST /v1/model`: verified model selection by `{ target, model, effort? }`.
  Codex walks its model and effort menus; Claude uses its alias command.
  OpenCode returns a clear refusal directing the person to `/models` in the
  terminal. Working panes reject model changes and all slash prompts with 409,
  except Claude's `/btw <question>`, whose answer arrives on the live
  transcript socket (opened with `sideAnswers=1`) as a `side-answer` frame and
  shows on a card above the composer. `POST /v1/side-question/dismiss` cancels
  or forgets one.
  The phone can hold a cancellable selection until idle and shows successful
  switches as system rows without adding a user message.
- Working harnesses accept steering immediately through the validated prompt
  route. Queue captions come from Codex or Claude transcript records. A local
  pending bubble names Disconnected, Starting or Holding a prompt; it sends
  when that blocker clears, even while the harness works.
- `POST /v1/approvals/answer`: one exact pending callback, with approve or deny.
  When the pending tool is Claude Code's `AskUserQuestion`, approve with
  `updatedInput`, the request's own input plus `answers` keyed by question
  text (a label; labels for multiSelect; any other string is a typed "Other")
  and an optional free-text `response`, and the hook allows the call with
  that input. The questions themselves must be unchanged.
- `GET /v1/transcripts/blob`: bounded images from an exact transcript row/block.
- `GET /v1/uploads/image?path=`: the bytes of an image the phone uploaded, which a
  Claude transcript names only by path (`[Image: source: …]`); the Hook serves it
  only from inside its own uploads folder.
- `POST /v1/workspaces/{create,rename,focus,close}` with an explicit server.
- `POST /v1/workspaces/launch`: `{cwd, label, kind, workspaceId?, name?, timeoutMs?}`
  creates a workspace (or a tab in `workspaceId`) in `cwd`, starts `kind`
  (codex/claude/copilot/opencode) in its pane and waits for Herdr to detect it; returns
  `{workspaceId, tabId, paneId, agent, agentStatus?, sessionId?}`. The session
  id is normally still unknown at that point; poll `/v1/workspaces/panes`.
- Launch also accepts the conductor role, model and effort; an existing local
  conductor returns 409 with its target. Remote work retains verified computer
  identity and routes through the phone's own enrollment on that computer.
- `GET`, `POST`, `DELETE /v1/conductor/grants`: standing dispatch and hand-off
  authorizations. Revocation includes the expected row to reject stale edits.
- `GET /v1/web-servers`, `/v1/activity`
- `GET /v1/usage`: account-limit percentages, reset times, and provider spend,
  grouped by provider.

Account usage is separate from conversation token counts. Codex uses the installed
CLI's read-only `account/rateLimits/read` app-server method; Phren initializes that
connection without creating threads or turns, caches results for one minute, and
never exports credentials. All reported limit buckets retain their window lengths.
Claude uses the documented `rate_limits` status-line payload. Installation wraps
and preserves any existing status-line command, options, input, and output. The
observer stores only percentages, reset times, and the observation timestamp in a
private file; data first appears after Claude replies with subscription limits.
Old observations and passed reset times remain labeled as last reported instead
of being presented as a fresh zero. An unavailable account stays unavailable.
OpenCode cost comes from its local `stats --days 7` ledger and is summed across
computers. If OpenCode has an OpenRouter key, the Hook also reads that key's live
`usage_weekly` value from OpenRouter. The key never leaves the computer except in
the request to OpenRouter; only its one-way fingerprint is returned so the phone
does not count a shared key twice. OpenRouter defines this as the current UTC
calendar week, while OpenCode's total is the rolling past seven days.

Provider contracts: [Codex app server](https://learn.chatgpt.com/docs/app-server),
[Claude status line](https://code.claude.com/docs/en/statusline), and
[OpenRouter current-key usage](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key).

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

Terminal toolbar and Ctrl-panel customization use separate versioned preference
documents. Panel preferences preserve inactive panels and shortcuts, migrate the
legacy Favorites list, validate all bindings before sending, and retain unreadable
data until the user explicitly restores defaults. Modifiers, named/function keys,
literal text, and multi-step bindings compile to bounded terminal input. Only an
explicit Enter key or auto-Enter setting submits. Multi-step shortcuts run in
order with a short delay and cancel when the panel disappears or disconnects.
Editing and previewing never send input. Named keys use xterm sequences, with
CSI-u to distinguish modified special keys such as Shift+Enter.

Interaction reference: [Moshi shortcut builder](https://getmoshi.app/docs/keyboard).
Key encoding reference: [terminal keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).

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
or decline the current action. Conductor permission cards can also explicitly
save project or global standing grants for dispatch and hand-off. Codex
requires review of new hook definitions in `/hooks`. Existing sessions may need
to resume to load their provider's hook configuration.

Pending tabs expose `approvalPending`; exact status frames include `expiresAt`.
The chat keeps the provider's asking sentence and ordered phren option rows
above the composer, with arguments folded under Action details and terminal
access in the header. Terminal choices retain their real labels, descriptions
and keys; unresolved prompts offer Open terminal. The foreground overview also resolves pending tabs
to every exact agent pane and reads their authenticated status, so a permission
can create a Live Activity without first opening its chat. These bounded reads
cancel when foreground polling stops and never answer a request.
Requests received in chat or the overview can create a Live Activity: actions
authenticate and open the app before using its protected SSH key. The widget
receives display text and an opaque local ID, while a private protected record binds the host, pane, conversation, action and expiry. Claims
are consumed before sending and never automatically retried. New requests while
iOS suspends the app use direct Hook-to-APNs delivery when configured. The phone
registers its device token with each Hook over the authenticated SSH gateway.
APNs receives a generic provider label, host UUID and one-time 55-second binding;
it never receives the command, tool input, conversation or provider action ID.
Approve/Deny from the notification resolves that binding over SSH. Questions only
offer Open because they require a structured answer in Phren.

This is an ordinary time-sensitive remote notification, not ActivityKit remote
push-to-start or push-to-update. After Phren is already running, foreground
discovery still creates the richer Live Activity. To enable direct APNs delivery:

1. Enable Push Notifications for `com.phren.ios` in Certificates, Identifiers &
   Profiles and regenerate the development/distribution profiles.
2. Create an APNs token key in the Apple Developer portal and copy its `.p8`
   file to the computer. Keep both it and the config below mode `0600`.
3. Write `~/.local/share/phren/bridge/apns.json`:

   ```json
   {"keyId":"ABCDEFGHIJ","teamId":"LYB298P4U6","topic":"com.phren.ios","privateKeyPath":"/absolute/path/AuthKey_ABCDEFGHIJ.p8"}
   ```

4. Rebuild/install Phren Hook, restart it, then install and open the newly signed
   app once. Accept notifications; Phren registers the APNs token with every
   saved computer automatically. The Hook falls back immediately to the normal
   terminal permission flow if APNs is unavailable and no foreground watcher is
   connected.

Local notifications are a separate path with independent approval and schedule
switches in Settings. The phone polls saved computers during a finite background
lease and optional BGAppRefreshTask wakes, using its pinned SSH connections.
Approval identities are hashed and persisted before notification submission.
Schedule reminders use the next known run and are reconciled after refreshes
and edits. No APNs key or relay is required; iOS may provide no execution window,
and tapping an alert revalidates the current request or run. See
[notifications](design/notifications.md).

Question cards can answer terminal prompts through their actual keys. Claude's
AskUserQuestion fallback retains its question card and sends option digits;
Codex terminal options preserve labels and wrapping descriptions. Menus without
shortcut keys move from the highlighted row, verify the selection before Enter,
and report failed verification. Unresolved interactions offer Phren's terminal.
Password entry appears only when the pane is reading a password.

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
and contains status/provenance (agent, state, directory), not prompts or
transcript text; tab-activity signatures are stored hashed. Uninstall leaves
local data and SSH backups available for manual recovery.

The Hook's own reference, every route, what a transcript export carries and
strips (Claude top-level allowlist, reduced task-notification envelopes,
queue rows, `phren_changes` with secret-name redaction), the simulator
helper's confinement, and the same-user trust boundary of `agent.sock`, is
`packages/cli/src/bridge/AGENT_CONNECTIONS.md`.

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
The app includes an HTTP transport exception for exactly `phren-preview.localhost`;
the existing local-network exception does not cover that dotted `.localhost` name.
The preview proxy still requires authentication and carries remote traffic over SSH.

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

Codex asynchronous questions (`request_user_input_async`) use the title/string-
option shape and return `{accepted:true}` before the person answers. The app
keeps them pending across that acknowledgement and assistant replies, displays
them above the composer even when the agent is working or idle, and supports
choices or a typed Other answer when status advertises `asyncQuestions`. The
Hook validates the original question and uses Codex's exact-thread inbox; the
app reports “Answer queued for Codex.” Status also supplies older pending prompts.
Answers made in Herdr resolve the matching quoted question in the transcript.
Terminal-only connections without the inbox capability, and synchronous Codex
questions without a response channel, show the actual question and a terminal
link instead of suggesting that an ordinary composer message will answer it.
