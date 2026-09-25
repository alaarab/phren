# Phren Hook agent connections

Phren Hook is a local daemon installed separately with `phren bridge install`.
The iPhone reaches its private HTTP/WebSocket Unix socket through a forced-command
SSH key. Protocol version 1 and the existing phone message shapes are preserved.
The daemon does not log requests, prompts, transcripts, or tool arguments.
Claude account usage uses the computer's existing sign-in token only against
Anthropic's HTTPS usage endpoint. On macOS the login keychain takes precedence;
headless installs use Claude's credentials file. Tokens never reach the phone.
Reads are cached for a minute and fall back to dated local snapshots on failure.
Codex account limits come from its local app server.

## Transport and trust boundaries

The recognized Phren device key uses `restrict,pty` and the installed dispatcher.
Generic SSH forwarding is disabled. The dispatcher accepts only:

- `phren-hook v1 pipe`: byte relay to `hook.sock`.
- `phren-hook v1 terminal <server>`: an existing Herdr terminal through SSH PTY.
- `phren-hook v1 shell <base64url folder> [codex|claude|copilot|opencode]`: a
  login shell, or one agent, started directly on the SSH PTY in that folder.
  This needs no Herdr. The folder must decode to a canonical absolute path and
  pass the same rules as workspace creation (under home or a located project).
  `HERDR_*` variables are stripped and PATH is pinned. The process lives only as
  long as the SSH session: nothing persists, and chat, transcripts, prompts and
  identity are not available for it. The phone offers it as a fallback when no
  Herdr server is running.
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
modified transcript never selects the conversation. opencode identity comes from
Herdr's explicit session ID only (`ses_` plus a base62 token), which requires
`herdr integration install opencode` on the computer.

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
| `POST /v1/dispatch` | Place a worker brief on an enrolled computer over pinned SSH. Returns a durable receipt and remote target; never automatically retries a mutation. |
| `GET /v1/dispatch`, `/v1/dispatch/capacity` | Local placement receipts, with each worker's last observed state and latest return; running Herdr servers and working-agent count for scheduling. |
| `POST /v1/dispatch/workers` | Receiving side of the returns loop: the state of up to 64 dispatched targets from the shared Herdr snapshot, plus a stopped worker's final reply (at most 4000 bytes). Keeps no dispatch state. |
| `POST /v1/dispatch/returns` | Unread worker returns (done, needs-you, failed, blocked, gone), marked read as they are returned. |
| `GET /v1/muxes` | Running Herdr servers. |
| `GET /v1/workspaces`, `/v1/workspaces/panes` | Workspace overview, pane identity, context, branch, activity and watched approvals. |
| `POST /v1/workspaces/launch` | Create a workspace/tab and start the selected agent. Accepts the phone's `cwd` or a mutually exclusive `project` slug resolved from this computer's registered sourcePath. Returns a session or starting `target` when identity is available. |
| `POST /v1/schedules` | List every store schedule with its project, this computer's next run, latest local run, and running state. A schedule assigned to another computer has `nextRun: null`. |
| `POST /v1/schedules/run` | Launch `{ project, id }` immediately through the same Herdr or headless scheduler path. Unknown schedules are 404; an active run or another computer assignment is 409. |
| `POST /v1/schedules/history` | Newest-first computer-local schedule runs, filtered by optional `project` and `id`; `limit` defaults to 50 and is capped at 500. |
| `POST /v1/workspaces/create`, `/focus`, `/rename`, `/close` | Existing workspace actions. Creation uses the same launch admission limits. |
| `GET /v1/projects/locate` | Existing project candidates from activity, Herdr, store registration and local search roots. |
| `GET /v1/projects/repos` | Git checkouts on this computer for "Add project", activity, Herdr, then one level under the project roots, each marked whether phren already tracks it. |
| `POST /v1/projects/add` | Enroll a checkout (`directory`) or clone a GitHub URL (`cloneUrl`) into the projects folder first, then `phren add`; commits and pushes the store when it has a remote. Uses the launch admission limits. |
| `GET /v1/models?source=<harness>` | Harness menu entries with ID, name, optional description and default. Claude reads its newest cached model catalogue with installed-client filtering; Codex uses app-server and OpenCode uses its model command. Results are cached for ten minutes. |
| `GET /v1/activity`, `/v1/usage` | Activity metadata and account limits. |
| `GET /v1/metrics` | In-memory counters since the Hook started: Herdr RPCs by method, identity probes (`lsof`/`proc` spawns, cache hits, agent-reported ids), git child processes by caller and timer ticks by name, each with `total`, `lastMinute`, `currentMinute` and `perMinute`, plus the Hook's `pid`. At most 65 names per kind; no paths, targets or text. Read by `scripts/bench-hook.mjs`. |
| `GET /v1/projects/files?project=…&directory=…&path=…` | Read-only checkout browser. The directory must match a fresh project-location result; path is relative. Returns `kind: directory` with at most 500 entries or `kind: file` with base64 `data`, at most 2 MB. Symlinks, traversal, `.git`, and non-regular files are refused. `repositoryFiles` advertises support. |
| `WS /v1/overview?watchApprovals=1` | The `/v1/workspaces` overview for one Herdr server (`server` or `mux`), pushed instead of polled. The first frame is `{type: "overview", ...}` from a fresh snapshot; after that the Hook reads the shared snapshot at most one tick old every `PHREN_OVERVIEW_TICK_MS` (default 5 s, reusing the activity timer's snapshot), rebuilds the overview when that snapshot changed or `PHREN_OVERVIEW_REFRESH_MS` (10 s) passed, and sends it only when its rows differ from the last frame. With nothing to send, `{type: "heartbeat", phren}` every `PHREN_OVERVIEW_HEARTBEAT_MS` (20 s) keeps the phone's copy current. `watchApprovals=1` renews the approval lease each tick. Advertised as `capabilities.overviewStream`; see `server-overview.ts`. |
| `WS /v1/transcripts`, `/v1/status` | Bounded transcript backlog/tail/history and live status. With `child=<id>` from `/v1/subagents`, the same socket follows that child agent's transcript instead: the parent target is what stays validated each tick, and the frames carry the child's parent-scoped id as `session`. The transcript socket also sends ephemeral `{preview: {turnStartedAt, text}}` or `{preview: null}` frames, at most twice a second, without changing history cursors. Completed entries clear the preview immediately. |
| `GET /v1/transcripts/history`, `/v1/transcripts/blob` | Target-bound older rows and separately requested original embedded images. `history` also takes `child=<id>`. |
| `GET /v1/subagents`, `/v1/subagents/transcript` | The agents a conversation spawned (Codex `SubAgentActivity`, Claude Code `agent-<id>.jsonl` sidechains, phren fan-outs) as a tree of parent-scoped ids, and a one-shot recent page of one child's transcript. Child rows are served as that conversation's own turns (Claude's `isSidechain` flag is dropped). A Claude launch whose file has not appeared yet is looked for again within two seconds rather than missed until the parent next changes. Codex CLI fan-outs launched with `codex exec --json` appear as child agents through `provider: "codex"` manifests, beside OpenCode ones. Fan-out exports carry the shell command, a bounded output tail, and the changed paths; each child also reports the manifest's `model` when it names one. Fan-out children report the worktree folder name and attached branch when available, without exposing the filesystem path. A worker whose plugin refused a permission carries `reason: "blocked: <type> <pattern>"` even when the launcher recorded exit 0. A running OpenCode worker waiting on the owner's answer to a permission ask carries `reason: "needs-you: <type>: <pattern>"`. Rows include `finishedAt` and `failed` so phone lists can show failure ages and expire visible failures after one hour, independently of archive retention. |
| `POST /v1/prompt`, `/v1/keys` | Send text or Escape after validating the live destination. A Claude `/btw <question>` is allowed while the pane works: the Hook reads its terminal panel, closes it, and streams `{type: "side-answer", id, question, state, answer?}` to transcript sockets opened with `sideAnswers=1` (see `side-questions.ts`). |
| `POST /v1/side-question/dismiss` | `{ target, id }`: cancel a pending side question (Escape on its panel) or forget an answered one. |
| `POST /v1/upload` | Bounded file/image upload under the selected conversation. |
| `GET, POST /v1/files` | List/store files sent by the phone outside any conversation. |
| `GET /v1/uploads/image` | Bytes of one image the phone uploaded, by absolute `path`; only a real file inside the Hook's own uploads folder whose bytes are an image, at most 8 MiB. |
| `POST /v1/diff` | Pane repository diff and authorized optional `paths`, grouped by repository. With `child=<id>` from `/v1/subagents` it returns that spawned agent's whole repository diff instead: its own worktree for a fan-out, the parent's checkout otherwise. |
| `POST /v1/git/status`, `/log`, `/branches`, `/pulls`, `/tree` | Read-only Git data for the phone's Changes screen: working-tree status per section with `+/-` counts, recent commits with refs and the uncommitted summary, local and remote branches with upstream ahead/behind, open pull requests through `gh`, and a one-level tracked/untracked tree. All take the full target and an optional `child=<id>` resolved exactly as `/v1/diff`, or an optional `worktree=<id>` from `/v1/git/worktrees` (not both, 400); the repository is the pane's trusted directory (or the child's or listed worktree), so a non-repository is 409. `/tree` with `ignored: true` adds git-ignored folders and files at that level, marked `ignored: true`, and lists inside a wholly ignored folder from the disk (never `.git`, symlinks never followed). `/log` accepts `limit` (1–200, default 60) and an optional commit/branch `ref`; unknown refs are 400. `/branches.current` is null for a detached HEAD. `/pulls` answers `{ available: false, pulls: [] }` when `gh` is missing or not signed in, and otherwise adds `branch` and `current`: the checked-out branch's own pull request in any state (`gh pr view`, only when its head is that branch) with `checks` rolled up to `passing`, `failing`, `pending` or null. Tree rows include descendant file counts and a snapshot version; the bounded HEAD/status cache expires after two seconds and is invalidated by status refresh or mutations. Folder opens skip diff statistics. |
| `POST /v1/git/worktrees` | The pane repository's other worktrees from `git worktree list --porcelain` (bare, prunable and missing ones left out, at most 64): `{worktrees: [{id, path, branch, head, ahead, behind, changed, main?, locked?, worker?}]}`. `id` is an opaque 32-hex id; `path` is relative to the repository when inside it, otherwise home-shortened; `ahead`/`behind` count commits against the pane's HEAD; `changed` counts uncommitted files. `worker: {label, provider, child?, state?}` names who edits there: this conversation's agent whose checkout it is (a fan-out child, or a Claude sub-agent from its `.meta.json` `worktreePath` or its sidechain's `cwd`), with its public `child` id, else any fan-out manifest whose `worktree` is it. The other git routes, `/v1/diff` and `/v1/files/range` take `worktree=<id>` and resolve it only against this listing, so a phone-named path is never read (404 for an unknown id). |
| `POST /v1/git/stage`, `/unstage`, `/discard` | Stage, unstage, or discard up to 64 repo-relative paths. `discard` is destructive (the phone confirms first): tracked files go back to the index and untracked files are removed with `git clean -f` (never `-d`, never `-x`). Every path must be relative, free of `..`, not start with `-`, and resolve through `realpath` inside the repository root, including existing ancestors of deleted paths. All paths are validated before a write begins. |
| `POST /v1/git/commit`, `/push`, `/pr` | Finish a session from the phone, scoped by `child` or `worktree` like the routes above (`git-publish.ts`). `commit` takes a required `message` (at most 20,000 characters) and commits only what is staged: 409 when nothing is, never `-a`, `--amend` or `--no-verify`. `push` sends the current branch to its upstream (`branch.<name>.remote`/`.merge`), or to `origin` with `--set-upstream`; never `--force` or a `+` refspec; a detached HEAD or a missing remote is 409. The default branch (the remote's `HEAD`, else `main` or `master`, also reported as `defaultBranch` by `/status`) is refused with 409 unless the body has `confirmDefault: true`. `pr` runs `gh pr create --fill --head <branch>` (with `draft: true`, `--draft`) and answers `{ok: true, url}`, `existing: true` when gh reports one already open, or `{ok: false, reason: "missing" \| "auth" \| "failed"}`. Git and gh refusals (a hook, a rejected push) are `{ok: false, output}` with stdout and stderr interleaved as printed, at most 64 KiB, because the phone's error channel flattens text. Processes never prompt (`GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`) and stop after 110 seconds (60 for gh). |
| `GET /v1/code/status`, `/search`, `/tree`, `/outline`, `/outline-summary`, `/file-references`, `/definition`, `/references`, `/usage`, `/usage-page`, `/recent` | Code-module reads with required `project` and optional registered `store`. Search adds directory and type-family filters; tree lists indexed children; outline-summary batches up to 200 paths; file-references lists one file's resolved uses with their declarations; definitions include cited findings; usage-page ranks all symbols with pagination; recent returns observed symbol change times. See the [route reference](../../../../docs/api-reference.md#hook-routes) for inputs and envelopes. Missing indexes return 404 with the indexing command. |
| `POST /v1/code/reindex`, `/v1/code/note` | Reindex takes `project` and optional registered `store`. Note adds `symbol`, `file`, `line`, `text` and optional target session or worker harness; it saves a cited finding before optional conductor delivery. Selected read-only stores reject writes. Save and delivery results remain separate. |
| `GET /v1/web-servers` | Discover local web servers; discovery does not constrain the SSH web relay. |
| `GET /v1/simulators`, `/v1/simulators/apps`, `/v1/simulators/screenshot` | Booted simulators, installed apps and a selected device screenshot on macOS. |
| `POST /v1/simulators/action` | Validated simulator lifecycle, launch, URL, tap, home/lock and text actions. |
| `POST /v1/approvals/answer` | Answer an exact, live watched approval request. For Claude Code's `AskUserQuestion` an approval may carry `updatedInput`: the original input plus `answers` keyed by question text (a label, labels for multiSelect, any other string for a typed "Other") and an optional `response`; the hook then allows the call with that input. Rewritten questions, answers on another tool, or answers with a denial are refused (400). An opencode permission ask the plugin writes to `.runtime/approvals` is watched the same way: the Hook maps it to its pane through the recorded session binding or Herdr's opencode session id, pushes it to registered phones with the ask's title and message, and this route writes the plugin's answer file. A fan-out worker's ask (its request names the job, whose manifest must confirm the worker session) is shown on the worker's parent conversation under an action id of the parent's shape (a UUID, or 32 hex characters for an opencode parent); answering it there or from its push writes the answer the fan-out launcher waits on. |
| `POST /v1/push/register` | Register this authenticated phone for suspended approval delivery: its APNs `token` (sent direct with the Hook's own `apns.json` key), or a `relay` registration `{url, relayId, secret, key}` from the phren push relay, whose alerts are encrypted with the phone's `key` (ChaCha20-Poly1305) so the relay can't read them. A relay `410` drops the phone until it registers again. Stored mode 0600 on the computer. |
| `POST /v1/push/answer` | Consume a one-time push binding with Approve or Deny. The binding outlives the 55-second hold for ten minutes: once the hold ends it answers the dialog the agent draws in its terminal. The APNs payload never carries the provider action or conversation identity. |
| `POST /v1/push/target` | Where a live push binding's request is (server, workspace, tab, pane, source), without spending it, so a tapped notification opens that session's details. |
| `POST /v1/questions/answer` | Answer an exact pending Codex `request_user_input_async` call through `codex queue --thread <UUID> --message <quoted answer>`. Choices and typed answers are checked against the original acknowledged transcript call, the pane identity is rechecked, and a durable receipt prevents resending an uncertain result. Synchronous `request_user_input` remains unsupported on terminal-only connections. |

Creation resolves `cwd` with `realpath`, requires an existing directory under the
user's real home or within a `locateProject` candidate, and sends the resolved
path to Herdr. At most one creation/launch is in flight, and at most six attempts
are admitted per minute; excess requests return HTTP 429.

The scheduler reads `<project>/schedules.yaml` every 30 seconds. Computer names
match case-insensitively with a trailing `.local` ignored. Run state stays in
`schedule-runs.jsonl` under the private Hook runtime and retains the newest 2000
runs. A run is recorded before launch and a `launched` or `running` record blocks
another launch for that schedule. Headless jobs write their manifest and event
log under the store's private `agent-fanouts` runtime folder so Agent work can
discover them. A schedule's optional `notify` list accepts `start`, `finish` and
`failure`, defaulting to finish and failure when absent. The Hook sends those
events to registered phones through the same APNs configuration as approvals,
with one collapse id per run. Missing APNs configuration records `notified: false`
and `notifyReason: "no push config"` in the run and service log without affecting
the scheduled agent.
Computer dispatch keys reuse the phone's `restrict,pty` forced-command line;
`phren bridge enroll-computer <name>` prints it and `--accept <public-key-file>`
enrolls it on a receiver. This grants the full phone boundary above, including
project shells and loopback services, not only dispatch. Private keys and
verified peers in `hooks.yaml` stay under the Hook runtime directory. A dispatch
project's registered absolute `sourcePath` is resolved on the receiver and must
exist; the sender cannot supply a directory. See [Conductor](../../../../docs/conductor.md)
for setup, receipt states, scheduling and follow-on report/tree contracts.

`/v1/diff` accepts extra `paths` only within the pane repository, the phren store,
the conversation's locally recorded `phren_changes` roots/paths, or paths found
by `namedPaths()` in local shell-tool command rows of that conversation. The
phone cannot supply its own command as authorization. Paths resolve through
symlinks before scope checks; deleted paths resolve through their nearest
existing parent. Relative Git pathspecs starting with `:` are rejected, and
file paths passed to Git are literal pathspecs. Merely being somewhere under home
does not grant access to a second repository. Diff responses contain file patches,
not just status/provenance.

The Git routes act on the same repository as `/v1/diff`, so they inherit its
pane/child binding: a path the phone sends is never used to choose the
repository. `stage`, `unstage` and `discard` take 1..64 repo-relative paths that
are rejected (400) if absolute, containing `..`, or starting with `-`, and
return 403 if they still resolve outside the root; they are passed to Git as
literal pathspecs. Status counts come from `git diff --numstat` and
`git diff --cached --numstat`, with untracked files counting their lines as
additions. Git commands run with `GIT_OPTIONAL_LOCKS=0` and a 10-second timeout;
`gh` runs with a 15-second timeout and its absence is reported, not thrown.

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
`isCompactSummary`, `phrenQueued`, `phrenQueueKey`, `phrenBackground`, and
`phrenCompacted`, plus fields added by the exporter. Provider metadata such as
`toolUseResult` (including original files), `permissionMode`, and
`wireToolInputs` is dropped.
Codex `event_msg.error` payloads export only `type` and string `message`.

Codex response-item user messages and Claude string-content user rows are
excluded when their trimmed text starts with `<environment_context>`,
`<user_instructions>`, `<permission_profile`, `<system-reminder>`, or
`<turn_context>`. A mention later in ordinary text does not hide the turn.

opencode has no per-session transcript file. A Phren-installed opencode plugin
(`~/.config/opencode/plugins/phren-transcript.js`) mirrors each session to
`<store>/.runtime/sessions/opencode-<session>.events.jsonl` in the same
`user/message`, `assistant/message`, and `tool/results` shape phren-agent uses,
with opencode's `stop`/`tool-calls` stop reasons mapped to `end_turn`/`tool_use`
and reasoning parts excluded. `phren bridge install` writes the plugin and
`phren bridge uninstall` removes it. Plugins load at opencode startup, so an
opencode session started before the install has no transcript and no reported
session id; restart it (or launch a new one) before its chat can attach.

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
- `phrenCompacted: true`: Claude Code's `compact_boundary` row becomes a system
  marker with only its timestamp. The following `isCompactSummary` user turn is
  exported as a collapsed preview with its content capped at 4000 characters,
  so the full summary stays on the computer.

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

### Codex asynchronous questions

Status frames advertise `capabilities.asyncQuestions` only when the installed
Codex exposes the exact-thread inbox command. `pendingQuestions` contains bounded,
normalized async prompts (call ID, question text, options), including prompts
older than the initial transcript page. Discovery scans at most 10,000 rows /
8 MiB, caches unchanged transcripts, and never treats `{accepted:true}` as an
answer. The terminal's later quoted user message resolves its matching question.
The response endpoint accepts `toolUseId` and one `answers` entry per question,
each with either an `optionIndexes` selection or typed `text`. It constructs the
quoted reply from the trusted transcript and invokes Codex directly without a
shell or terminal keystrokes. A successful response means Codex accepted the
answer into its inbox; consumption can follow while an agent is working.
Receipts live under `question-replies/` in the bridge directory. An ambiguous
provider failure is never retried and leaves the question visible for inspection.
