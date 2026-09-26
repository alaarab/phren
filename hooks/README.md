# Claude Code plugin hooks

`hooks.json` is the Claude Code plugin's hook config. It runs `phren-hook.sh`
for the same four events `phren init` wires into `~/.claude/settings.json`:

| Event | Command | What it does |
|---|---|---|
| SessionStart | `phren hook-session-start` | Pulls the store, loads the project's context |
| UserPromptSubmit | `phren hook-prompt` | Injects the findings that match the prompt |
| PostToolUse | `phren hook-tool` | Notes tool activity for auto-capture |
| Stop | `phren hook-stop` | Saves and syncs what the session learned |

`phren-hook.sh` (POSIX sh) adds three rules:

- **One owner.** If the settings file Claude Code reads
  (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`) already
  runs phren for the event, the plugin's copy exits without doing anything.
- **Never slow.** It uses `$PHREN_BIN`, a `phren` on `PATH`, the
  `~/.local/bin/phren` wrapper, or the pinned release already in npm's cache
  (`npx --offline`), in that order. It never downloads on a prompt.
- **Fail open.** No store, no phren, or a phren error: exit 0, no output.

`PHREN_PLUGIN_HOOKS=off` turns the plugin's hooks off. `PHREN_PIN` must equal
`packages/cli/package.json`'s version (`pnpm run validate-docs` checks).

Without the plugin, `phren init` writes these hooks itself; you do not need to
copy anything from this directory. See `docs/claude-code-plugin.md`.

## Per-project hook overrides

Tracked projects can override lifecycle hooks in `<phrenPath>/<project>/phren.project.yaml`:

```yaml
hooks:
  enabled: false
  UserPromptSubmit: true
```

`hooks.enabled` sets the default for that project. Event-specific keys
(`UserPromptSubmit`, `Stop`, `SessionStart`, `PostToolUse`) override it.
