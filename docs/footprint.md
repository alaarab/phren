# What Phren Touches (Footprint)

Phren keeps a git-backed **store** (default `~/.phren`) and projects its contents
into agent-visible locations so your AI tools can read them. This page lists
**every path phren writes**, the external files Hook reads, and how the
**management preset** changes that footprint.

Set the preset at install (`phren init --preset <name>`), switch it anytime
(`phren preset <name>`), and inspect the current footprint with `phren status`.

## Presets at a glance

| Capability | `managed` (default) | `assisted` | `manual` |
|---|:---:|:---:|:---:|
| MCP server registration | ✅ | ✅ | ✅ |
| Lifecycle hooks (inject, capture, sync) | ✅ | ✅ | ❌ |
| `~/.claude/CLAUDE.md` symlink | ✅ | ❌ | ❌ |
| `~/.claude/skills/*` symlinks | ✅ | ❌ | ❌ |
| `~/.local/bin` wrappers | ✅ | ❌ | ❌ |
| SessionStart self-heal of the above | ✅ | ❌ | ❌ |
| Repo mirroring (into phren-managed repos) | ✅ | ❌ | ❌ |
| Lifecycle automations (daily maintenance, auto-commit/push) | ✅ | ✅ | ❌ |
| Default project ownership | walkthrough choice | `detached` | `detached` |

- **managed**: the flagship experience. Phren wires everything and re-heals it
  every session.
- **assisted**: hooks and MCP stay on (you keep ambient context injection,
  auto-capture, and store git sync), but phren **never writes outside its own
  store and your agent's settings**. It prints a self-wiring snippet so you can
  reference `global/AGENTS.md` and skills from your own files. Re-print anytime
  with `phren snippet`.
- **manual**: phren runs as an MCP server only. No hooks, no automations, no
  auto-commit. A pull-based knowledge base your agent calls on demand.

## Paths phren may write

### Store (all presets)
- `~/.phren/`, the store: projects, `global/`, `profiles/`, `.config/`,
  `.runtime/`, `.sessions/`, `.env` (feature flags), `machines.yaml`,
  `phren.root.yaml`, `phren.SKILL.md`.

### Agent settings (all presets: when MCP/hooks enabled)
- `~/.claude/settings.json`, `~/.claude.json`, `mcpServers.phren` and the
  phren hook entries (sibling non-phren entries are preserved).
- VS Code / Cursor / Copilot / Codex MCP + hook config files, only for tools
  that are detected on the machine.

### Home surfaces (managed only)
- `~/.claude/CLAUDE.md`, symlink to `~/.phren/global/AGENTS.md`.
- `~/.claude/skills/*`, symlinks to phren slash-commands, plus
  `~/.claude/skill-manifest.json` and `~/.claude/skill-commands.json`.
- `~/.agents/skills/*`, enabled global folder skill symlinks for Codex, plus
  `~/.agents/skill-manifest.json` and `~/.agents/skill-commands.json`.
- `~/.github/copilot-instructions.md`, `~/.copilot/skills/`, when Copilot is detected.
- `~/.local/bin/{phren,copilot,cursor,codex}`, CLI and session wrappers.
- `~/.phren-context.md`, the machine-alias file.
- `~/.claude/projects/<home-key>/memory/MEMORY.md`, a generated root memory
  pointing at `~/.phren-context.md`, inside Claude Code's own memory directory.
- **Windows:** `%USERPROFILE%\.local\bin` may be added to your user PATH.

These are re-created every SessionStart under `managed` (self-heal). Under
`assisted`/`manual` phren does not create them and does not self-heal them.

### Project repos (managed only: and only for `phren-managed` ownership)
- `<repo>/AGENTS.md`, `<repo>/REFERENCE.md`, `<repo>/FINDINGS.md`,
  `<repo>/CLAUDE.md` (Claude compatibility), and `<repo>/CLAUDE-*.md`, symlinks/managed files.
- `<repo>/.claude/skills/*`, project skill symlinks.
- `<repo>/.git/info/exclude`, phren-managed mirror filenames, under a
  `# phren-managed` marker.

Repo mirroring never overwrites a file you already version-control or authored;
collisions are always preserved. Under `assisted`/`manual`, or for `detached` /
`repo-managed` ownership, phren writes **nothing** into your repos.

