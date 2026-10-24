# Phren Hook

Phren Hook connects the phren iPhone and Android apps to agents already running
on your computers. New users: [Get started](get-started.html) walks through the
whole setup. It is part of the open-source Phren CLI and runs independently of
other phone or terminal applications.

## Install on each computer

Requires macOS or Linux, Node 22.19 or newer, Herdr or tmux 3.0+, SSH, and `lsof`.
Linux uses a systemd user service; macOS uses a LaunchAgent in your signed-in
user session. Without Herdr the Hook uses tmux; see [Without Herdr: tmux](#without-herdr-tmux).

```sh
npx --yes @phren/cli@0.3.57 bridge install
npx --yes @phren/cli@0.3.57 bridge doctor
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
shows. The phone then shows a check code (the first eight characters of the
computer's host key fingerprint); confirm it matches the `Check:` line the
terminal prints. A typed code alone could be guessed by someone on your network
during pairing, so the phone saves the computer only once you confirm, and the
terminal asks you to allow the phone (its key check is on the phone's screen)
before adding its key.

The QR code carries the computer's Tailscale and LAN addresses, the SSH user,
the SSH host key fingerprint (pinned by the phone) and a one-time code. The code
never crosses the network: the phone proves it with an HMAC over its public key,
and the computer answers with an HMAC over its host fingerprint, so a phone that
typed the code by hand pins the right host key too. The listener (port 47291)
accepts one phone, closes after five wrong codes, and times out after five
minutes (`--minutes` up to 30). SSH itself must be on: Remote Login on macOS,
`sshd` on Linux. Under WSL, Windows can also block inbound 47291 and SSH from
the phone; `phren pair` then prints the one-time admin PowerShell
`New-NetFirewallHyperVRule` that allows both.

The manual route still works: in Phren, choose **Enter details** under Add
computer and type the address, port and user. Then choose how this phone gets in:

- **Password**: after you confirm the computer's SSH fingerprint, the phone
  signs in once with your password and runs `~/.local/share/phren/bridge/enroll`,
  which adds the same restricted `phren-iphone` line `phren pair` adds. From
  then on the phone connects with that key. The password is not kept unless you
  choose to save it, and then only in the phone's Keychain. The computer must
  allow SSH password sign-in; keyboard-interactive prompts such as one-time
  codes are not supported.
- **This phone's key**: copy the SSH authorization line into that user's
  `~/.ssh/authorized_keys`, then verify the computer's SSH fingerprint.

A computer the phone can't reach directly can sit behind a jump host
(**Advanced → Connect through a jump host**, like ProxyJump). The phone checks
the jump host's SSH fingerprint, then the computer's, and reaches the computer
by running `nc <computer> <port>` on the jump host. The jump host needs `nc` but
not Phren Hook. Its `authorized_keys` line for the phone only runs that `nc`
command: `restrict,command="nc <computer> <port>" ssh-ed25519 … phren-iphone-jump`.
Sign in to the jump host with its password once to add the line, or copy it from
the form.

Either way, Phren Hook must already be installed (`npx -y @phren/cli@latest pair`
or `phren bridge install`). Existing Phren device keys are migrated with a
backup by the installer.

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

### Gitboy read-only memory

Gitboy, a self-hosted Git server, shows a read-only Phren tab per repository
(that project's findings, truths and tasks), marks files and PRs Phren has
findings about, looks up CI failures it has seen before, prints task tips on
`git push`, and can save a fix as a finding. Phren stays the source of truth;
gitboy stores nothing. Gitboy's server reaches the Hook over SSH with keys
scoped to these routes:

| Scope | Key comment | Routes |
|---|---|---|
| `gitboy-read` | `phren-gitboy` | `GET /v1/projects/:project/memory`, `/memory/files`, `/memory/search`, `/tasks` |
| `gitboy-write` | `phren-gitboy-write` | `POST /v1/projects/:project/findings`, `POST /v1/projects/:project/tasks/complete` |

Each scope is its own key with its own forced command, so a read key can never
write and the write key reads nothing.

**Pair gitboy.** Gitboy generates one ed25519 key per scope and shows the public
halves. On the computer that holds the store:

```sh
phren pair --scope gitboy-read  --key gitboy-read.pub    # or: --key - < file
phren pair --scope gitboy-write --key gitboy-write.pub   # only if gitboy should save findings
```

Each adds one line to `~/.ssh/authorized_keys`:

```
restrict,command="sh ~/.local/share/phren/bridge/dispatch-scoped gitboy-read" ssh-ed25519 AAAA… phren-gitboy
restrict,command="sh ~/.local/share/phren/bridge/dispatch-scoped gitboy-write" ssh-ed25519 AAAA… phren-gitboy-write
```

and prints the SSH user, this computer's host key fingerprint (pin it in gitboy)
and its addresses. Options on the supplied line are discarded and rebuilt; a key
already authorized for anything else is refused, so each scope needs its own
key. Pairing installs or updates the Hook first if `dispatch-scoped` is missing
(`--no-install` refuses instead). Revoke by deleting the key's line.

**What the gateway enforces.** The keys have no PTY and no forwarding. Their
forced command always runs the node gateway, never the raw socket pipe. It
accepts only the SSH command `phren-hook v1 pipe` and reads one HTTP/1.1
request (head up to 256 KiB, at most 32 headers of 8 KiB). It admits only the
scope's routes, each with a strict grammar:

- `<project>` matches `[a-z0-9][a-z0-9_-]{0,99}`.
- Query keys are exactly the route's; unknown, repeated (except `path`) or
  missing keys are refused. Values must be percent-encoded (`+` reads as a
  space) and are checked after decoding.
- A repository path is `/`-separated segments of letters, digits, space and
  `._@+~,=()[]{}#!$&'-`, with no empty, `.` or `..` segment and no leading `/`,
  at most 1024 characters.
- A branch is `[A-Za-z0-9._/+-]{1,200}`, with no `..`, `//`, leading `-` or
  `/`, trailing `/`, `.` or `.lock`, or segment starting with `.`.
- Read routes take no body. The write route needs `Content-Type:
  application/json` and a `Content-Length` body of 1 to 8192 bytes, with
  nothing after it; `Transfer-Encoding`, `Upgrade` and `Expect` are refused.

It then sends the Hook a request it builds itself from the validated values
(a canonical query string, and for the write route a re-serialized JSON body
holding only the schema's fields), so client headers, unknown fields, bodies
and pipelined requests never reach the Hook. Dispatch, store writes, sudo,
terminals, shells, web previews and every other route are refused: other SSH
commands exit non-zero; other requests get a gateway-written HTTP error with
`{"error": "...", "code": "scope-refused"}`: 403 for a route outside the scope,
400 for a malformed request, query or body, 413 for an oversized body, 415 for
a body that is not JSON, 408 when the request does not arrive within 10 s. A
stopped Hook answers 503 with `"code": "hook-unavailable"`.

**Connect.** One SSH exec channel per request, as the phone does:

```sh
printf 'GET /v1/projects/my-app/memory HTTP/1.1\r\nHost: phren.local\r\nConnection: close\r\n\r\n' \
  | ssh -i gitboy-read -o IdentitiesOnly=yes -T me@my-computer 'phren-hook v1 pipe'
```

With the `ssh2` npm library: `conn.exec("phren-hook v1 pipe", …)` without a PTY,
write the request (head, then the body for the write route; ending the write
side afterwards is fine), and read until the channel closes. The bytes are one
HTTP/1.1 response (`Content-Length` set, `Connection: close`): split at the
first `\r\n\r\n`, check the status line, and parse the body as JSON. Send no
second request on the channel.

**Shared shapes.**

```
F = { "id": string, "text": string, "type": string|null,
      "status": "active"|"superseded"|"contradicted"|"retracted"|"stale"|"invalid_citation",
      "created": string|null,
      "citation": { "file": string|null, "line": number|null, "commit": string|null, "name": string|null } | null }
T = { "id": string, "text": string, "created": string|null, "context": string|null }
```

- `id` is `fid:<8 hex>` / `bid:<8 hex>` when the entry has a stable id, else a
  positional id (`L3`, `A1`) that can change between reads.
- `type` is the finding's leading tag (`decision`, `pitfall`, `pattern`, `bug`,
  `workaround`, `context`), removed from `text`; `null` when untagged.
- `created` is a `YYYY-MM-DD` date. `citation` carries the file, line, commit
  and the cited function or type (`name`); the local checkout path never leaves.
- Text that trips phren's credential detector is withheld whole and replaced
  with `[redacted: withheld, contained <kind>]`.
- Every route needs the `memory` module (`404` otherwise; `/tasks` also needs
  `tasks`). An unknown project is `404`, an invalid name `400`, a wrong method
  `405`. `/v1/health` advertises `projectMemory: true`.

**`GET /v1/projects/:project/memory`** returns the whole project:

```
{ "project": string, "store_id": string|null, "remote": string|null, "truncated": boolean,
  "findings": [F], "truths": [{ "text": string }],
  "tasks": { "active": [T], "queue": [T], "done": [T] } }
```

Findings come newest first and are capped at 500; Active and Queue at 200
each; Done at the 50 most recent. `truncated` is true when any list was cut.
`store_id` is the store's 8-hex task-store id when it has one. Tasks are empty
when the `tasks` module is off.

**`GET /v1/projects/:project/memory/files?path=<p>&path=<p>…`** (1 to 500
paths) returns the findings about those files, for PR annotations and gutter
markers:

```
{ "project": string, "store_id": string|null, "symbols": "indexed"|"unavailable", "truncated": boolean,
  "findings": [F & { "match": "file"|"symbol" }] }
```

`file`: the finding's `citation.file` is one of the paths. `symbol`: its
`citation.name` is a function, type or variable the project's code index places
in one of the paths (resolved as a citation resolves it). `symbols` says
whether the code index was used (`code` module on, index built, `@phren/code`
new enough); when `unavailable`, only file matches are returned. Newest first,
at most 500. Up to 500 paths fit the 256 KiB request head, which the Hook
accepts too.

**`GET /v1/projects/:project/memory/search?q=<text>&limit=<1-20>`** (`limit`
defaults to 5; `q` up to 1000 characters, tabs and newlines allowed) ranks the
project's findings and truths against `q`, for "Seen this before" on a CI
failure:

```
{ "project": string, "query": string,
  "results": [{ "kind": "finding"|"truth", "score": number, "matched": number, "text": string, "finding": F|null }] }
```

It uses phren's retrieval tokenizer and best-chunk matcher (the hook's
relevance floor), weighting each query token by how rare it is across this
project's findings and truths (the normalised IDF the hook uses), so the common
words of a stack trace count for little. `score` is the matched share of that
weight, 0 to 1, halved for findings that are no longer active; `matched` is how
many distinct tokens matched. An entry must match at least two of the tokens
the project knows (one, if it knows only one). It reads only this project's
files; it does not open the store-wide search index.

