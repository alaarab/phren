# Phren for Herdr

Phren's dashboard, one keypress from whatever pane you're in — scoped to that
pane's project.

[Herdr](https://herdr.dev) is a terminal workspace manager for coding agents.
This plugin adds a button that pops phren's shell over the current pane: tasks,
findings, the review queue, skills and hooks for the project that pane is
sitting in, without leaving the terminal or losing your layout.

```
  prefix+m        phren dashboard, over the current pane
  prefix+shift+m  phren tasks, docked beside the current pane
```

## Install

```bash
herdr plugin install alaarab/phren/integrations/herdr
```

Then add the keybindings to `~/.config/herdr/config.toml` and reload
(`herdr server reload-config`, or `prefix` + your `reload_config` key):

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "phren.dashboard"
description = "Phren dashboard"

[[keys.command]]
key = "prefix+shift+m"
type = "plugin_action"
command = "phren.dock"
description = "Dock phren tasks"
```

The plugin needs phren itself — `npx @phren/cli init` if you haven't already.

Working on phren? `herdr plugin link ~/phren/integrations/herdr` registers the
checkout in place, and the plugin will prefer that checkout's build
(`packages/cli/dist/index.js`) over whatever `phren` is on `PATH`.

## What you get

| Action | Id | What it opens |
|---|---|---|
| Phren dashboard | `phren.dashboard` | The full shell in a popup over the current pane |
| Phren tasks | `phren.tasks` | A popup on the project's task list |
| Dock phren | `phren.dock` | The task list split in beside the current pane, kept open |
| Phren web UI | `phren.web` | `phren web-ui` (the 3D graph) in a strip along the bottom; close the pane to stop the server |
| Phren plugin check | `phren.check` | Diagnostics — read with `herdr plugin log list --plugin phren` |

Every entry can also be opened without a keybinding:

```bash
herdr plugin action invoke dashboard --plugin phren
herdr plugin pane open --plugin phren --entrypoint tasks --focus
```

## How the project gets picked

Panes open with the calling pane's working directory, and the launcher runs
`phren shell --here`, which resolves the project through phren's own detection —
the same path its hooks use, so a git worktree resolves to the repository it
came from. If the directory isn't a registered phren project, the shell opens on
the project list with a note rather than an empty screen.

Override the phren binary with `PHREN_BIN`, and the store with `PHREN_PATH`.

## Layout

```
herdr-plugin.toml     manifest: panes, actions
bin/lib.sh            phren resolution + Herdr invocation context
bin/phren-pane.sh     what every pane runs
bin/open-pane.sh      what every keybinding runs
bin/phren-web.sh      the web UI pane
bin/phren-check.sh    diagnostics
```

## Uninstall

```bash
herdr plugin uninstall phren   # or: herdr plugin unlink phren
```

Then drop the `[[keys.command]]` blocks from `config.toml`.
