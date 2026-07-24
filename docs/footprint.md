# What Phren Touches (Footprint)

Phren keeps a git-backed **store** (default `~/.phren`) and projects its contents
into agent-visible locations so your AI tools can read them. This page lists
**every path phren writes**, and how the **management preset** changes that footprint.

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

- **managed** — the flagship experience. Phren wires everything and re-heals it
  every session.
- **assisted** — hooks and MCP stay on (you keep ambient context injection,
  auto-capture, and store git sync), but phren **never writes outside its own
  store and your agent's settings**. It prints a self-wiring snippet so you can
  reference `global/CLAUDE.md` and skills from your own files. Re-print anytime
  with `phren snippet`.
- **manual** — phren runs as an MCP server only. No hooks, no automations, no
  auto-commit. A pull-based knowledge base your agent calls on demand.

## Paths phren may write

### Store (all presets)
- `~/.phren/` — the store: projects, `global/`, `profiles/`, `.config/`,
  `.runtime/`, `.sessions/`, `.env` (feature flags), `machines.yaml`,
  `phren.root.yaml`, `phren.SKILL.md`.

### Agent settings (all presets, when MCP/hooks enabled)
- `~/.claude/settings.json`, `~/.claude.json` — `mcpServers.phren` and the
  phren hook entries (sibling non-phren entries are preserved).
- VS Code / Cursor / Copilot / Codex MCP + hook config files — only for tools
  that are detected on the machine.

### Home surfaces (managed only)
- `~/.claude/CLAUDE.md` — symlink to `~/.phren/global/CLAUDE.md`.
- `~/.claude/skills/*` — symlinks to phren slash-commands, plus
  `~/.claude/skill-manifest.json` and `~/.claude/skill-commands.json`.
- `~/.github/copilot-instructions.md`, `~/.copilot/skills/` — when Copilot is detected.
- `~/.local/bin/{phren,copilot,cursor,codex}` — CLI and session wrappers.
- `~/.phren-context.md`, the machine-alias file.
- **Windows:** `%USERPROFILE%\.local\bin` may be added to your user PATH.

These are re-created every SessionStart under `managed` (self-heal). Under
`assisted`/`manual` phren does not create them and does not self-heal them.

### Project repos (managed only, and only for `phren-managed` ownership)
- `<repo>/CLAUDE.md`, `<repo>/REFERENCE.md`, `<repo>/FINDINGS.md`,
  `<repo>/CLAUDE-*.md`, `<repo>/AGENTS.md` (Codex) — symlinks/managed files.
- `<repo>/.claude/skills/*` — project skill symlinks.
- `<repo>/.git/info/exclude` — phren-managed mirror filenames, under a
  `# phren-managed` marker.

Repo mirroring never overwrites a file you already version-control or authored;
collisions are always preserved. Under `assisted`/`manual`, or for `detached` /
`repo-managed` ownership, phren writes **nothing** into your repos.

## Clean removal

`phren uninstall` removes all phren-owned home wiring, the `~/.local/bin`
wrappers, the per-project repo mirror symlinks, the `# phren-managed`
`.git/info/exclude` lines, and finally the store. It only ever removes symlinks
and entries phren created — user-owned files are left untouched.

Switching to a lower-touch preset (`phren preset assisted|manual`) performs the
same teardown for the surfaces the new preset no longer manages.
