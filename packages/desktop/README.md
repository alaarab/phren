# Phren desktop (spike)

A client of every computer's Phren Hook: sessions across computers, chat,
terminals, Changes, a built-in editor with the code index, and find in files.
Design: `docs/desktop/DESIGN.md` (PR #367). Private package, not published.

```sh
pnpm --filter @phren/desktop build
pnpm --filter @phren/desktop app        # Electron
node packages/desktop/dist/src/main.js  # or the daemon alone, then open the printed URL
```

Computers: `phren-desktop enroll`, `link <host> [--name N]`, `revoke <name>`, `list`.

## Keyboard shortcuts

Herdr's keys, in the desktop. The prefix is Herdr's (`ctrl+b` by default); press
it, then a key. `prefix+?` shows every shortcut. Inside a terminal panel, keys go
to Herdr or tmux itself.

They are configured like Herdr, in three layers, later winning:

1. Built-in defaults (Herdr's own for the shared actions).
2. Your Herdr config, `~/.config/herdr/config.toml`, `[keys]`.
3. `~/.config/phren/desktop.toml`, `[keys]`, same names and syntax.

```toml
[keys]
prefix = "ctrl+a"
goto = ["prefix+g", "ctrl+alt+g"]   # a list binds several keys
close_pane = ""                      # "" unbinds
```

Actions: `help`, `reload_config`, `goto`, `workspace_picker`, `next_tab`,
`previous_tab`, `switch_tab` (`prefix+1..9`), `next_agent`, `rename_tab`,
`toggle_sidebar`, `focus_pane_left`, `focus_pane_right`, `cycle_pane_next`,
`zoom`, `close_pane`, `new_tab` (the session's terminal), and the desktop's own
`show_changes`, `show_files`, `show_search`. Herdr-only actions in your Herdr
config (splits, resize) are ignored. `prefix+shift+r` reloads after an edit.

## VS Code extensions

The editor is VS Code's own (monaco-vscode-api), built from
`packages/desktop-editor` into `ui/editor-host/`:

```sh
pnpm --filter @phren/desktop-editor build
```

Without that bundle the editor falls back to standalone Monaco and extensions
are off.

Install extensions from the panel's Extensions tab, which searches Open VSX.
Installs land in `~/.config/phren/desktop-extensions/` (or
`$PHREN_DESKTOP_EXTENSIONS`), checked against Open VSX's sha256.

- **Declarative parts always load:** themes, icon themes, grammars, language configurations, snippets.
- **Web extensions' code runs:** any manifest with `browser`, in VS Code's worker extension host.
- **Node extensions run in a Node extension host** on this computer: VS Code's own
  remote extension host (MIT), built from the exact commit the editor uses:

  ```sh
  packages/desktop-editor/scripts/build-reh.sh          # this computer's platform
  ```

  The daemon unpacks it into `~/.config/phren/desktop-reh/` and starts it on
  127.0.0.1 with a secret connection token, which the page gets only through the
  cookie-protected `/api/reh`. Node-only extensions install into it. Files of this
  computer's sessions open as `vscode-remote://` with their real path, so language
  servers read them from disk. Sessions on other computers keep web extensions
  until their Hook can start a server of its own.

Extension code runs in a frame on its own `{{uuid}}.localhost` origin. It never
gets the desktop's cookie and cannot call the daemon or any Hook. That is why the
UI is served as `http://localhost:<port>`: the frame's policy allows workers
from localhost, and the daemon itself stays bound to 127.0.0.1.
