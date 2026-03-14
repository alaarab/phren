# Phren for VS Code

Phren inside the editor, where it belongs.

This extension connects VS Code to your local Phren store and MCP server so you can inspect projects, search memory, review findings, work through tasks, and edit skills without bouncing to the terminal.

## What It Actually Does

- Adds a dedicated `Phren` view in the activity bar.
- Lists tracked Phren projects with drill-down sections for findings, tasks, and reference docs.
- Opens findings and reference files in read-only detail panels.
- Lets you search Phren knowledge from VS Code and preview full results beside your editor.
- Shows the Phren fragment graph in a webview.
- Adds a status bar picker for the active Phren project.
- Lets you add a finding from the editor context menu.
- Opens skills in an editable webview so you can update and toggle them in place.
- Opens tasks in a detail view where you can edit them or mark them done.
- Lets you toggle Phren hooks from the sidebar.

## Who This Is For

This extension is for people already using Phren locally.

If you keep project memory, findings, tasks, and skills in Phren, this gives you a faster way to inspect and maintain that data while you work in VS Code.

## Requirements

- A working local Phren install.
- Access to the Phren MCP server entrypoint on disk.
- Node.js available on your machine if the server is launched with `node`.

## Setup

Open VS Code settings and configure the extension:

- `phren.mcpServerPath`: absolute path to the Phren MCP server entrypoint. If left blank, the extension tries to auto-detect a global Phren install.
- `phren.nodePath`: Node.js binary used to launch the server. Default: `node`.
- `phren.storePath`: path to your Phren store. If left blank, the extension uses `~/.phren`.

Example `phren.mcpServerPath`:

```text
/home/alaarab/.nvm/versions/node/v24.13.0/lib/node_modules/@alaarab/phren/mcp/dist/index.js
```

Once those values are set, open the `Phren` activity bar item and the extension will load your projects, skills, hooks, and graph entrypoint.

## Core Workflows

### Browse Phren Data

The sidebar is structured around real Phren objects, not synthetic dashboards:

- `Projects`: each project expands into `Findings`, `Task`, and `Reference`.
- `Skills`: grouped by source so you can inspect project-local and global skills.
- `Hooks`: current hook state by tool.
- `Fragment Graph`: one-click entry into the graph view.

### Search Knowledge

Run `Phren: Search Knowledge` or use the keybinding:

```text
Ctrl+Shift+K
```

On macOS:

```text
Cmd+Shift+K
```

Search results open in a side panel with the full stored content when available.

### Add Findings Without Leaving the Editor

Select text in any editor, open the context menu, and run `Phren: Add Finding`.

The finding is added to the currently active Phren project.

### Work With Tasks

Tasks open in a dedicated panel where you can:

- inspect the task status and project
- edit the task text
- mark non-done tasks as complete

### Edit Skills

Skills open in an editor-like webview with inline save and enable/disable controls. This is useful when you want to iterate on prompt instructions without dropping into the Phren store manually.

## Commands

- `Phren: Search Knowledge`
- `Phren: Show Fragment Graph`
- `Phren: Refresh`
- `Phren: Add Finding`
- `Phren: Set Active Project`

Some actions are also exposed contextually from the sidebar, including opening findings, opening project files, opening skills, toggling skills, toggling hooks, and opening tasks.

## Notes

- This extension is designed around a local Phren installation. It does not provision Phren for you.
- If the sidebar appears empty, the first things to check are `phren.mcpServerPath`, `phren.nodePath`, and `phren.storePath`.
- The extension talks to your local Phren MCP server, so behavior depends on that server being installed and reachable.

## Development

```bash
npm install
npm run compile
npm run package
```