**`GET /v1/projects/:project/tasks?branch=<name>`** returns open tasks (Active
and Queue) for a `git push` tip:

```
{ "project": string, "branch": string, "truncated": boolean,
  "tasks": [T & { "section": "active"|"queue", "match": "branch"|"issue" }] }
```

`branch`: the task's text or context contains the branch name, or its last
`/` segment when that is 4 characters or more (case-insensitive). `issue`: the
branch carries an issue number (`fix/123-login`, `issue-123`, `gh-123`) and the
task is linked to that issue or mentions `#123`, `/issues/123` or `/pull/123`.
One read of `tasks.md`; at most 50.

**`POST /v1/projects/:project/findings`** (`gitboy-write` only) saves a finding,
for "save this fix as a finding". Body, at most 8192 bytes:

```
{ "text": string, "type"?: "decision"|"pitfall"|"pattern"|"bug",
  "citation"?: { "file"?: string, "line"?: number, "commit"?: string, "name"?: string } }
```

`text` is 1 to 5000 characters; whitespace runs (newlines included) collapse to
single spaces and other control characters are refused. `citation.file` is a
repository path, `line` 1 to 10,000,000, `commit` 7 to 64 hex digits, `name` up
to 200 characters. No other fields are accepted. The Hook saves it through the
`add_finding` path: the project's write permission, the secret scan (a finding
carrying a credential is refused with 400), duplicate detection, conflict
annotations, and validation of `citation.name` against the code index. It is
recorded with provenance `tool:gitboy`. Reply (`200`):

```
{ "project": string, "status": "saved"|"duplicate", "finding": F|null }
```

`duplicate` means an equivalent finding already exists and nothing was written.

**Matching a repository.** Add an optional `remote:` with the repository's clone
URL from any host to `<store>/<project>/phren.project.yaml`:

```yaml
remote: ssh://git@gitboy.example/me/my-app.git
```

The `/memory` route returns it as `remote`. `https://`, `http://`, `ssh://`,
`git://` and scp-style `user@host:path` URLs are accepted; passwords (and
http(s) user names) are removed, and local paths, `file:` URLs and URLs with a
query read as `null`.

**No notifications.** There is no gitboy scope for pushing notices to the
owner's phones. Phones register for named notification kinds (approvals and
schedule events) and the app renders each kind; a gitboy kind would need an app
release to register for it and to open its link. Sending gitboy notices under
the approval kind would present them as approvals.

## What connects

Workspace snapshots optionally include `contextUsedPercent` for a tab with one
verified Codex agent. The helper reads the latest reported token count and
context-window limit from a bounded transcript tail, caches unchanged files,
and limits concurrent lookups. Optional enrichment returns partial results after
1.5 seconds; later requests omit metrics while the bounded pending work drains.
Missing limits, ambiguous panes, and unavailable observations omit the metric.

