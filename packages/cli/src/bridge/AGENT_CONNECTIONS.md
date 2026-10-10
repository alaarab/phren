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
- `phren-hook v1 pane <server> <pane>`: one Herdr pane's own terminal through
  SSH PTY (`herdr terminal attach` on the terminal the Hook resolves from the
  pane), for Phren desktop's console view. Herdr only; capability `paneTerminal`.
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
Sending checks bypass the cache. WebSocket clients are pooled by kind: Phren
desktop sends `X-Phren-Client: desktop` and gets its own pool, and every other
client shares the default pool. At most 16 clients stay connected per pool; a
seventeenth closes that pool's oldest client, so the desktop never evicts the
phone's sockets.

The receiving agent's UserPromptSubmit hook confirms a prompt as
`{ "ok": true, "delivered": true }`. The Hook waits up to 1.5 s for it, and
0.3 s for a working agent other than Claude, which queues typed text until
its turn ends. Claude Code takes a message typed mid-turn at once and runs
the hook about a third of a second later, so it gets the full wait. A client
that needs a confirmed turn treats a bare `ok` as typed but not yet taken.

After `agent.prompt` returns, the Hook takes a fresh snapshot and rechecks
`paneIdentity`. A mismatch or unavailable check returns
`{ "ok": true, "deliveryUncertain": true }`. It never retries. Herdr resolves the
pane occupant at dispatch time, so this reports uncertainty after a race; it
cannot make delivery atomic with validation. Escape/stop retains Herdr's existing
contract.

A prompt may carry `deliveryId` (8 to 64 of `A-Z a-z 0-9 _ -`, a UUID works), the
client's name for one composed message, kept on every attempt to send it (the
`promptOnce` capability). The Hook types that id at most once: a repeat for
the same pane, agent and text waits for the first attempt and answers with its
reply (or its error) plus `"replayed": true`, typing nothing; a repeat after
the first failed before typing runs normally; the same id with other text or
another pane is 409. Once answered, the id's state (`prompt-deliveries.ts`,
24 hours, kept across Hook restarts) answers a repeat with where the message
is now; only a `failed` message is typed again under it. A dropped connection
is then safe to retry. A request without an id behaves as before.

A `startingToken` issued while a pane is proven to have no transcript remains
valid as its first conversation becomes identified, for up to one minute after
the Hook first observes that identity. Fresh validation still binds the server,
workspace, tab, pane, terminal, agent and foreground process. Helper processes
joining that foreground group do not change the binding. A different process,
terminal or observed conversation retires the token, as does losing a previously
known identity. Tokens read from an already identified or ambiguous pane grant
no transition permission. A transitioning prompt observes the same model/side
question reservations as an ordinary prompt. The client keeps its `deliveryId`
when retrying with the new session target, so that retry types nothing twice.

### OpenCode panes the Hook starts

An OpenCode the Hook launches (worker, conductor, dispatch or schedule) runs as
`opencode --port <free port>` with `OPENCODE_SERVER_PASSWORD` (32 random bytes)
and `PHREN_OPENCODE_PORT` in the pane's environment, beside `PHREN_DISPATCH_ID`.
The TUI serves OpenCode's HTTP API on 127.0.0.1 with Basic auth, and the pane
stays the owner's view of the same conversation. Once the process carrying that
port answers, the Hook records the pane in `<bridge>/opencode-panes/`
(`<server>%2F<pane>.json`, 0600 in a 0700 folder: port, password, PID, folder,
and the launch's agent, model and variant). An entry whose PID is gone is
removed on the Hook's five-second tick; a pane without an entry (OpenCode started
by hand) keeps every typed path below.

For a registered pane:

- A dispatch or schedule brief is sent over HTTP, not typed: the Hook creates a
  session, prompts it with the brief, and moves the TUI onto it
  (`/tui/select-session`, repeated until the pane draws the prompt, because a
  TUI that has just started drops the first request). The brief file is still
  written, and the arrival record gets `started` when the prompt is sent and
  `accepted` when the user turn appears in the session, so the receipt turns
  `accepted` exactly as a Claude or Codex hook echo does. `briefLaunched` is
  true once the prompt was sent, confirmed or not.
- `POST /v1/prompt` sends into the target's session over `prompt_async` after
  checking it is a root session of that server; a starting target gets a new
  session shown in the TUI. A continuing session keeps its last user turn's
  agent, model and variant; a new one takes the launch's. The reply is
  `delivered: true` once the user turn appears (within 3 s), else
  `deliveryUncertain: true`; `deliveryId` applies as for typing. A slash command
  (the TUI's own menus) and a prompt that never reached OpenCode (refused, or
  nothing listening) are typed instead.
