# phren for Omarchy

Your knowledge store as an app. One icon in the Omarchy bar, one panel behind
it, and phren in the app launcher.

- **Bar icon** — lights up while phren is recalling something. Click for the
  panel, right-click straight into the shell, middle-click into the graph.
- **Panel** — every project with its finding and open-task counts and, when
  `phren maintain summarize` has run, a one-line summary of what phren knows
  about it; the last
  recalls as they land (what was looked up, from which project, by what), and
  three buttons: **Shell**, **Graph**, **Web viewer**. `s` `g` `w` do the same
  from the keyboard, `r` refreshes, `esc` closes.
- **App launcher** (SUPER + SPACE) — `phren` opens the shell in a floating
  terminal; `phren graph` opens the 3D web viewer as its own window, starting
  phren's server the first time.

## Install

From a checkout of the phren repo, on an Omarchy machine with phren installed
(`npx @phren/cli init`):

```bash
bash integrations/omarchy/install.sh
```

That copies the plugin to `~/.config/omarchy/plugins/phren`, validates it with
`omarchy plugin validate`, registers the two launcher entries, and enables the
widget in the bar's right section when the shell is reachable. If it is not
(for example from a nested terminal), finish with:

```bash
omarchy plugin enable phren
```

Move it with `omarchy plugin enable phren --section left`, hide it with
`omarchy plugin disable phren`, remove everything with
`bash integrations/omarchy/uninstall.sh`.

## How it works

The widget is a display over the store's own files. `bin/phren-omarchy-status`
reads `~/.phren` (or `$PHREN_PATH`) directly: one `FINDINGS.md` and `tasks.md`
per project for the counts, and the tail of `.runtime/lookup-events.jsonl`,
the same log the terminal graph's watch mode follows, for the recalls. It
costs a few milliseconds and runs every 30 seconds (configurable in the
widget's settings) and whenever the panel opens. `bin/phren-omarchy-launch`
opens the shell and graph through `omarchy-launch-or-focus-tui`, so a second
click focuses the window you already have, and starts `phren web-ui` on the
configured port before opening it with `omarchy-launch-webapp`.

The plugin follows Omarchy's `manifest.json` contract (`schemaVersion: 1`,
kind `bar-widget`, entry point `Panel.qml`) and its Panel is built from the
same `qs.Ui` parts as the first-party widgets, so it takes the bar's theme,
font and keyboard conventions for free.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Omarchy plugin manifest: id `phren`, kind `bar-widget`, settings schema |
| `Panel.qml` | The bar icon and the panel |
| `bin/phren-omarchy-status` | Emits the store as JSON for the panel |
| `bin/phren-omarchy-launch` | Opens the shell, the graph, or the web viewer |
| `assets/phren.png` | 256×256 icon for the launcher entries and the panel |
| `install.sh`, `uninstall.sh` | Copy in, register launchers, enable; and the reverse |