Claude rows in workspace snapshots, the overview socket and `GET /v1/workspaces/panes`
carry `account: { id, label, key }` when the Hook knows which Claude account the
pane runs under: the home of the transcript the pane holds open or that its hook
payload names, else the account recorded at launch (see [accounts](accounts.md)).
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
  can be answered in chat. A Codex pane the Hook runs on its own app-server
  gets the answer in its running turn (see below). Any other Codex pane needs
  the installed Codex's exact-thread inbox command (`codex queue --thread …
  --message …`), which holds the answer until the turn ends. The Hook runs the
  real `codex` binary for this, skipping the session wrapper `phren init` can
  put at `~/.local/bin/codex`. On those other panes, synchronous questions and
  unsupported provider interactions open in Phren's terminal.
- Git diffs, local HTTP app discovery, and SSH browser previews. Changes uses the
  selected pane or worker checkout, collapses untracked directories with optional
  expansion, and marks binaries and incomplete counts. Git failures and timeouts
  are errors. Folder, untracked binary and large staging selections require
  confirmation; ignored files are never force-added. See the
  [status, diff and staging protocol](api-reference.md#repository-status-diff-and-staging).
- The project's code index, when the `code` module is on and the project has
  been indexed: what changed, finding functions and types by name, file outlines,
  definitions, where each is used, and the most and least used.
- Local project activity history, retained on the computer.

From a project, the iPhone can open a new session on a computer:
A general agent can start without a project or a folder. With
`agentFolder: true` on `POST /v1/workspaces/launch`, the Hook creates a private
directory under `<PHREN_PATH>/.runtime/agents/<UTC-date>-<label-slug>-<unique-suffix>`.
It uses this computer's configured Phren directory, the same root used for a
conductor launch, and returns the actual `cwd` with the pane identifiers.
The runtime directory stays local and is excluded from project discovery and store sync.
Separate launches get separate directories; retries with the same `launchId`
reuse the first pane and directory. This also works with `kind: "phren",
mode: "chat"`. Do not combine `agentFolder` with a project, a nonempty `cwd`,
a worktree or the conductor role. An unavailable harness is refused before
the directory is created. The Hook advertises `capabilities.agentFolder`;
older Hooks require an explicit folder, so the phone labels its home-folder
fallback. `capabilities.launchPermissionMode` advertises launch-time
permissions using `supervised`, `auto-edits`, `auto` and `full-access` for
Claude, Codex and Copilot workers.

`POST /v1/workspaces/launch` creates a Herdr workspace (or a tab in one) in
the project's directory and starts Codex, Claude Code, Copilot, OpenCode or
phren's own agent (`kind: "phren"`) in its pane, returning once Herdr has
detected it ready. Herdr cannot start or detect phren-agent itself, so for
`phren` the Hook types `phren agent -i` (plus `--model`, `--reasoning`, and
`--mode chat` / `--session <id>` for a quick chat or a resumed one) at
the pane's login shell, waits for it to be the foreground program, and reports
it to Herdr as agent `phren` under the launch name; its own lifecycle hooks then
keep the pane's status, and the typed line releases that report when the agent
exits. Under tmux it runs like the others, `respawn-pane` under a login shell. `account` (`default`
or a slug) runs Claude under that account's config home: the pane and agent get
`CLAUDE_CONFIG_DIR` (Herdr at pane creation, tmux on the agent's `respawn-pane -e`),
folder trust is written to that home's `.claude.json`, and the reply echoes
`account`. Before any pane exists the Hook answers 409 `harness_unavailable`
(not installed) or `account_unavailable` (unknown, signed out, or an account for a
harness without accounts); see [accounts](accounts.md). Otherwise
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

`GET /v1/projects/:project/git` answers like `POST /v1/git/pulls` (host,
branch, open pull requests with checks, the branch's own request) plus
`project` and `directory`, for a project rather than a pane: it reads the
checkout this computer recorded for the project, else the first folder
`/v1/projects/locate` finds. With no checkout here it is `404` with
`code: "no-checkout"`. It needs the `git` module. Phren desktop's Projects page
shows it as the project's Code block.

`POST /v1/projects/:project/git/host-token` takes `{ token, expectedHost }`
(both required), using exactly the same checkout lookup and `404` with
`code: "no-checkout"` as that GET. It needs the `git` module and is advertised
by `capabilities.projectHostToken: true`. No chat pane is needed.

The pane route `POST /v1/git/host-token` accepts optional `expectedHost` alongside
`token`, the pane target and `expectedRepository`. Both token routes resolve the
API destination fresh, including the global `phren.<remote-domain>.api`
override, and, when `expectedHost` is supplied, compare its host and port
case-insensitively with the destination the client displayed (for example
`other.example:8443`). The resolved API URL is pinned through token validation;
a config change after the check cannot redirect that validation call.
Project git info, pane git status and pull-list responses include `host.apiHost`
for this destination, alongside the remote's `host.domain`. API URL credentials
are never exposed. Clients show “Sends the token to <api host>” and submit that
`apiHost` as `expectedHost`. A difference, including a missing remote host, returns
HTTP `409` with `code: "host-changed"` before any token-bearing network call or
save. The client must reopen Connect to review the new host. Clients should
always send `expectedHost`; omission remains compatible on the pane route only.
Tokens are validated with the resolved GitLab or gitboy host and saved privately
on that computer, never logged or returned. Credential temp files are created
with mode 0600 and removed even when a write fails partway through. An empty token disconnects, with the
same host guard. GitHub continues to use `gh auth login` on the computer.

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

`GET /v1/harnesses` reports which harnesses (Claude, Codex, OpenCode, Copilot, phren) are
installed and usable on this computer, and each Claude account's sign-in state; the
same list rides on `GET /v1/dispatch/capacity` as `harnesses`, next to `usage` (the
room left on Codex and each Claude account, and whether it is exhausted, which `anywhere` uses to skip an account with no quota left). `phren bridge accounts`
prints it, `phren bridge accounts add <slug> [--label <name>]` creates another Claude
home, `phren bridge accounts label <id> <label>` names one, and
`phren bridge accounts credit <id> --amount <usd>` enters an API credit to estimate. See
[Accounts](accounts.md).

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
store's `.runtime/approvals` (OpenCode 1.18 never calls the plugin's
`permission.ask` hook, so the plugin takes the ask from its `permission.asked`
event, keeps the card up to 30 minutes while the TUI's own prompt waits, and
replies to the phone's answer through the process's own API; an answer in the
TUI withdraws the card), and the Hook watches that directory, maps the ask
to its pane through the recorded session binding or Herdr's opencode session id,
and pushes it to registered phones with the ask's title and message. The same
`POST /v1/approvals/answer` route writes the plugin's answer file. The card's
`options` offer once, "Allow for this project", "Allow everywhere" and Deny;
both grant scopes map to OpenCode's `always` reply (which lasts the running
session), and "Allow everywhere" also adds the tool to
`~/.config/opencode/opencode.json` as an allow rule under a lock with an atomic
rename.

An OpenCode the Hook launches serves its own HTTP API: it runs as
`opencode --port <free port>` with a random `OPENCODE_SERVER_PASSWORD`, and the
Hook records the pane under `<bridge>/opencode-panes/`. For that pane the Hook
sends prompts and dispatch briefs over the API (confirmed by the user turn
appearing in the session), follows its event stream for permission asks and
questions, answers them over the API with no 55-second hold (an ask stays on
the phone for as long as OpenCode waits, and leaves it when the TUI answers
first), and stops a working turn from the phone's Esc with `session.abort`.
The pane stays the owner's live view of the same conversation. An OpenCode
started by hand keeps the typed path and the plugin's approval files.

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
  typing. A message sent while a turn runs steers that turn (Codex takes it at
  its next step, like a mid-turn Claude message) rather than waiting for it to
  end.
- **`/new` and `/resume`.** The Hook follows the pane's TUI to the thread it
  switched to, so the phone's messages, approvals and Escape go where the pane
  is.
- **Approvals.** Command, file-change and permission requests arrive as server
  requests and become the same approval card and push as a held
  PermissionRequest, answered over RPC (`accept` or `decline`, a permission
  grant or none) with no 55-second hold: the card stays until someone answers.
  Answered in the pane's TUI first, the card goes away. The PermissionRequest
  callback for these threads returns at once, so there is one card, not two.
- **Questions.** An async question (`request_user_input_async`) is answered by
  a `turn/steer` into the running turn with Codex's own
  `<send_user_message_question_reply>` message, as the TUI sends it (a new
  turn when none is running). A synchronous `request_user_input` and a form MCP
  elicitation with single-value fields (text, number, yes/no, one choice) are
  question cards in chat, answered as the reply to that server request.
  Secret inputs, URL elicitations and multi-select fields stay in the pane.
  Chat shows a question reply as the question and its answer.
  Each server starts with `-c features.default_mode_request_user_input=true`
  and a developer instruction to ask with the blocking `request_user_input`,
  not the async tool or a plain-text question, so a worker waits for the
  owner's answer instead of carrying on without it
  (`PHREN_CODEX_BLOCKING_QUESTIONS=off` leaves both out).
- **Sign-in.** Every Codex process on the computer shares `auth.json`, and the
  refresh token rotates on use. The Hook checks it hourly and, once the sign-in
  is six days old, refreshes it once (`account/read` with `refreshToken`, on a
  running server or a short-lived one), so the other processes find it fresh
  instead of refreshing together and spending a used token
  (`PHREN_CODEX_AUTH_REFRESH=off` turns this off).
- **Escape.** `/v1/keys` Escape on such a pane with a running turn declines the
  thread's parked requests, then interrupts the turn (`turn/interrupt`).
- **Restart.** Servers outlive the Hook, and a turn keeps running while the
  Hook restarts. On Linux the Hook starts each server in its own systemd scope
  (`systemd-run --user --scope`, unit `phren-codex-<id>.scope`), because
  stopping `phren-hook.service` kills every process in its cgroup, detached or
  not; without systemd-run the server runs in the Hook's service and stops
  with it. On macOS the detached server leads its own process group, which
  launchd leaves alone. A restarted Hook reads
  `<bridge>/codex-servers/*/server.json`, reconnects to each live server and
  rejoins its thread; Codex replays requests still waiting, so their cards come
  back. Each 5-second tick forgets a server whose process ended and stops one
  whose pane closed, or whose pane or terminal server has shown no Codex for
  two minutes. A server that ended during a turn (it crashed, or stopped with
  an older Hook) cannot finish it, so the pane's dispatch returns `failed`
  with that reason instead of working forever.
- **Returns.** Each registered thread's running turn and its last finished turn
  (id and status: `completed`, `interrupted`, `failed`) are kept in its
  `server.json` for the returns loop.

`PHREN_CODEX_APP_SERVER=off` in the Hook's environment keeps every Codex launch
on the typed path. A server that fails to start falls back to it for that
launch.

Known gap: all servers share one `CODEX_HOME` (one sign-in, one refresh token).

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
  `$TMUX_TMPDIR/tmux-<uid>/` and `/tmp/tmux-<uid>/`: the 16 most recently
  active servers that answer, so stale sockets left by killed runs never hide a
  live one. A server started with
  `tmux -S <path>` elsewhere is not found.
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
- Conductor context: Claude and Codex turn-start hooks restore the role and
  shipped brief path after startup, resume or compaction. OpenCode's system
  prompt plugin checks the current process and root conversation. See
  [conductor setup](conductor.md#skill-discovery-and-worker-setup).
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
- A fresh Codex: Codex runs its SessionStart hook only with its first turn, so
  a Codex that has just opened has sent no lifecycle event. Until it does, the
  Hook reads its screen on the same throttle: a startup menu (folder trust,
  hooks to review, sign-in) is blocked, its composer idle, its interrupt hint
  working. The phone's first message then goes through without a visit to the
  terminal.
- Chat, sends (pasted as one bracketed paste, then Enter), keys, approvals, the
  terminal (`phren-hook v1 terminal tmux` attaches the phone's SSH terminal to
  the server), and launching Claude Code, Codex, Copilot, OpenCode or phren-agent into
  `tmux-phren`.
- Scrolling the phone's terminal: tmux draws on the alternate screen, so the
  phone keeps no history of its own. With `set -g mouse on` tmux turns on the
  phone's mouse reporting and a swipe is a wheel event, as under Herdr. With
  tmux's default `mouse off` the phone asks `POST /v1/workspaces/scroll`
  (`paneId`, signed `lines`, positive for older output; without `paneId`, the
  pane of the last active client), which does what tmux's own wheel binding
  does: an app tracking the mouse (Claude, Codex) gets the wheel events, and
  any other pane scrolls in `copy-mode -e`, which ends at the bottom. `lines: 0`
  leaves copy mode, which the phone sends before typing. The reply's `history`
  says whether the pane is still in copy mode. Refused for Herdr servers.
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

## Pull and merge requests: GitHub, GitLab and gitboy

The Changes screen shows the branch's pull or merge request with its checks or
pipeline, review and merge state, and can open and merge it. The Hook reads the
host from the remote's URL; name a self-hosted one with
`git config remote.origin.phrenHost gitlab|gitboy|github`.

- **GitHub** uses the GitHub CLI's sign-in: `gh auth login` on the computer.
- **GitLab** uses `GITLAB_TOKEN`, glab's sign-in, or a token you connect.
- **gitboy** uses a personal access token with `read:user`, `read:repo` and `write:repo` (the "Phren Hook" preset in gitboy's Settings → Access tokens).

Connect GitLab or gitboy from the desktop's Changes pane, or on the computer:

```sh
phren bridge git-host set gitlab.example.com gitlab   # paste the token when asked
phren bridge git-host list
phren bridge git-host remove gitlab.example.com
```

The token is checked with the host first and stays on that computer, in the
Hook's own folder (mode 600), never in your Phren store.

## Maintain and diagnose

```sh
npx --yes @phren/cli@0.3.57 bridge status
npx --yes @phren/cli@0.3.57 bridge update
npx --yes @phren/cli@0.3.57 bridge rollback
npx --yes @phren/cli@0.3.57 bridge uninstall
```

`update` installs the version of the CLI you invoke; choose an explicit newer
version when upgrading. On Linux, Codex workers started by an earlier Hook
(before scoped servers) run inside the Hook's service and stop when it restarts: `install` and
`update` name them and wait up to ten minutes for their running turns to
finish (`--force` restarts at once). The systemd unit uses `Restart=always`,
so a Hook that exits on its own comes back; `systemctl --user stop` still
stops it. The standalone bundle survives npm cache cleanup.
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

### Store sync

The Hook reconciles every store this computer has with its remote every five
minutes (the first pass a minute after it starts; `PHREN_STORE_SYNC_SECONDS`
changes it, `0` turns it off; the manual preset and project-local installs never
sync), so schedules, tasks and findings converge on a computer nobody is typing
on. Each pass removes abandoned state (a Git index lock older than ten minutes,
a merge or rebase untouched for an hour, Phren lock files whose process has
exited, backup refs older than 14 days, worktree records whose folders are
gone), commits pending store writes, merges the remote and pushes. A readonly or
pull-only store only pulls.

When both sides moved, the pre-merge HEAD is kept as `refs/phren/backup/<ms>`
and the merge resolves knowledge files without losing either side: tasks by
task id (a repeated id collapses to its completed, then Active, then longest
record), findings, truths, notes, journals and the review queue as a union,
task archives by task id. Generated parts take the remote's copy and are
regenerated: summary.md's "What phren knows" block and the topic `## Now`
blocks. Only a file a person writes (AGENTS.md, CLAUDE.md, a skill) changed on
both sides stops the merge; it is aborted, named in the store's health, the
sync log and the next session's start, and `phren doctor --fix` retries. One
computer at a time, the holder of `.config/maintenance-writer.json` (renewed
daily, taken over after three idle days), rewrites generated files in
background maintenance, so two computers do not regenerate the same lines.

If GitHub refuses this computer's SSH key for a `git@github.com:` remote and
`gh` is signed in, the store switches that remote to HTTPS with `gh` as its
credential helper and says so in `background-sync.log`; when `gh` cannot help
either, the store's health names both failures.

### Health and the canary

Current iOS, Android and desktop send `expectedRepository` on Git writes so the
Hook can refuse a write after the pane moves to another checkout. During the
compatibility window, older requests without it still run. The Hook logs one
warning per client and write route per run and counts every omission in
`GET /v1/health/details` as `gitWrites` rows (`client`, `count`, `warning`):
`N git writes without expectedRepository from <client>`. Counts reset at Hook
restart. Available client/version and user-agent headers identify the request;
the raw SSH pipe does not expose the paired key label. Missing identity is
reported as `unknown client`.

Hooks will start refusing Git writes without `expectedRepository` no earlier
than the first Hook release on or after **2026-11-15**, once warning counts show
no older clients. The release switch remains off by default. When enabled, it
returns HTTP 400 with
`{ "error": "This app is too old to change Git safely. Update it.", "code": "expected-repository-required" }`.
This covers stage, unstage, discard, commit, push, opening and merging a PR,
host-token, checkout (including branch creation), fetch, pull and apply; see
the [Git route contract](api-reference.md#commit-push-and-pull-request).

`GET /v1/health/details` answers whether phren is healthy on this computer, and
the phone's Settings → Health (or Health on a computer's page in Agents) shows one
section per computer from it. `phren status` prints the same data under Health.
It reports:

- `versions`: Phren Hook, Herdr, Claude Code, Codex, Copilot and OpenCode, each
  from `--version` (3 second limit, cached 5 minutes), or `missing` when absent.
- `stores`: each registered store's branch and ahead/behind against its upstream
  as last fetched (nothing is fetched here), the last push outcome,
  `lastSuccessfulPullAt` and `lastSyncedAt` (newest successful pull or push),
  `diverged` (both sides have commits the other lacks), `stale` (a store with a
  remote that has not synced for over an hour), the failure while it is
  failing, and `warning`, one line to show as is whenever the store is
  `degraded`. The overview socket and `GET /v1/workspaces` carry the same lines
  as `storeWarnings` (absent when every store is fine), so a computer list can
  flag the computer without asking for health.
- `schedules`: whether the scheduler is ticking and the newest run in
  `schedule-runs.jsonl` (schedule name, project, status, reason, time).
- `peers`: every computer in `hooks.yaml`, probed through its verified Hook with a
  5 second limit. `listsBack` is false when that computer's own `hooks.yaml` does
  not list this one (matched by pinned host key or name), so a one-way link
  shows; it is null for a Hook too old to say.
- `push`: whether direct APNs is configured (`apns.json`).
- `canary`: the last `canary.json`.
- `gitWrites`: counts and warnings for writes without `expectedRepository`, per
  client for this Hook run, empty when every write supplies it.

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

### sudo from the phone

A `sudo` with no terminal, such as a Claude Code `!` command or an agent's
shell tool, fails with "a terminal is required to read the password". The Hook
installs an askpass helper so the phone can answer it instead:

```bash
phren sudo killall -HUP mDNSResponder     # manual use, and inside a `!` command
sudo -A killall -HUP mDNSResponder        # what an agent runs; SUDO_ASKPASS is already set
```

`phren bridge install` writes `<bridge>/askpass` (mode 0700), a short script
that clears `NODE_OPTIONS` and preload variables and runs the installed
bundle's `askpass`. `sudo -A` runs it with its prompt, and it asks the Hook
over the owner-only `agent.sock`. Before the phone hears anything, the Hook
checks the whole chain, so the password can only reach sudo:

- the asker is the Hook's own node running its bundle's `askpass`, with no
  node flags (and, on Linux, no `NODE_OPTIONS` or `LD_PRELOAD` in its
  environment);
- its parent is `<bridge>/askpass` itself, not some other `SUDO_ASKPASS`;
- that script's parent is `sudo` running as root (effective uid 0, which no
  program of yours can fake);
- the asker's stdout is a pipe that no other process of yours holds, so the
  password goes to sudo and nowhere else (`lsof` on macOS, `/proc` on Linux);
- the request came from that process: on macOS the other end of the
  connection must be held by the asker alone, and on Linux the Hook writes the
  password straight into the asker's stdout rather than back over the
  connection, so a program that names another process gets nothing.

It then reads that sudo's command line itself (`ps`, or `/proc/<pid>/cmdline`
on Linux) and shows the phone the computer, the command without sudo's own
flags, the target user when not root, and the session that asked when the
helper runs in a Herdr or tmux pane. The
phone gets an approval push ("sudo on Mini", the command) and, while Phren is
open, a sheet with a password field, Approve and Deny.

The password goes from the phone to the Hook to askpass's stdout, which only
sudo reads. It is used once: the request is forgotten as soon as it is
answered, and the password is never logged, written to disk, put in a push, a
transcript or a frame, or shown to the agent. A wrong password makes sudo ask
again, which is a new request; the Hook tells the phone the last one was refused,
and after a password sudo accepted the phone can offer to keep it in its
saved passwords (on the phone only, behind Face ID). Deny, no answer within two minutes
(`PHREN_SUDO_TIMEOUT_MS`), the asker going away, or no phone that can answer
(no approval push set up and no Phren app open) makes askpass exit 1, so sudo
fails with a short reason instead of hanging.

The answer route trusts its caller the way every Hook route does: the phone
reaches it over its paired SSH key, and a call that names an agent's pane is
refused. Anything else that can already reach this computer's Hook socket
(a process running as you, or a linked computer over its SSH key) could deny
a pending request or answer it, but an answer carries a password, so it only
gets sudo to run if it already knows your password. The password itself never
passes through anything another process can read.

Agents the Hook starts (dispatched workers, conductors, scheduled runs, and
headless schedules) get `SUDO_ASKPASS` in their environment, so `sudo -A`
works in them without setup. sudo only uses the helper when asked: plain
`sudo` with no terminal still fails, so agents must pass `-A`. In your own
shell, `export SUDO_ASKPASS=~/.local/share/phren/bridge/askpass` makes
`sudo -A` work there too.

- **macOS**: works with the system sudo as installed. sudo caches the
  credential as usual (per terminal, or per parent process when there is no
  terminal), so a second `sudo -A` soon after may not ask again.
- **Linux**: the same with sudo 1.8 or newer. A sudoers `Defaults requiretty`
  refuses every sudo without a terminal, askpass or not; drop it for your user
  to use this. PAM setups that ask for a second factor still ask for it.

Any program running as your user can ask for a sudo, as it could type `sudo`
in a terminal, so the phone always shows the exact command before you type
the password: deny what you did not expect. The chain check stops a program
from simply collecting the password; one that attaches a debugger to the
askpass process is beyond what a Hook running as you can prevent.

### Spoken replies for talk mode

The phone's talk mode reads an agent's replies aloud. `POST /v1/speech` with
`{ "text": "…" }` (1 to 2,000 characters, usually one sentence) voices the text
with ElevenLabs and streams the audio back. The Hook advertises it as the
`speech` capability.

The model is this computer's setting, else `eleven_v4_turbo`. Set it with
`phren bridge speech-model set <model-id>` (`show` prints it, `clear` goes back
to the default); it is stored next to the voice in `speech.json` and install
and update keep it. When the model fails (an ElevenLabs error that names the
model, or a 5xx) the Hook retries the reply with `eleven_flash_v2_5` and keeps
using Flash for 10 minutes. It does the same when the median of the model's
last three short replies (200 characters or fewer) took more than 1.5 s to
start: the first streamed byte, or the whole timestamped reply talk mode waits
for. Measured on 2026-09-28 with a 95-character reply, v4 Turbo started
streaming in 200-400 ms and finished a timestamped reply in about 1.1 s, Flash
v2.5 in 180-460 ms and about 0.4 s. A key, quota, voice or rate-limit error
never switches model.

The audio format is the best the phone plays and the ElevenLabs plan allows,
tried in this order: `pcm_44100` (16-bit little-endian mono PCM at 44.1 kHz,
Pro plans and above), `mp3_44100_192` (Creator and above), `mp3_44100_128`,
then `pcm_24000` (every plan, the base). The phone lists what it plays in
`formats` (names from the `speechFormats` capability); a phone that sends none
gets `pcm_24000`, as every phone did before. A format the plan refuses (403
`output_format_not_allowed`) is skipped for 6 hours. The streamed reply names
what it sends in `X-Phren-Audio` (`pcm_s16le;rate=24000;channels=1`,
`pcm_s16le;rate=44100;channels=1`, `mp3;rate=44100;bitrate=192000;channels=1`
or `mp3;rate=44100;bitrate=128000;channels=1`) and `X-Phren-Audio-Rate`
(`24000` or `44100`), and the model in `X-Phren-Speech-Model`.

With `"timestamps": true` (the `speechTimestamps` capability) the Hook calls
ElevenLabs' `with-timestamps` endpoint instead and answers JSON: `{ "audio":
"<base64>", "audioFormat": "pcm_s16le;rate=24000;channels=1", "sampleRate":
24000, "format": "pcm_24000", "model": "eleven_v4_turbo", "alignment": {
"characters": [...], "starts": [...], "ends": [...] } }`, the times in seconds
from the start of the audio whatever its sample rate, or `alignment: null` when
ElevenLabs sent none. The alignment covers the words spoken, after the Hook
strips the reply's markdown, so `characters` joined is the spoken text. The
phone uses it to highlight the word being read in the chat.

With `"timestamps": true, "stream": true` (the `speechTimestampStream`
capability) the Hook calls ElevenLabs' `stream/with-timestamps` and streams
`application/x-ndjson`: one `{ "audio": "<base64>", "alignment": {...} | null }`
line per ElevenLabs chunk, with the same `X-Phren-*` headers as the audio
stream, the alignment times in seconds from the start of the sentence. The
first line arrives in about 0.3 s with v4 Turbo; the plain timestamped reply
waits for the whole clip, about 0.9 s (measured 2026-10-01).

How fast the first audio arrives. The Hook passes ElevenLabs' body through as
it arrives, sending the headers before the first byte. It reaches ElevenLabs
over its own keep-alive connection pool, so the next sentence skips the TCP and
TLS handshake even after a pause of up to a minute. `phren bridge speech-region
us` sends every ElevenLabs request this computer makes (spoken replies, the
live socket, the voice list, Scribe dictation and the usage read) to
ElevenLabs' US-only endpoint (`api.us.elevenlabs.io`), and `global` (the
default) to `api.elevenlabs.io`. It is stored in `speech.json` like the model
and read on every request. A request ElevenLabs goes quiet on for 30 s, before
its headers or between two chunks of audio, is given up on, and a pooled
connection ElevenLabs closed while idle is retried once on a fresh one.

`WS /v1/speech/live` (the `speechLive` capability) voices a reply while it is
still being written. Open it with optional `voice` and repeated `format`
query parameters, send `{ "text": "<more of the reply>" }` as the reply grows
and `{ "done": true }` when it is complete. The Hook speaks it a sentence or
line at a time, as soon as each one is complete, and sends back `{ "type": "start", model,
format, audioFormat, sampleRate }` with the first audio, then `{ "type":
"audio", audio, alignment }` frames (alignment in seconds from the start of
the socket's audio), then `{ "type": "done" }`, or `{ "type": "error", code,
error }`. v4 Turbo works on ElevenLabs' text-to-dialogue WebSocket (its
text-to-speech WebSocket refuses v4 models), where the first audio came about 140 ms
after ElevenLabs had the first complete sentence (2026-10-01); Flash v2.5 is the fallback, on
the text-to-speech WebSocket with `auto_mode`. One socket voices one reply.
Before any audio, Flash takes the reply over (with everything said so far)
when ElevenLabs refuses the model, sends an error frame other than the key,
quota or rate limit, closes the socket, takes over 5 s to open it, or sends
no audio within 5 s once it must be voicing: the reply is done, or 300
characters of it are in (a shorter piece can sit in ElevenLabs' buffer while
the agent thinks). Text the phone sends while the Hook reads its settings is
kept. A reply with nothing to say (only code, say) ends with `done`; one past
ten minutes ends with the error `speech-limit`; a phone that stops reading the
audio (4 MB queued) is closed with `speech-failed`.

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
own text. `{"type":"ready"}` says ElevenLabs answered and audio is flowing.
A socket lasts at most ten minutes. The Hook never closes it without saying
why: an `error` frame, or `{"type":"end","reason":…}` with `session-limit`
(the ten minutes ran out; open a fresh socket) or `upstream-closed`
(ElevenLabs hung up). The phone ignores frame types it does not know. The Hook advertises it as the
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

### Conductor hand-off queue

`POST /v1/hand-off` takes `{target, text, deliveryId?, origin?}` and returns
`{ok, target, deliveryId, state, queued, delivered, deliveryUncertain?, error?}`.
`origin` is the sending session's full target, for a delivery notice.
`POST /v1/hand-off/status` takes `{target, deliveryId}` and returns the same
record without sending input, even after the worker's pane closes. States are
`queued`, `delivered`, `uncertain`, and `failed`. A reused id with different
text or target is a 409. These routes require the conductor module. The phone
can show the queued message, then its confirmed or uncertain outcome by id.

The overview and `/v1/dispatch/workers` observations carry `stalled:true`,
`stalledSince` (ISO time) and `stallFor` (seconds) when both the screen and
transcript are unchanged while working for `PHREN_STALL_MS`.

With `capabilities.moveToComputer: true`, the owner can continue an ordinary
chat on another verified computer. `GET /v1/sessions/move/computers?project=<name>`
returns `{computers, localClaudeLogins}`. Each computer has `name`, `self`,
`online`, `hasCheckout`, and `harnesses` (`source`, `usable`, optional `accounts`
with `id`, `label`, `email?`, `plan?`, `fiveHourLeft?`, `weekLeft?`,
`fiveHourResetsAt?`, `weekResetsAt?`, `usable`, and `current`). Every Claude
login is included, including unusable logins and logins on this computer.
Pass `session=<current-session-id>` (and `server` when needed) to mark its
account `current: true`; other accounts have `current: false`. Percentages are
remaining usage from the hand-off overview's Claude usage. Offline peers stay
in the list, disabled; a missing checkout also disables a destination.

`POST /v1/sessions/move` accepts `to.computer`, an exact verified hooks.yaml
peer name. Omitted or self uses the local move. A peer forces `mode: "new-chat"`:
the source writes its hand-off and the peer starts in its own registered
checkout of the project, over the existing pinned SSH launch path. The full
hand-off is sent inline, with credential values redacted;
login credentials, environment and checkout files are never copied. The new
conversation must confirm its first brief and be running before `state: "moved"`.
The old chat stays open, including on failure. The record has `to.computer`,
`placement: "peer"` and `handedOffTo: {computer,target}`. Unknown peers return
404; offline peers, missing checkouts and unusable harnesses/accounts return
409 before the hand-off request. Peer calls have bounded timeouts.

Listing destinations and starting a cross-computer move require the owner.
Scoped gitboy keys, MCP agents (including dispatched workers), and peer-originated
requests cannot start one. `GET /v1/sessions/move/availability?project=<name>`
is a local-only facts probe for the owner and verified peers; it never fans out
or launches a chat. A dispatched worker moved by its owner re-points its receipt
to the destination computer so future returns and approvals follow it.

Peer hand-offs omit process command lines (only a child-process count is
included). Control characters are normalized, then the whole outbound prompt
(including fallback conversation text) is structurally redacted: password,
passwd, pwd, token, secret, api-key/api_key, auth and bearer values in flags,
assignments and mappings, Authorization/Bearer headers, and URL userinfo become
`[redacted]`. Recognizable credential values are redacted in place; a long path or other
base64-looking text does not refuse the move. Redaction applies to prose fields,
never opaque protocol tokens, capabilities or other structural metadata. Copilot is unavailable for cross-computer
moves because it has no launch-brief arrival signal: its peer listing has
`usable: false` and a `reason`; local Copilot moves still work.

An omitted Claude account selects any usable login with room, preferring the
most five-hour headroom and then weekly room, as the launcher does. The Hook
pins that choice in `to.account`, records `accountChoice`, and advertises the
listing's `selectedAccount`, so the receiving launcher uses the reported login.

Moved-worker observations carry `computerFingerprint`, derived from the
verified SSH host key and enrolled SSH username, and `computerId`, advertised by
the destination Hook's local availability endpoint. A destination matching the
dispatching Hook's own stable ID is routed locally, so A→B→A moves preserve
returns and approvals without listing self as a peer. The dispatching Hook
resolves it against its own pinned peer directory and records its own destination name. It never treats another
Hook's alias as a local address. An absent or ambiguous identity retains the
previous receipt routing and reports an error; it cannot send returns or
approvals to a different computer that happens to share the alias.

With `moveConductorToComputer: true`, a conductor can move with its role.
The original Hook A keeps its receipts, pending approvals, standing grants and
serialization. B prepares an inactive successor; only after its exact conversation
is confirmed running does A compare the captured role generation and atomically
commit ownership to B's pinned SSH account, Hook ID and target. A fences the old
chat, forwards late returns and proxies the successor's dispatch, hand-off,
approval and grant operations. Approval action IDs are preserved, and return
notices use the durable hand-off queue's stable delivery IDs. During preparation,
returns remain pending on A instead of being acknowledged to the old chat after
its hand-off was written. B fails closed
with a clear error while A is unreachable. A stays required for coordination.

Prepare, commit and status are persisted by move ID on both Hooks under
`conductor-role.json` and `conductor-moves/`. A pending move blocks new conductor
dispatches/hand-offs and role make/start/stop; it also refuses to begin while an
existing conductor operation is in flight or a worker computer is unreachable.
Before commit the original chat keeps authority. Failures before commit abort
preparation and tell the successor it is not the conductor. An uncertain commit
is reconciled from A's durable generation, never rolled back. Restarts reuse the
same move and launch IDs. Private source recovery data is withheld from peer
status replies. Local conductor moves retain their existing CAS and
receipt re-pointing behavior.

For a projectless conductor, pass `conductor=1` to destination discovery
(`project` may be omitted); its
successor starts in B's own Phren store. No checkout or credentials are copied.
The peer protocol uses `POST /v1/conductor/move/prepare`, `/commit`, `/operate`,
`/ack` (return acknowledgement), and `/notice`, with `GET /v1/conductor/move/status`, `/launch`, `/operation`,
and `/notification`. Local agents use `POST /v1/conductor/call`; peer-originated
calls to that local route are refused. A peer's claimed alias and generation
are insufficient authorization: each write fetches the canonical prepared
intent back over the receiver's own pinned SSH account and verifies the Hook ID.
Generic peer dispatch, approval, return-read and grant-write requests are
refused; only the authenticated conductor routes accept those operations. Unacknowledged operations
keep their persisted operation ID across restarts for mutations; a lost peer reply
cannot dispatch a second worker. Read operations (returns, grants-list and hand-off
status) use fresh operation IDs after an uncertain attempt. Returns stay unread
on A until B durably receives the result and acknowledges its exact version; a
failed read never consumes them. Confirmed refusals allow a new intent, while
uncertain mutations fail closed.
Credential-bearing text is withheld from peer operation replies. The owner can end delegation with conductor stop on A; B
reconciles that revocation and neither previous chat regains the role.

Owner-only actions use the existing owner request envelope: owner phone,
desktop and CLI calls carry no agent or peer origin. Scoped gateways rebuild
the envelope and stamp peer requests, so peers cannot impersonate that owner
path. Existing session move listings keep their normal behavior. Peer move-status
reads require the recorded source/destination identity. Peer availability omits
account emails and plans; owner discovery includes them.

Newly enrolled computer keys use `dispatch-scoped peer:<name>` instead of
`dispatch-scoped peer`; the restrictions, public key and comment are unchanged.
Install never rewrites existing computer keys. An unknown named enrollment
retains legacy peer behavior on existing routes. The new continuation launch
and conductor succession routes require a known verified reverse enrollment;
explicitly re-enroll a legacy key to use them. Conductor operations and status
check the recorded counterpart's host-key/SSH-account identity and pinned Hook ID.

A forwarded dispatch or hand-off without `computer` means the successor's
computer B. Named destinations are translated to pinned identities and resolved
through A's verified directory, so local aliases need not match. Unknown
identities are refused. `anywhere` explicitly uses the original Hook A's
directory and placement policy. All receipt workers, including legacy receipts,
must resolve to the same host-key/SSH-account and Hook identity in B's directory.
Automatic account failover obeys the move fence and, after commit, verifies the
successor generation before dispatch. Hand-off completion notices follow the
successor with stable delivery IDs. Returning a worker home requires its exact
move's local arrival and a matching live pane; a peer's claimed home ID alone
cannot change routing. Existing brief IDs cannot be overwritten.

Clients list Claude accounts first across self and linked computers, with email
(or label), plan, computer, both usage windows and reset times. The current login
is marked and disabled; same-computer choices use `to.account`, peer choices use
`to.computer` plus `to.account`. Other harnesses follow in a secondary section;
model and effort controls are secondary. Offline computers and missing checkouts
stay visible with their reason. Without the conductor capability, peer conductor
rows say “Update <computer>'s Hook to move the conductor”.

`claudeAccountAdd: true` enables owner-only `POST /v1/accounts/claude/add`
with `{slug}` (`^[a-z0-9][a-z0-9-]{0,31}$`, lowercase, not existing). It opens a new pane
running `phren bridge accounts add -- <slug>` and returns `{target, terminalOnly:true}`.
The target has server/workspace/tab/pane/source, with no invented conversation ID.
Open that pane's terminal view so the owner can complete the interactive Claude
login. Phren never types or forwards credentials. The single-login hint can also
offer this action.

Peer launches use `POST /v1/sessions/move/launch` with a stable brief/move ID and
the expected destination `computerId`; `GET` on the same route reads its placement.
The receiver persists an uncertain intent before creation and replays the saved
target on retry. A peer launch first pulls the canonical, owner-admitted source
intent from `GET /v1/sessions/move/intent?id=<move-id>` over the receiver's own
verified reverse enrollment; knowing an id cannot authorize an arbitrary launch.
That intent route admits only the move's recorded destination. A never-received
launch reports `not-placed` only after that same source-intent verification.
An interrupted creation is reconciled through that brief's
arrival, never by creating a second pane. After ten minutes, a successful terminal
inspection that confirms the unique creation label and recorded pane are both
absent reports `not-placed`; A then fails the uncommitted move and releases the
original conductor. Transient recovery errors use persisted exponential backoff, starting at five
seconds and capped at ten minutes. Refusals (4xx) fail with their reason; recovery
gives up after the ten-minute absence window. A committed conductor generation
is never rolled back, even when the move record fails. Legacy intents
without enough placement metadata require the owner to abort before commit. The owner may
`POST /v1/sessions/move/abort` with `{id}` before commit. A committed or uncertain
ownership switch is reconciled instead of rolled back. Continuations also record whether
the chat is a dispatched worker, so an ordinary continued chat remains movable
without requiring a dispatcher. The source persists an `uncertain`
placement immediately and reconciles it across Hook restarts using the same ID.

A dispatched worker's cross-computer move first requires its original dispatcher's
`workerRelocation: 1` capability from its original dispatcher, checked with
`GET /v1/dispatch/relocation?id=<dispatch-or-move-id>&session=<session>`.
A compatible dispatcher may not yet have observed the preceding relocation.
The receiving launch preserves the original receipt ID as `workerDispatch`, so
`knownDispatch: true` proves the dispatcher recognizes that receipt even while
the new session is still unknown. An unrelated Hook advertising the capability
cannot authorize relocation. This allows an immediate move home before the
next poll. Without compatibility, the move refuses with “Update the dispatching computer's Phren Hook
first”. Destination routing verifies host key, SSH username and the destination
Hook's ID over the dispatcher's own pinned connection. Polls, approvals and
cleanup re-verify that tuple after relocation; changing an enrollment retains
the old receipt and pending approval instead of sending it to a replacement Hook.
Without `moveToComputer`, existing clients and local moves are unchanged.

### Session moves

With capability `sessionMove`, `POST /v1/sessions/move` takes
`{target, to: {harness, account?, model?, effort?}, mode?: "replace" | "new-chat", id?, handoffTimeoutMs?}`
and answers once the move is checked and recorded, with `{ok, move}`. The
hand-off, exit and relaunch continue after the answer. `GET
/v1/sessions/move?id=<uuid>` returns `{move}`, and `GET /v1/sessions/moves`
the 50 most recent moves on this computer. A harness or account that is not
usable here is refused with 409 `harness_unavailable` or `account_unavailable`;
a pane already moving with 409 `move_in_progress`. The phone and desktop offer
only harnesses `/v1/harnesses` reports as usable, and follow a move by polling
its id. The record's fields and the steps are in docs/conductor.md.

`capabilities.moveConductor: true` advertises conductor moves alongside
`sessionMove` and `moveNewChat` in `/v1/health`. The old pane retains its role
until the new agent lands. Conductor moves always use `mode: "new-chat"` and
record `modeForced: "conductor"`, regardless of the requested mode. The old
chat stays running and open. Conductor moves are owner-only, using the same
request class as conductor start/make/stop. MCP agents, peer Hooks and scoped
keys are refused with 403 "Only the owner can move the conductor." Computer keys
are forced through `dispatch-scoped peer`, which stamps the request origin and
strips client-supplied origin headers; install/update migrates existing keys.
A checked role hand-over also re-points open
worker receipt origins, so returns and approvals reach the new conductor.
The launch prompt withholds conductor authority until the Hook confirms the
hand-over. The destination must be idle or working, fully linked, and its
brief must have a matching UserPromptSubmit acknowledgement within 30 seconds
after linking. The Hook sends a confirmation after commit or a failure prompt
on refusal; the move’s `notice` reports notification failures. Receipt readers
and late saves share the hand-over lock. Only dispatch operations already in
flight at completion inherit aliases; new dispatches keep their own origin,
and conductor changes invalidate aliases pointing elsewhere. An ordinary move
aborts if its source becomes conductor before exit or replacement. Copilot
cannot be a conductor.
A changed role refuses the hand-over without modifying it; other transfer
failures keep the old role and report `state: "failed"` with an `error`.
A status-save failure after role and routing commit reports `state: "moved"`
with a warning in `notice`. See [moving the conductor](conductor.md#move-a-session-to-another-agent).

`mode` defaults to `"replace"`: the old agent exits and the target replaces it
in place (or in an adjacent tab when its account needs a different shell).
With `capabilities.moveNewChat: true`, apps may send `mode: "new-chat"`, for
example when switching from Claude to Codex, OpenCode or Copilot. The Hook asks
for the same hand-off, retaining the transcript fallback, and launches a new
tab/pane in the same project folder through the launch-brief path. The old
agent stays running. The first prompt carries the goal, current state, branch,
open/changed files and next steps, plus a `Previous chat` section with its title
and full JSON target `{server,workspace,tab,pane,source,session}` for app links.
Open files come from the agent's note; the Hook also appends observed Git changes.
A long note is supplied by a hand-off file referenced in the first prompt.

The finished `{move}` has `mode: "new-chat"`, `placement: "adjacent-pane"`,
`target` naming the new chat, `handedOffTo: {target}` and
`handedOffFrom: {target: <old target>, title: <old title>}`. Polling
`GET /v1/sessions/move?id=<uuid>` returns that record when the launch lands.
Overview tab and pane rows for the old conversation show `handedOffTo: {target}`
and a title ending in ` (handed off to <harness>)`; rows for the new conversation
show `handedOffFrom: {target,title}`. These annotations use the move record and
match the conversation, so a later chat in the old pane does not inherit them.
A failed launch leaves the old chat running without a hand-off annotation.
If the harness starts but delivery of its first prompt throws or is refused,
the move is `failed` with an `error` explaining that the new chat started but
did not receive the hand-off. The launched pane is left open, its location is
kept in `paneTarget`, and the old chat gets no hand-off annotation.

A new chat without a conversation id remains in `state: "linking"` while the
Hook probes on its existing poll tick for up to three minutes. Once identified,
`target` becomes the full conversation target and both hand-off links are recorded.
If identity never arrives within that window, the move settles as `moved` with
`linkPending: true` and a `notice` explaining that the conversation link is pending.
`target` retains the starting target when supplied by the launcher; `paneTarget`
always names the launched pane as `{server,workspace,tab,pane,source}`. The new
row's conversation link remains unavailable until identity has been resolved.
This option adds no CLI flag or store format change.

### Worker report and finish contract

With the conductor module enabled, health capabilities `queuedHandOff`,
`workerReports` and `ownerInbox` are true. Older Hooks omit them. The phone must
check the relevant capability before offering the new surface.

- `POST /v1/dispatch/close-self`: `{origin:{server,workspace,tab,pane}}`. An agent closing the pane it runs in (CLI: `phren dispatch close-self`, the form of `herdr pane close` that an agent's auto mode allows). The close is recorded as intentional (no gone return), runs after the reply, and only ever touches the named pane; a pane already gone answers `{ok:true,closed:false}`.
- `POST /v1/dispatch/report`: `{origin:{server,workspace,tab,pane},prs:[{url,repo,branch,tests,notes?}],dispatch?}`.
  The Hook resolves the live conversation, requires its submitted turn record,
  and returns `{ok:true,target,prs}`. Without that record, `dispatch` (the
  worker's `PHREN_DISPATCH_ID`, sent by the tool and CLI) is enough when this
  Hook saw that brief arrive in the same pane and conversation; the report then
  belongs to the current turn. A missing or changed binding is a 409.
  Done worker observations and returns include `prs`. The evidence is limited
  to 16 entries and 24000 UTF-8 bytes total.
- `GET /v1/conductor/integrator`: `{integrator:{computer?,target}|null}`.
  `POST` on the same path accepts `{integrator:{computer?,target}|null}`.
  The target is a complete live session target. Dispatch can set its own
  `integrator` override. Forwarded receipts have
  `integratorDelivery:{deliveryId,state:"pending"|"queued"|"delivered"|"uncertain"|"failed",at,integrator?}`.
- `POST /v1/dispatch/close`: `{target,dispatch,turn}`. `turn` is the done
  return's opaque fingerprint. It returns `{ok:true,closed:boolean}`; true may
  carry `replayed:true`. The route rechecks the ended turn, terminal, current
  status and pending hand-offs. False means the worker has resumed or cannot
  safely close. An unreachable Hook leaves the sender's close request pending.
  It never closes another pane in the same tab.

### Owner inbox phone contract

`GET /v1/owner-inbox` or `POST /v1/owner-inbox` with `{action:"list"}` returns
`{ok:true,items:[Item],unreachable:[{computer,error}]}` across linked computers.
`GET ?local=1` reads only this Hook (used by peer aggregation, no recursion).
`includeResolved=true` in GET, or `includeResolved:true` in POST, includes history.

`Item` is `{id,kind:"manual"|"needs-you"|"blocked",title,state:"open"|"resolved",
createdAt,updatedAt,inboxComputer,project?,computer?,target?,dispatch?,actionId?,
source?,live?,resolvedAt?,resolution?}`. All times are ISO timestamps. `target`
is a full session target or a starting target for a startup dialog. `id` is a
UUID; `source` is opaque. `inboxComputer:"local"` means the connected Hook owns
it; another name means send the action to that Hook. `computer` describes the
worker, which can differ from the inbox owner.

`POST /v1/owner-inbox` accepts `{action:"add",title,project?,id?,computer?}` or
`{action:"resolve",id,resolution?,computer?}` and returns `{ok:true,item}`.
`computer` routes to the named linked Hook; omit it for local. A reused manual
id with different content is a 409; missing resolve ids are 404. Repeating an
identical add or resolve is idempotent. Resolve changes only inbox state.

The follow-up phone screen should show one open list with source, project,
computer, question and a link to `target`; show unreachable computers as
unknown. A Done action sends resolve to `inboxComputer`, with optional notes.
Keep permission and question answers on their existing routes. Automatic items appear only while verified live; answered questions and ended
or closed sources resolve on reads or within the five-second activity tick.
Repeated observations update the same item per pane, session and question.
Manual items remain until explicitly resolved. Show history on demand, retain
ids across retries, and refresh after actions. On upgrade, stale automatic
items resolve with `stale: source gone`; an unreachable worker is hidden as
unverified rather than resolved. No phone UI changes are included here.

## Schedule editing

All schedule routes use authenticated JSON `POST` requests:

| Route | Body and response |
| --- | --- |
| `/v1/schedules` | `{}`; returns `{ computer, timeZone, schedules }`, including each schedule's stored `updatedAt`. |
| `/v1/schedules/update` | `{ project, id, expectedUpdatedAt, changes }`; returns `{ ok: true, schedule }` after a locked merge and atomic write. |
| `/v1/schedules/run` | `{ project, id, expectedUpdatedAt? }`; returns `{ ok, run, runs }`. |
| `/v1/schedules/history` | `{ project?, id?, limit? }`; returns `{ runs }`. |

`capabilities.scheduleUpdate: true` advertises the update route when the schedules
module is enabled. Clients should use their legacy edit path on older Hooks.
`expectedUpdatedAt` is the per-schedule timestamp from `/v1/schedules`, with
an ISO 8601 time zone; the exact stored string must match, including all
fractional digits. New revisions use canonical UTC form
(`YYYY-MM-DDTHH:mm:ss.sssZ`). A mismatch returns HTTP 409
with `{ error, schedule }`, where `schedule` is the current stored definition.
A missing project or schedule returns 404. Invalid body fields, types, or merged
schedule validation return 400 with `{ error }`. These failures write nothing.

`changes` accepts `name`, `prompt`, `enabled`, `computer`, `harness`, `model`,
`account`, `notify`, `projects`, `session`, `every`, `at`, `days`, `interval`,
`once`, and `cron`. Only supplied keys change; unknown stored keys remain.
`null` removes optional fields, but cannot remove a required field, including
one required by the selected timing form. Identity and timestamps are not
editable, and unknown request keys are refused. For example:

```json
{"project":"acme","id":"7f3a2c1d","expectedUpdatedAt":"2026-09-20T21:00:00Z","changes":{"enabled":false,"model":null}}
```

The Hook reads fresh under the CLI schedule writers' lock, validates the merged
schedule, assigns a new `updatedAt`, and writes atomically. See
[scheduled prompts](schedules.md#hook-routes) for timing and serialization details.

## Instant sync from gitboy pushes

This is off by default. Configure the receiver only on the computer running
both gitboy and the Hook. Create `<bridge>/gitboy-webhooks.json` (normally
`~/.local/share/phren/bridge/gitboy-webhooks.json`) with mode **0600**, then
restart the Hook:

```json
{
  "listenPort": 47392,
  "stores": [
    {
      "storeId": "1234abcd",
      "owner": "alice",
      "name": "memory",
      "branch": "main",
      "secretFile": "gitboy-memory.secret"
    }
  ]
}
```

Use the store's portable primary ID from its own `stores.yaml`. A local
attachment ID from `phren store list` is also accepted in this computer's receiver
config and translated to that portable ID for peer nudges. `secretFile` is an absolute
path or a path relative to the private bridge directory; it must be a private
regular file (0600), with the secret as text (surrounding whitespace is removed).
Alternatively, supply `"secret": "your-webhook-secret"` in the config, using
exactly one of `secret` and `secretFile`. Keep both files on this computer,
outside the synced store. Invalid or unsafe config leaves the receiver disabled.
Remove the config and restart to turn it off.

In gitboy's repository webhook settings:

- URL: `http://127.0.0.1:47392/gitboy/push` (use your configured port).
- Add this destination computer to gitboy's `GITBOY_WEBHOOK_ALLOWLIST`.
- Secret: the same signing secret configured above.
- Events: **push**.
- Branches filter: the configured store branch, such as `main`.

The listener always binds to `127.0.0.1`. It accepts bodies up to 1 MiB with a
five-second body deadline and verifies `X-Hub-Signature-256` over the exact bytes
against every configured secret before parsing JSON. Unknown repositories and
invalid signatures both receive the same empty 401 response. Requests must have
Host `127.0.0.1:<port>` or `localhost:<port>`, Content-Type `application/json`
(optionally with a charset), and no Origin or Sec-Fetch-* headers. This endpoint
is for gitboy's server, not browser pages.
Recent `X-Gitboy-Delivery` IDs and SHA-256 digests of authenticated bodies are
deduplicated in memory (reset on Hook restart); changing the unsigned delivery
header cannot replay a remembered body.
A matching delivery receives 202 promptly while sync continues in the background.
Other verified Hooks in this computer's private `hooks.yaml` get nudged over
pinned SSH through `POST /v1/store/pull-now` with
`{ "storeId": "1234abcd", "repository": "alice/memory", "branch": "main" }`.
The ID comes from the store's own `stores.yaml`, not the machine-local attachment
entry. The repository is a lowercase `owner/name`; SSH and HTTP remote URLs
resolve to the same repository path. Each peer checks that portable ID, repository
and upstream branch against its local checkout. The primary checkout always uses
this computer's configured store root, even if synced metadata names another path.
Missing or mismatched stores return 404 without details.
Owner requests are also allowed; scoped gitboy keys and agent requests are refused.
Peer fan-out and local pulls each coalesce to one pending round per store, with
at most one start every ten seconds. Busy Git operations (including index locks
and merge state) get three pull attempts at 0, 10 and 30 seconds; the Hook never
clears another operation's state. Polling remains the fallback after that budget
or if a peer is offline or a delivery fails.
`GET /v1/health/details` reports `gitboyWebhooks`: configured/listening state,
port, and last delivery time/outcome, without secrets or payloads.