- The Hook follows each pane's `/event` stream (reconnecting with backoff up to
  30 s) and, on connect and on every permission or question event, lists
  `/permission` and `/question`. A permission becomes the same card and push as
  a plugin ask (`actionId` is OpenCode's `per_…` id), shown on the root of the
  asking session, and `POST /v1/approvals/answer` or its push replies `once`,
  `always` or `reject` over HTTP. Its card advertises `once`, "Allow for this
  project", "Allow everywhere" and Deny as `options`; both grant scopes reply
  `always` (OpenCode's `always` lasts the running session), and "Allow
  everywhere" also adds the tool to `~/.config/opencode/opencode.json` as an
  allow rule. It stays answerable while OpenCode lists it, with no 50 s
  deadline: the Hook lists every live pane again on its five-second tick, and
  each listing that still returns the ask moves its `expiresAt` (and its push
  binding) an hour ahead. The card goes only when the ask is no longer listed
  or the pane's process is gone. A question is
  published as the status frame's `terminalPrompt` in Claude's AskUserQuestion
  shape (`questions`, `questionIndex`, `choice`) with `capabilities.questions`;
  `POST /v1/questions/answer` replies with the chosen labels plus any typed
  answer. An ask answered in the TUI leaves the list, and its card and push
  binding go with it. The pane's screen is not read for dialogs, and the
  OpenCode plugin writes no request file for a process whose own command line
  carries the `--port` named by `PHREN_OPENCODE_PORT`. OpenCode 1.18.31 does not
  call the plugin's `permission.ask` hook at all (older releases did). For an
  OpenCode started by hand the plugin relays the `permission.asked` event
  instead: it writes the same request file (expiring after 30 minutes, since
  the TUI keeps its own prompt), replies to the answer file's decision with
  `postSessionIdPermissionsPermissionId` (`once` / `always` / `reject`), and removes the
  file when `permission.replied` says the TUI answered first.
- `POST /v1/keys`: Escape declines a pending question, or aborts a working
  turn with `session.abort` (a failed abort falls back to the key); a digit
  answers a pending single-question, single-choice set. Other keys go to the
  pane.

## Routes

All ordinary routes use the private HTTP pipe; transcript and status streams use
WebSockets on the same socket.

| Route | Purpose and boundary |
| --- | --- |
| `GET /v1/health` | Protocol, capabilities, computer identity. |
| `POST /v1/dispatch` | Place a worker brief on an enrolled computer over pinned SSH. Returns a durable receipt and remote target; never automatically retries a mutation. |
| `GET /v1/dispatch`, `/v1/dispatch/capacity` | Local placement receipts, with each worker's last observed state and latest return; running Herdr servers and working-agent count for scheduling. |
| `GET /v1/dispatch/arrival?id=<id>` | Receiving side of a brief that went with the launch: `{ arrival: { started?, accepted? } }` as the worker's SessionStart and UserPromptSubmit hooks reported it by `PHREN_DISPATCH_ID`, each with its time and target; `arrival: null` when this computer wrote no such brief. |
| `POST /v1/dispatch/workers` | Receiving side of the returns loop: the state of up to 64 dispatched targets from the shared Herdr snapshot, plus a stopped worker's final reply (at most 4000 bytes). Keeps no dispatch state. |
| `POST /v1/dispatch/returns` | Unread worker returns (done, needs-you, failed, blocked, gone), marked read as they are returned. |
| `GET /v1/muxes?typed=1` | Herdr and tmux sources together, with typed `id`, `kind`, `session` and `running`. A failed source does not remove other sources. Without `typed=1`, discovery retains legacy Herdr aliases, with accurate additive `mux` descriptors for tmux. |
| `GET /v1/workspaces`, `/v1/workspaces/panes` | Workspace overview, pane identity, context, branch, activity and watched approvals. Select with `mux=herdr:<session>` or `mux=tmux:<server>`; replies include `mux: {id, kind, session}`. Typed tmux selectors return `kind: "tmux"`; legacy selectors retain the `kind: "herdr"` envelope for installed clients. The same negotiation applies to the overview WebSocket. |
| `POST /v1/workspaces/launch` | Create a workspace/tab and start the selected agent. Accepts the phone's `cwd` or a mutually exclusive `project` slug resolved to this computer's folder for it (see computer dispatch below). Before Claude or Codex starts in that resolved `project` folder or in a new `worktree`, the folder is marked trusted for the harness (`bridge/folder-trust.ts`, `PHREN_PRETRUST=off`); a phone `cwd` never is. A new pane whose shell has not reached its prompt yet (Herdr `agent_pane_busy`) is retried for up to `PHREN_SHELL_READY_MS` (default 15000). Returns a session or starting `target` when identity is available. An optional `brief: { id, text }` (a dispatch or scheduled-run ID and its first prompt) is written to `<bridge>/briefs/<id>/brief.md` and, for Claude and Codex, passed as the harness's initial prompt argument (`Read and follow the brief in <path>`); `PHREN_DISPATCH_ID=<id>` goes into the new pane's environment (Herdr `workspace.create`/`tab.create` `env`, tmux `respawn-pane -e`). The reply's `briefLaunched` says whether the launch carried it; when false the caller types it. |
| `POST /v1/schedules` | List every store schedule with its project, this computer's next run, latest local run, and running state. A schedule assigned to another computer has `nextRun: null`. |
| `POST /v1/schedules/run` | Launch `{ project, id }` immediately through the same Herdr or headless scheduler path. Unknown schedules are 404; an active run or another computer assignment is 409. |
| `POST /v1/schedules/history` | Newest-first computer-local schedule runs, filtered by optional `project` and `id`; `limit` defaults to 50 and is capped at 500. |
| `POST /v1/workspaces/create`, `/focus`, `/rename`, `/close` | Existing workspace actions. Creation uses the same launch admission limits. |
| `GET /v1/projects/locate` | Existing project candidates from activity, Herdr, store registration and local search roots. |
| `GET /v1/projects/repos` | Git checkouts on this computer for "Add project", activity, Herdr, then one level under the project roots, each marked whether phren already tracks it. |
| `POST /v1/projects/add` | Enroll a checkout (`directory`) or clone a GitHub URL (`cloneUrl`) into the projects folder first, then `phren add`. Optional `project` names the target identity (independent of the repository basename); optional `store` selects a uniquely registered writable store by ID/name/GitHub repository. Older clients can omit both; commits and pushes the store when it has a remote. Uses the launch admission limits. |
| `GET /v1/models?source=<harness>` | Harness menu entries with ID, name, optional description and default. Claude reads its newest cached model catalogue with installed-client filtering; Codex uses app-server and OpenCode uses its model command. Results are cached for ten minutes. |
| `GET /v1/activity`, `/v1/usage` | Activity metadata and account limits (Copilot included for callers that name it). `peers=1` adds each linked computer's answer. |
| `GET /v1/resources` | Load against cores, memory, home-volume disk, battery, uptime and heavy jobs with their panes (`resources.ts`), collected at most every 10 s; `peers=1` adds each linked computer's. `WS /v1/overview?resources=1` pushes it as `{type: "resources"}` every 12 s. |
| `GET /v1/metrics` | In-memory counters since the Hook started: Herdr RPCs by method, identity probes (`lsof`/`proc` spawns, cache hits, agent-reported ids), git child processes by caller and timer ticks by name, each with `total`, `lastMinute`, `currentMinute` and `perMinute`, plus the Hook's `pid`. At most 65 names per kind; no paths, targets or text. Read by `scripts/bench-hook.mjs`. |
| `GET /v1/projects/files?project=…&directory=…&path=…` | Read-only checkout browser. The directory must match a fresh project-location result; path is relative. Returns `kind: directory` with at most 500 entries or `kind: file` with base64 `data`, at most 2 MB. Symlinks, traversal, `.git`, and non-regular files are refused. `repositoryFiles` advertises support. |
| `WS /v1/overview?watchApprovals=1` | The `/v1/workspaces` overview for one Herdr server (`server` or `mux`), pushed instead of polled. The first frame is `{type: "overview", ...}` from a fresh snapshot; after that the Hook reads the shared snapshot at most one tick old every `PHREN_OVERVIEW_TICK_MS` (default 5 s, reusing the activity timer's snapshot), rebuilds the overview when that snapshot changed or `PHREN_OVERVIEW_REFRESH_MS` (10 s) passed, and sends it only when its rows differ from the last frame. With nothing to send, `{type: "heartbeat", phren}` every `PHREN_OVERVIEW_HEARTBEAT_MS` (20 s) keeps the phone's copy current. `watchApprovals=1` renews the approval lease each tick; `resources=1` adds `{type: "resources", resources}` frames (see `/v1/resources`); `sudo=1` adds `{type: "sudo", requests}` after the first overview and whenever the pending sudo requests change (see `/v1/sudo`). Advertised as `capabilities.overviewStream`; see `server-overview.ts`. |
| `WS /v1/transcripts`, `/v1/status` | Bounded transcript backlog/tail/history and live status. With `child=<id>` from `/v1/subagents`, the same socket follows that child agent's transcript instead: the parent target is what stays validated each tick, and the frames carry the child's parent-scoped id as `session`. The transcript socket also sends ephemeral `{preview: {turnStartedAt, text}}` or `{preview: null}` frames, at most twice a second, without changing history cursors. Completed entries clear the preview immediately. A preview built from the harness's own deltas adds `delta` and `streamed: true` (see *Streaming reply text*). |
| `GET /v1/transcripts/history`, `/v1/transcripts/blob` | Target-bound older rows and separately requested original embedded images. `history` also takes `child=<id>`. |
| `GET /v1/subagents`, `/v1/subagents/transcript` | The agents a conversation spawned (Codex `SubAgentActivity`, Claude Code `agent-<id>.jsonl` sidechains, phren fan-outs) as a tree of parent-scoped ids, and a one-shot recent page of one child's transcript. Child rows are served as that conversation's own turns (Claude's `isSidechain` flag is dropped). A Claude launch whose file has not appeared yet is looked for again within two seconds rather than missed until the parent next changes. Codex CLI fan-outs launched with `codex exec --json` appear as child agents through `provider: "codex"` manifests, beside OpenCode ones. Fan-out exports carry the shell command, a bounded output tail, and the changed paths; each child also reports the manifest's `model` when it names one. Fan-out children report the worktree folder name and attached branch when available, without exposing the filesystem path. A worker whose plugin refused a permission carries `reason: "blocked: <type> <pattern>"` even when the launcher recorded exit 0. A running OpenCode worker waiting on the owner's answer to a permission ask carries `reason: "needs-you: <type>: <pattern>"`. Rows include `finishedAt` and `failed` so phone lists can show failure ages and expire visible failures after one hour, independently of archive retention. |
| `POST /v1/prompt`, `/v1/keys` | Send text or Escape after validating the live destination. A Claude `/btw <question>` is allowed while the pane works: the Hook reads its terminal panel, closes it, and streams `{type: "side-answer", id, question, state, answer?}` to transcript sockets opened with `sideAnswers=1` (see `side-questions.ts`). |
| `POST /v1/side-question/dismiss` | `{ target, id }`: cancel a pending side question (Escape on its panel) or forget an answered one. |
| `POST /v1/agents/permission-mode` | The phone's mode picker: `{ target, mode }` changes a Claude pane's permission mode. `mode` is Claude's own name — `default`, `acceptEdits`, `plan` or `auto` (`bypassPermissions` only where the session was launched allowing bypass). The Hook presses Shift+Tab through the pane's existing key path, re-reading the footer after each press, for at most one full cycle plus one press, and replies `{ ok, permissionMode, setBy: "owner" }`. It refuses 409 a working agent or an open permission prompt/dialog, and 422 another harness or a mode this session does not offer. This is the owner's own choice: the authority `maxPermissionMode` ceiling does not apply. A request naming a pane as `origin` (an agent) is refused with 403. |
| `POST /v1/upload` | Bounded file/image upload under the selected conversation. |
| `GET, POST /v1/files` | List/store files sent by the phone outside any conversation. |
| `POST /v1/files/delete` | Remove one of those files: `{path}` as the listing gave it. 404 unless it resolves to a regular file directly in that uploads folder. |
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
| `POST /v1/simulators/action` | Validated simulator lifecycle, launch, URL, tap, home/lock and text actions, and `accessibility-settings` (asks macOS for the helper's grant and opens the Accessibility pane on the Mac). |
| `POST /v1/approvals/answer` | Answer an exact, live watched approval request. For Claude Code's `AskUserQuestion` an approval may carry `updatedInput`: the original input plus `answers` keyed by question text (a label, labels for multiSelect, any other string for a typed "Other") and an optional `response`; the hook then allows the call with that input. Rewritten questions, answers on another tool, or answers with a denial are refused (400). An opencode permission ask the plugin writes to `.runtime/approvals` is watched the same way: the Hook maps it to its pane through the recorded session binding or Herdr's opencode session id, pushes it to registered phones, and this route writes the plugin's answer file. A fan-out worker's ask (its request names the job, whose manifest must confirm the worker session) is shown on the worker's parent conversation under an action id of the parent's shape (a UUID, or 32 hex characters for an opencode parent); answering it there or from its push writes the answer the fan-out launcher waits on. A served OpenCode pane's ask (see *OpenCode panes the Hook starts*) is answered over that pane's HTTP API with `once`, `always` or `reject`: the card's "Allow for this project" and "Allow everywhere" both reply `always`, and "Allow everywhere" also writes an allow rule for the tool into `~/.config/opencode/opencode.json`. |
| `POST /v1/push/register` | Register this authenticated phone for suspended approval delivery: its APNs `token` (sent direct with the Hook's own `apns.json` key), or a `relay` registration `{url, relayId, secret, key}` from the phren push relay, whose alerts are encrypted with the phone's `key` (ChaCha20-Poly1305) so the relay can't read them. A relay `410` drops the phone until it registers again. Stored mode 0600 on the computer. |
| `POST /v1/push/answer` | Consume a one-time push binding with Approve or Deny. The binding outlives the 55-second hold for ten minutes: once the hold ends it answers the dialog the agent draws in its terminal. The APNs payload never carries the provider action or conversation identity. |
| `GET /v1/sudo` | Pending `sudo -A` requests from this computer's askpass helper: `{ requests: [{ id, computer, command, account?, user?, cwd?, session?: { source?, label?, server?, workspace?, tab?, pane? }, askedAt, expiresAt }] }`, oldest first. `command` is what sudo will run, without sudo's own flags (the whole line when there is none, such as `sudo -v`). Never carries a password. Capability `sudo`. |
| `POST /v1/sudo/answer` | `{ id, password }` hands the password to the waiting askpass once, which prints it for sudo; `{ id, deny: true }` makes askpass exit 1. `outcome: true` beside a password holds the reply until the Hook knows whether sudo took it: `{ ok: true, outcome: "accepted" | "rejected" | "unknown" }` (capability `sudoOutcome`). The password is 1 to 1024 characters with no newline, carriage return or NUL, and is never logged or stored. An unknown, answered or expired id is 404. |
| `POST /v1/push/target` | Where a live push binding's request is (server, workspace, tab, pane, source), without spending it, so a tapped notification opens that session's details. |
| `POST /v1/push/presence` | `{ activeForMs }` (at most 120000) from Phren desktop while the owner uses it (capability `deskPresence`). Approval alerts wait while the desk is active and reach the phone only if the approval is still pending once the desk has been idle past that window. |
| `GET /v1/workspaces/layout?server=&pane=` | A Herdr tab's split layout around one of its panes: `{ layout: { tab_id, area, panes: [{ pane_id, focused, rect }], splits, zoomed } }` from Herdr's `pane.layout` (capability `paneLayout`; 501 on tmux). Phren desktop mirrors a Herdr tab with it. |
| `POST /v1/questions/answer` | For a Codex question, `attachments` (at most eight paths `/v1/upload` returned for this conversation) ride along: an async answer on the Hook's app-server gets them as an `Attached files on this computer:` text item plus a `localImage` per picture, a blocking `request_user_input` answer and a `codex queue` reply get the same list appended to the text; a form elicitation and other providers refuse them (400). The status frame advertises this as `capabilities.questionAttachments`. Answer an exact pending Codex `request_user_input_async` call: on a pane the Hook runs on its own app-server, by `turn/steer` into the running turn with Codex's `<send_user_message_question_reply>` message (`turn/start` when none runs); elsewhere through `codex queue --thread <UUID> --message <quoted answer>`, which Codex holds until the turn ends. A `toolUseId` of `request:<id>` answers a question parked on that app-server (`item/tool/requestUserInput`, or a single-value form MCP elicitation) as the reply to that request. Choices and typed answers are checked against the original acknowledged transcript call, the pane identity is rechecked, and a durable receipt prevents resending an uncertain result. Synchronous `request_user_input` remains unsupported on terminal-only connections. For a served OpenCode pane it takes Claude's question body (`questions`, `answers` with `optionIndexes` and `text`) and replies to OpenCode's pending question with the chosen labels. |
| `POST /v1/speech` | One sentence voiced with this computer's ElevenLabs key, which never leaves the computer or appears in a reply. The audio is passed through as ElevenLabs sends it: headers are flushed before the first byte and nothing buffers the body. With `timestamps` and `stream` (capability `speechTimestampStream`) the reply is `application/x-ndjson`, one `{audio, alignment}` line per ElevenLabs chunk, alignment in seconds from the start of the sentence; plain `timestamps` still waits for the whole clip (about 0.6 s later with v4 Turbo). ElevenLabs is reached over the Hook's own keep-alive pool (`speech.ts` `elevenLabsFetch`, idle sockets kept 60 s; fetch's pool drops them after 4 s, shorter than talk mode's pause between replies) at the region in `speech.json` (`phren bridge speech-region us\|global`, `https://api.us.elevenlabs.io` or `https://api.elevenlabs.io`). `HTTPS_PROXY` applies only when `NODE_USE_ENV_PROXY=1`, as with fetch. |
| `WS /v1/speech/live` | One reply voiced while it is still being written (capability `speechLive`, `speech-live.ts`). Query `voice`, repeated `format`. The phone sends `{text}` pieces and `{done: true}`; the Hook releases them to ElevenLabs a sentence or line at a time as speakable words (markdown stripped, code blocks skipped) and answers `{type: "start", model, format, audioFormat, sampleRate}` with the first audio, `{type: "audio", audio, alignment}` (seconds from the start of the socket's audio), `{type: "done"}`, or `{type: "error", code, error}` with a fixed message. v3 and v4 models go to ElevenLabs' text-to-dialogue stream-input (text-to-speech stream-input refuses them with `unsupported_model`), others to text-to-speech stream-input with `auto_mode=true`. A model or format refused before any audio, in the handshake or in ElevenLabs' first error frame, falls back (Flash v2.5; the next format) and the reply's text so far is replayed. Text-to-dialogue gets `keep_alive` every 15 s; a socket lives at most 10 minutes. |

### Streaming reply text

Talk mode reads a reply aloud while it is still being written, from the
transcript socket's preview frames:

```json
{ "type": "preview", "source": "phren", "session": "<id>",
  "preview": { "turnStartedAt": "2026-10-01T12:00:00.000Z", "text": "It is 42", "delta": " 42", "streamed": true } }
```

The same `preview` object rides backlog and append frames. `text` is the
current assistant text block so far (at most 32,768 characters). `delta` and
`streamed: true` appear only when that text is the reply's own Markdown built
from harness deltas; terminal text never has them. `delta` is what was
appended since the previous preview frame on this socket, so a phone appends
it in order; it equals `text` when the block is new to the socket: the first
frame of a block, the first after `preview: null`, the first on a reconnected
socket (which resends the text so far once), and a following block in the same
turn. `preview: null` or the block's completed entry ends it. Frames are
throttled to two a second, so one `delta` can carry several harness deltas.

| Harness | Source | Granularity |
| --- | --- | --- |
| phren agent | `<store>/.sessions/session-<id>.events.jsonl.preview.json`, `{turnStartedAt, text}` written by the agent at most every 100 ms and removed after the message is logged (`packages/agent/src/session/preview.ts`) | token deltas, `streamed` |
| Codex | the in-progress `agentMessage` item of the thread, or rollout `agent_message_delta` rows | deltas as often as Codex records them, `streamed` |
| OpenCode | the plugin's `.preview.json` beside its mirrored event log | token deltas, `streamed` |
| Claude Code | the pane, read twice a second and anchored to the prompt, until the turn's first entry lands | screen text, no `delta`; later blocks only as entries |
| Copilot | none | per block, as entries |

### Quick chat

`POST /v1/workspaces/launch` with `kind: "phren"` takes `mode: "chat"`, which
starts `phren agent -i --mode chat`: no tools, and the project's truths,
summary and newest findings read from the store into the system prompt, so
the first answer comes in about a second on the owner's own provider setup
(ChatGPT/Codex subscription included). `resumeSession: "<uuid>"` adds
`--session <uuid>`, continuing that session's history; resuming a chat with
`mode: "agent"` (or none) promotes it to a normal agent with tools. Typing
`/promote` into a running chat does the same in place. The pane is an ordinary
phren pane: prompts go through `/v1/prompt`, replies stream as above. Other
harnesses refuse `mode` and `resumeSession` with 400. Capabilities
`previewDeltas` and `quickChat` advertise both. The phone sends a `launchId`
with each quick chat it starts, so a repeat of the same request returns the
first pane (`reused: true`) rather than a second chat. A chat's banner leaves
out its folder: the phren store's path means nothing to the person chatting.

Claude Code names its current permission mode in the footer under its composer
(`⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on`, `⏵⏵ auto mode on`,
`⏵⏵ bypass permissions on`). The chat status frame carries it as
`agentStatus.permissionMode` (`default`, `acceptEdits`, `plan` or `auto`) beside
`agentStatus.permissionModes`, the modes this session offers in Shift+Tab cycle
order (`bypassPermissions` last, only when it was launched allowing bypass).
Both fields appear only when that footer was read, so the picker never guesses a
default. Codex and OpenCode keep their permission mode in config rather than the
pane and send neither. The footer read is the same throttled one behind
`settingsState` and `agentStatus.suggestion`.

Approval pushes use the existing version 1 binding and category. Their alert title is
`<Agent> · <project> on <computer>` with missing parts omitted; the body is a
redacted, one-line request. The `phren` object also carries `agent`, optional
`project` and `computer`, `request` (the same body), and `requestKind` (`command`,
`tool`, `edit`, `question`, or `other`). A watched approval in `/v1/stream` has an
optional `request` line on `pendingApproval` or `terminalPrompt` for the phone's
local activity. The full `message` remains available inside the authenticated
chat for reviewing and answering the request.

Codex runs its `PermissionRequest` hook before its automatic reviewer, and the
payload doesn't say which one will decide. For each request the hook reads the
session's rollout (`transcript_path`) back to the latest `turn_context` or
`thread_settings_applied` line. When that says `approvals_reviewer: "auto_review"`
with an `on-request` or granular policy, Codex's reviewer decides: the Hook
answers at once with no decision, and holds, pushes and remembers nothing, and
doesn't mark the pane blocked. If Codex hands the request back to the owner, it
draws its own approval dialog, and the waiting-pane dialog read pushes that like
any other. Other sessions keep the normal hold.

Codex 0.158+ runs a `hooks.json` callback only when `config.toml` holds its
`trusted_hash` (`[hooks.state."<path>:<event>:<group>:<handler>"]`), and the
hash covers the timeout. Install, update, rollback and module reconcile run
`bridge/codex-hook-trust.ts` after rewriting Phren's Codex callbacks: a Phren
callback whose hash no longer matches gets the new hash only when the owner had
trusted Phren's callback for that event before (same command at a shipped
timeout, or the pre-rewrite entry). Without this a timeout change leaves Phren's
SessionStart, UserPromptSubmit and Stop skipped and every Codex on "Hooks need
review". `PHREN_PRETRUST=off` turns it off.

### Codex panes on the Hook's own app-server

A Codex agent the Hook launches with role `agent` (dispatch, schedule, phone)
runs on a `codex app-server` the Hook spawns for that pane alone:
`codex app-server --listen unix://<bridge>/codex-servers/<id>/app.sock`,
detached, folder 0700, stderr to `server.log` there. Its environment is the
Hook's without the Hook's own `HERDR_*`/`TMUX*`/`PHREN_DISPATCH_ID`, plus the
pane's multiplexer variables (`TerminalProvider.paneEnv`), `PHREN_DISPATCH_ID`
for a brief, and `PHREN_CODEX_SERVER=<id>`. Codex's hooks run inside that
server; a hook that sees `PHREN_CODEX_SERVER` trusts its pane variables instead
of treating the server as the shared daemon. The Hook connects over
WebSocket-on-UDS (`codex-app-server.ts`) as client `phren_hook`.

- With a brief, the Hook calls `thread/start` (`cwd`, `model`,
  `config.model_reasoning_effort`), sends the brief text as `turn/start`, records
  the brief as accepted on the returned turn id, and starts the pane with
  `codex resume <thread> --remote unix://<socket>`. Without one, a thread with no
  turn cannot be resumed, so the pane runs `codex --remote unix://<socket>`
  (`--model`, `-c model_reasoning_effort=`) and the Hook takes the first
  top-level `thread/started` in the pane's folder as the pane's thread, joining
  it with `thread/resume` once it has a turn.
- The registry record `<id>/server.json` holds server, workspace, tab, pane,
  socket, pid, thread id, folder, dispatch id, running turn and last finished
  turn (id, status). No prompt text. A restarted Hook reconnects to every
  record whose pid is alive and resumes its thread; the rest are removed. On
  Linux each server runs in its own systemd scope (`phren-codex-<id>.scope`),
  so stopping the Hook's service does not end it. A record removed with a
  running turn is kept in memory for a day as a lost turn, and
  `/v1/dispatch/workers` reports that pane's dispatch `done` with an error, so
  the dispatcher records it `failed`.
- `/new` or `/resume` in the pane is followed: a top-level `thread/started`
  in the pane's folder, or the pane's trusted SessionStart callback naming
  another thread, rebinds the record to that thread (its old cards are
  withdrawn, its turn state reset) and the Hook joins it with `thread/resume`
  once it has a turn.
- The pane's identity is the registered thread while one of its foreground
  processes runs with `unix://<socket>` on its command line. Other panes'
  daemon-rollout matching never takes a registered thread.
- `POST /v1/prompt` on that exact target (server, workspace, tab, pane, thread)
  sends `turn/start` and replies `delivered: true` with `turnId`; a slash
  command is typed; an unreachable server falls back to typing; an RPC error
  is 409; a lost reply is `deliveryUncertain` and not retried. A prompt sent
  while a turn runs steers that turn (Codex takes it at its next step, as a
  mid-turn Claude message is taken at the next tool boundary) instead of
  queueing until the turn ends as typed text would.
- Server requests `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval` and `item/permissions/requestApproval`
  become approval cards in the same store and push path as a held
  PermissionRequest, without the hold timer; the card's `expiresAt` slides ten
  minutes ahead while it waits. Approve answers `{decision:"accept"}` (a
  permission request: its requested permissions, `scope:"turn"`), deny
  `{decision:"decline"}` (`permissions:{}`). `serverRequest/resolved` drops the
  card. A replayed request keeps its card and is answered on the new
  connection. The PermissionRequest callback for a registered thread answers
  `{}` at once. `item/tool/requestUserInput` and form
  `mcpServer/elicitation/request` requests the phone can show are listed in the
  status frame's `pendingQuestions` as `request:<id>`; secret inputs, URL
  elicitations and multi-select fields are left to the pane.
- `/v1/keys` Escape on that target with a running turn answers the thread's
  parked requests with their cancel shapes, then sends `turn/interrupt`.
- The 5-second tick removes a record whose process exited and stops (process
  group SIGTERM) a server whose pane is gone, or whose pane has shown no Codex
  (or whose Herdr or tmux server has not run) for two minutes. The Hook's shutdown closes its clients only.
- `PHREN_CODEX_APP_SERVER=off` disables all of this. A failed server start
  falls back to the launch-argument path.

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
project's folder is resolved on the receiver and must exist there: the store's
`sourcePaths` entry for that computer, else its shared `sourcePath`, else a git
checkout named after the project in a usual project root (`~/Projects/<name>`
and the like). The sender cannot supply a directory. See [Conductor](../../../../docs/conductor.md)
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
and reasoning parts excluded. A tool's inline image attachments (the `read`
tool's `{ type: "file", mime, url: "data:image/...;base64,..." }` entries in
`state.attachments`) become `{ type: "image", source: { type: "base64", ... } }`
blocks after the text in that call's `tool_result` content, the shape Claude Code
writes, so `/v1/transcripts/blob` serves them by line, block and inner index.
Images over 4,000,000 base64 characters, or past 24,000,000 in one session,
become a text marker. `phren bridge install` writes the plugin and
`phren bridge uninstall` removes it. Plugins load at opencode startup, so an
opencode session started before the install has no transcript and no reported
session id; restart it (or launch a new one) before its chat can attach.

Claude queue messages preserve these phone markers:

- `phrenQueued: true` and `phrenQueueKey`: only an ordinary enqueue whose trimmed
  content does not start with `<` becomes a user bubble. Internal XML-like
  queues, including cross-session messages, do not become the person's bubble.
  A picture-only enqueue (Claude's `[Image #N]` labels and the phone's
  `Attached files on this computer:` footer, no words) reads
  `[Image attachment]`, as a picture-only turn does; its key is still the
  SHA-256 of the original content.
- `type: "phren_queue_consumed"`: consumption emits the queue row's SHA-256
  content key and timestamp, never the payload. A `remove` carries its content,
  so its key is the same as the enqueue's, including internal removals. A
  `dequeue` carries no content: a newest-first read keys it by the prompt turn
  the queue handed to the model (the same SHA-256 the enqueue exported), and
  sets `scheduled: true` when the agent scheduled that turn for itself (a cron,
  `/loop` or ScheduleWakeup fire, or an auto-continuation). A dequeue whose
  prompt turn is not in the read window is exported without a key. The key
  scheme is unchanged.
- `type: "phren_queue_returned"`: a `popAll` (queued prompts pulled back into
  the input) emits its SHA-256 content key and timestamp. The prompt was
  neither consumed nor scheduled, so the phone can drop its queued caption
  without drawing a scheduled check.
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
helper Accessibility access in macOS System Settings. The first refusal in a
Hook run calls `simtap - prompt` (`AXIsProcessTrustedWithOptions` with the
prompt option), which lists the helper in Privacy & Security → Accessibility
and shows the system dialog; the 403 carries `code: "simulator-accessibility"`
and `helper` (the binary's path) so the phone can offer the
`accessibility-settings` action. The helper identifies the
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