## Clean removal

`phren uninstall` removes all phren-owned home wiring, the `~/.local/bin`
wrappers, the per-project repo mirror symlinks, the `# phren-managed`
`.git/info/exclude` lines, and finally the store. It only ever removes symlinks
and entries phren created. User-owned files stay intact.

Switching to a lower-touch preset (`phren preset assisted|manual`) performs the
same teardown for the surfaces the new preset no longer manages.
Generated machine-context and root-memory blocks are removed when leaving
`managed`, and on uninstall. Surrounding user notes, unmarked/incomplete files,
and symlink targets are preserved; a file is deleted only when no user content
remains. Returning to `managed` recreates missing generated files. Relinking preserves root
memory notes before and after the projects block, and adds a new block to an
unmarked file without replacing its contents. Incomplete or reversed project
markers are left untouched.

## Optional iPhone connection: Phren Hook

`phren bridge install` is separate from the memory-store setup. It installs a
standalone helper in `~/.local/share/phren/bridge/versions/<version>`, with a
`current` symlink, `dispatch` entry point, `askpass` helper for `sudo -A` (0700),
and `installed.json` rollback record.
The root is private (0700); its `hook.sock` and agent-only `agent.sock` are 0600.
`computer-id`, process-bound `bindings/`, per-pane turn records in `turns/`
(last prompt and Stop times, the Stop's final message up to 4000 bytes, for
dispatch returns), bounded `activity.jsonl` and
`activity.jsonl.previous`, and `uploads/<conversation>/` remain on that computer.
Uploads are limited to 8 MiB each and 256 MiB total; uploads older than 14 days
are removed on the next upload. Activity stores status and project metadata,
not conversation text. See [Phren Hook](phren-hook.md).

The Hook keeps the shipped conductor instructions at
`<bridge>/conductor/brief.md` (0600). Its agent-only socket returns a bounded
role reminder for the recorded conductor's turn; OpenCode asks through
`POST /conductor-context` on that same private socket, with its PID and root
conversation checked against the live pane. This path starts no turns.

The installer adds `~/Library/LaunchAgents/com.phren.hook.plist` on macOS, or
`~/.config/systemd/user/phren-hook.service` on Linux. Agent callbacks are merged
into `~/.codex/hooks.json`, `~/.claude/settings.json`, and
`~/.copilot/hooks/phren.json`. Claude's callbacks run `<bridge>/current/claude-hook.mjs`,
a small forwarder each version ships beside its `bridge-hook.mjs` so each event
does not load the whole Hook bundle; SessionStart, UserPromptSubmit, Stop and PreCompact
callbacks get a 15 s timeout. Install and update rewrite only Phren's own
entries in those files, including ones an older version wrote, through a
temporary file and rename. `phren bridge rollback` rewrites them again for the
version it returns to. Where an opencode config exists, the installer
also writes `~/.config/opencode/plugins/phren-transcript.js`, which mirrors
opencode sessions into the store's `.runtime/sessions`. Recognized `phren-iphone` and `phren-android` entries in
`~/.ssh/authorized_keys` are migrated to the restricted Phren dispatcher with
PTY support. Other hooks and keys remain intact. Changed settings and key files
receive sibling `.phren-hook-<timestamp>.bak` backups. Codex requires review of
new callbacks in `/hooks`.

### Codex hook trust the Hook carries forward

Codex runs a `hooks.json` callback only while `$CODEX_HOME/config.toml` holds a
matching `trusted_hash` under `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"]`.
The hash covers the command, timeout and matcher, so when install, update,
rollback or a module change rewrites one of Phren's own Codex callbacks (a new
timeout, a new node path, a moved group), the trust the owner gave it would be
lost and every new Codex would open on "Hooks need review". After each of those
runs, whether or not `hooks.json` changed, the Hook updates the `trusted_hash`
line of a Phren callback (or adds its table next to the other `hooks.state`
tables) only when `config.toml` already trusts Phren's callback for that event:
the same command at a timeout Phren has shipped, or the Phren callback that
stood in `hooks.json` before the rewrite. A Phren callback the owner never
trusted still needs review in `/hooks`, and other callbacks are never touched.
The rest of the file is kept as it was, and the write goes through a temporary
file and rename. `PHREN_PRETRUST=off` turns this off too.

