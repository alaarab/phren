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

## Optional iPhone connection: Phren Hook

`phren bridge install` is separate from the memory-store setup. It installs a
standalone helper in `~/.local/share/phren/bridge/versions/<version>`, with a
`current` symlink, `dispatch` entry point, and `installed.json` rollback record.
The root is private (0700); its `hook.sock` and agent-only `agent.sock` are 0600.
`computer-id`, process-bound `bindings/`, bounded `activity.jsonl` and
`activity.jsonl.previous`, and `uploads/<conversation>/` remain on that computer.
Uploads are limited to 8 MiB each and 256 MiB total; uploads older than 14 days
are removed on the next upload. Activity stores status and project metadata,
not conversation text. See [Phren Hook](phren-hook.md).

The installer adds `~/Library/LaunchAgents/com.phren.hook.plist` on macOS, or
`~/.config/systemd/user/phren-hook.service` on Linux. Agent callbacks are merged
into `~/.codex/hooks.json`, `~/.claude/settings.json`, and
`~/.copilot/hooks/phren.json`. Where an opencode config exists, the installer
also writes `~/.config/opencode/plugins/phren-transcript.js`, which mirrors
opencode sessions into the store's `.runtime/sessions`. Recognized `phren-iphone` and `phren-android` entries in
`~/.ssh/authorized_keys` are migrated to the restricted Phren dispatcher with
PTY support. Other hooks and keys remain intact. Changed settings and key files
receive sibling `.phren-hook-<timestamp>.bak` backups. Codex requires review of
new callbacks in `/hooks`.

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

- `<store>/.runtime/code/<project>.sqlite` holds the rebuildable symbol index,
  references, declaration fingerprints and last-observed change times.
- `<store>/.runtime/packages/` holds optional installed packages, including
  `@phren/code` when it is not linked from the workspace.
- `<store>/.runtime/agent-fanouts/<job id>/` holds each worker's manifest,
  events, stderr, exit record and any `blocked.json` refusal record.
- `<store>/.runtime/agent-fanouts-archive/` holds finished jobs after 24 hours,
  capped at 500 folders. These directories are local runtime state.
- OpenCode's mirrored session event logs can have a `.preview.json` sidecar in
  `<store>/.runtime/sessions/`, holding temporary live reply text for Hook.
- `<bridge>/dispatches/` holds dispatch receipts without prompt text;
  `<bridge>/conductor.yaml` holds standing grants and `<bridge>/hooks.yaml`
  holds the verified peer directory.

A Code dossier note writes a symbol-cited finding to the selected store before
optional agent delivery. Browsing the index itself does not edit source files.

### On the iPhone

Local notification preferences and the hashed approval-ID ledger stay in app
data. The ledger stores no prompt text. Schedule reminders and displayed alert
text are registered with the phone's notification center. Failed-worker
dismissals and view preferences also stay on that device. These do not add
files to the synced store or require a notification relay.
