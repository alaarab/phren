# Cortex for VS Code

Cortex inside the editor, where it belongs.

This extension connects VS Code to your local Cortex store and MCP server so you can inspect projects, search memory, review findings, work through tasks, and edit skills without bouncing to the terminal.

## What It Actually Does

- Adds a dedicated `Cortex` view in the activity bar.
- Lists tracked Cortex projects with drill-down sections for findings, tasks, and reference docs.
- Opens findings and reference files in read-only detail panels.
- Lets you search Cortex knowledge from VS Code and preview full results beside your editor.
- Shows the Cortex entity graph in a webview.
- Adds a status bar picker for the active Cortex project.
- Lets you add a finding from the editor context menu.
- Opens skills in an editable webview so you can update and toggle them in place.
- Opens tasks in a detail view where you can edit them or mark them done.
- Lets you toggle Cortex hooks from the sidebar.

## Who This Is For

This extension is for people already using Cortex locally.

If you keep project memory, findings, tasks, and skills in Cortex, this gives you a faster way to inspect and maintain that data while you work in VS Code.

## Requirements

- A working local Cortex install.
- Access to the Cortex MCP server entrypoint on disk.
- Node.js available on your machine if the server is launched with `node`.

## Setup

Open VS Code settings and configure the extension:

- `cortex.mcpServerPath`: absolute path to the Cortex MCP server entrypoint. If left blank, the extension tries to auto-detect a global Cortex install.
- `cortex.nodePath`: Node.js binary used to launch the server. Default: `node`.
- `cortex.storePath`: path to your Cortex store. If left blank, the extension uses `~/.cortex`.

Example `cortex.mcpServerPath`:

```text
/home/alaarab/.nvm/versions/node/v24.13.0/lib/node_modules/@alaarab/cortex/mcp/dist/index.js
```

Once those values are set, open the `Cortex` activity bar item and the extension will load your projects, skills, hooks, and graph entrypoint.

## Core Workflows

### Browse Cortex Data

The sidebar is structured around real Cortex objects, not synthetic dashboards:

- `Projects`: each project expands into `Findings`, `Task`, and `Reference`.
- `Skills`: grouped by source so you can inspect project-local and global skills.
- `Hooks`: current hook state by tool.
- `Entity Graph`: one-click entry into the graph view.

### Search Knowledge

Run `Cortex: Search Knowledge` or use the keybinding:

```text
Ctrl+Shift+K
```

On macOS:

```text
Cmd+Shift+K
```

Search results open in a side panel with the full stored content when available.

### Add Findings Without Leaving the Editor

Select text in any editor, open the context menu, and run `Cortex: Add Finding`.

The finding is added to the currently active Cortex project.

### Work With Tasks

Tasks open in a dedicated panel where you can:

- inspect the task status and project
- edit the task text
- mark non-done tasks as complete

### Edit Skills

Skills open in an editor-like webview with inline save and enable/disable controls. This is useful when you want to iterate on prompt instructions without dropping into the Cortex store manually.

## Commands

- `Cortex: Search Knowledge`
- `Cortex: Show Entity Graph`
- `Cortex: Refresh`
- `Cortex: Add Finding`
- `Cortex: Set Active Project`

Some actions are also exposed contextually from the sidebar, including opening findings, opening project files, opening skills, toggling skills, toggling hooks, and opening tasks.

## Notes

- This extension is designed around a local Cortex installation. It does not provision Cortex for you.
- If the sidebar appears empty, the first things to check are `cortex.mcpServerPath`, `cortex.nodePath`, and `cortex.storePath`.
- The extension talks to your local Cortex MCP server, so behavior depends on that server being installed and reachable.

## Development

```bash
npm install
npm run compile
npm run package
```