### Folder trust for launches the Hook places

Before the Hook starts Claude, Codex or Copilot in a folder it chose itself, it marks
that exact folder trusted so the agent does not stop on its folder-trust screen
(Claude's defaults to "No, exit"). Those folders are a dispatched or scheduled
project's resolved source folder, and a worktree the Hook just created under
`<repo>/.claude/worktrees/<name>`. A folder the phone names, a conductor's store
folder, and any parent such as `$HOME` are never written. When the folder is
reached through a symlink, both its given path and its real path get the entry.

- Claude: `projects["<folder>"].hasTrustDialogAccepted = true` in
  `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` (a legacy
  `<config dir>/.config.json` is used when it exists). Only that key is added;
  the write takes Claude's own `<file>.lock`, starts from a fresh read, keeps the
  file's mode and goes through a temporary file and rename. A missing or
  unparsable file is left alone.
- Codex: a `[projects."<folder>"]` table with `trust_level = "trusted"` in
  `$CODEX_HOME/config.toml` (default `~/.codex`), appended when absent or with
  its one `trust_level` line changed. The rest of the file is kept as it was.
- Copilot: the folder appended to `trustedFolders` in
  `$COPILOT_HOME/settings.json` (default `~/.copilot`), the list Copilot's own
  "Yes, and remember this folder" answer keeps. The file is created when
  missing; other settings are kept, and a file that is not a JSON object is
  left alone.

Each write is logged in the store's `.runtime/debug.log`. `PHREN_PRETRUST=off`
in the Hook service's environment turns this off; the launch then reports the
trust screen as before (see [conductor](conductor.md)). Entries stay after
`phren bridge uninstall`; remove them in Claude's `/config` or by editing
`config.toml` or Copilot's `settings.json`.

`phren bridge uninstall` removes its service and callbacks. It retains helper
data, versions, and backups. Remove Phren device keys to revoke SSH access.

### Hook reads from installed agents

The Claude model picker reads the newest
`~/.claude/cache/model-catalog/*-cc.json`, or the same relative path under
`CLAUDE_CONFIG_DIR`. Claude Code owns and refreshes that file. Hook reads the
menu, default and minimum client versions; it does not write the cache. It also
runs `claude --version` to filter models the installed client cannot use.
The built-in menu is the fallback when no usable catalogue is available.

Codex model discovery starts `codex app-server` only to initialize and call
`model/list`. OpenCode discovery runs `opencode models` and reads the default
model from `~/.config/opencode/opencode.json` or `opencode.jsonc`. Model lists
are cached in Hook memory for ten minutes.

The file browser reads regular files only under a checkout the Hook has
discovered and validated. It refuses symlinks and `.git` paths, returns at most
500 directory entries, and caps file content at 2 MiB. Viewing a file writes
nothing to that checkout.

### Optional code and worker state

- `<store>/.runtime/code/<project>.sqlite` holds the rebuildable code index,
  references, declaration fingerprints and last-observed change times.
- `<store>/.runtime/packages/` holds optional installed packages, including
  `@phren/code` when it is not linked from the workspace.
- `<store>/.runtime/agent-fanouts/<job id>/` holds each worker's manifest,
  events, stderr, exit record and any `blocked.json` refusal record.
- `<store>/.runtime/agent-fanouts-archive/` holds finished jobs after 24 hours,
  capped at 500 folders. These directories are local runtime state.
- OpenCode's mirrored session event logs can have a `.preview.json` sidecar in
  `<store>/.runtime/sessions/`, holding temporary live reply text for Hook.
  An interactive phren agent writes the same sidecar beside its event log in
  `<store>/.sessions/` while a reply streams, and removes it once the reply is
  logged. Sidecars and staging files a killed agent left there are removed
  when the next interactive session starts, once they are 30 minutes old.
- `<bridge>/dispatches/` holds dispatch receipts without prompt text;
  on the computer that runs a dispatched Claude or Codex worker (or a
  scheduled run), `<bridge>/briefs/<id>/` holds its brief (`brief.md`, 0600)
  and what the worker's hooks reported (`arrival.json`), kept seven days and
  at most 256. A brief is written in `<bridge>/briefs-staging/` first and
  renamed into `briefs/`, so that folder is empty between launches;
  `<bridge>/codex-servers/<id>/` (0700) holds one Codex pane's Phren-owned
  app-server: its socket (`app.sock`), its registry record (`server.json`: the
  pane, process id, thread id, folder and last turn state, no prompt text) and
  its stderr (`server.log`). The Hook removes the folder when the server exits
  or stops it when its pane closes;
  `<bridge>/opencode-panes/<server>%2F<pane>.json` (0600, in a 0700 folder)
  records each OpenCode pane the Hook launched with its own server: port,
  server password, process id, folder and launch settings. An entry is removed
  once its process is gone. The pane's shell also keeps
  `OPENCODE_SERVER_PASSWORD` and `PHREN_OPENCODE_PORT` in its environment.
  Under tmux the password is also on the `tmux respawn-pane -e` command line
  for the moment that command runs. This is accepted: the reader would have to
  be the same user, the server listens only on 127.0.0.1, and the password
  lives only as long as that OpenCode process;
  `<bridge>/conductor.yaml` holds standing grants and `<bridge>/hooks.yaml`
  holds the verified peer directory.

A Code note ("Remember this about …") writes a finding linked to that function or type to the selected store before
optional agent delivery. Browsing the index itself does not edit source files.

### On the iPhone

Local notification preferences and the hashed approval-ID ledger stay in app
data. The ledger stores no prompt text. Schedule reminders and displayed alert
text are registered with the phone's notification center. Failed-worker
dismissals and view preferences also stay on that device. These do not add
files to the synced store or require a notification relay.

Conductor hand-offs retain private `<bridge>/hand-offs/<deliveryId>.json`
records (prompt, target, terminal binding and outcome) for restart recovery
and deduplication. Settled records are pruned after 7 days and the directory
is capped at 512 records; queued ones stay until delivered. They are not
synced into the memory store.

Conductor finish supervision also writes `<bridge>/worker-reports/*.json`
(PR evidence bound to turns), `<bridge>/closed-workers/*.json` (intentional
closure tombstones), `<bridge>/integrator.json` (the chosen session target), and
`<bridge>/owner-inbox.json` (open and resolved owner items). These private,
local files do not sync into the memory store.

Dispatched and scheduled workers are tracked in `<bridge>/jobs.json`: one
record per worker (owning pane, session, harness, label, start time and, once
the process table shows it, the worker's process group). The resources report
uses it to name the agent a heavy process belongs to, and `POST
/v1/jobs/cleanup` ends only a registered process group whose pane is gone and
whose lease has passed. The file is private and does not sync either.

### Structured harness and conductor state

The Hook's private `harness/` directory holds runner registries and sockets,
`owner-nonces.json` replay protection, and the optional single-agent
`proxies.json` plus `proxies/<id>.sock` forwarding endpoint. Proxy bearer tokens
stay in private state and never appear in listings. A worker owns its runner;
restarting its observing Hook does not terminate the worker.

Runner launch configuration also lives in `harness/*.claude.json`,
`harness/*.codex.json` or `harness/*.phren.json`. A pane or proxy runner holds
`harness/<registry>.json.owner.lock` for its lifetime, acquired before native
adapter construction. Nonce and proxy registry writes use their own `.lock`
directories. Interrupted locks require explicit owner reconciliation. Optional
owner-authored ACP executable configuration defaults to `<bridge>/acp.json`.
The Hook and conductor module manifests declare these locations and the single
canonical conductor state below; the harness API creates no second lease ledger.

A registered store may hold `.config/conductor-authority.json` (public fixed
identity configuration), `.runtime/conductor-lease.json`,
`.runtime/conductor-claim.json`, and `.runtime/conductor-admissions/<claimId>.json`.
The runtime files are private. A failed launch keeps its admission; no age-based
cleanup releases a conductor. These owner-state writers use exclusive `.lock`
directories whose interrupted writes require explicit owner reconciliation.

Canonical two-sided enrollment stores private, expiring public-identity reviews
at `<bridge>/computer-enrollment/<UUID>.json`. Signed owner writes also update the
private `<bridge>/harness/owner-nonces.json` replay ledger. Merely opening the
native linking screen creates neither; preparation, review and confirmation are
separate explicit actions. Repair updates `<bridge>/hooks.yaml` under its shared
nonwaiting owner lock and never changes keys or pins.
