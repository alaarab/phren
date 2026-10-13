# Phren for VS Code

Phren is a local memory layer for AI coding agents: projects, findings, daily notes, tasks, skills, hooks and reference docs, all on your machine. This extension connects VS Code to that store and its MCP server so you can inspect and maintain memory without leaving the editor.

The extension talks to your existing local Phren install over stdio — it does not provision Phren for you.

## Requirements

- **Phren installed and initialized.** Run `npx @phren/cli init` (no global install needed). This is the same step that registers phren with your coding agents.
- **Node.js on the machine that runs the extension.** The extension spawns the MCP server with a real `node` binary; VS Code's built-in Electron binary will not work.
- **A store**, at `~/.phren` by default or wherever `phren.storePath` points.

If the sidebar or graph is empty, check that these are set up first (see [Troubleshooting](#troubleshooting)).

## Setup

The extension auto-detects the MCP server, the `node` binary and `~/.phren`. Configure any of them explicitly in VS Code settings if detection misses:

| Setting | Description |
|---------|-------------|
| `phren.mcpServerPath` | Absolute path to the Phren MCP server entrypoint (`index.js`). Leave blank to auto-detect (MCP config, npx cache, and PATH). |
| `phren.nodePath` | Path to the Node.js binary. Default: `node`. |
| `phren.storePath` | Path to your Phren store. Leave blank to use `~/.phren`. |

Example `phren.mcpServerPath`:

```
/home/you/.nvm/versions/node/v24.13.0/lib/node_modules/@phren/cli/mcp/dist/index.js
```

Open the Phren icon in the activity bar and the extension loads your projects, skills, hooks and graph. A **Get Started with Phren** walkthrough appears on first run, and **Phren: Install Backend** / **Phren: Initialize Store** can set up phren from inside the editor.

## What You Get

The Phren activity bar container has two views:

### Explorer

The main view, structured around real Phren objects:

- **Projects** — expands into Findings and Notes (both grouped by date), Tasks (Queue / Active / Done), Sessions, Review Queue, and Reference docs.
- **Skills** — grouped by scope, project-local and global shown separately.
- **Hooks** — current hook state for each registered tool.

Tree items carry badges: tasks show priority (`high` / `medium` / `low`), a pin indicator, and the GitHub issue number when linked; findings show their type tag (`[decision]`, `[pitfall]`, …) and a confidence indicator when it is below threshold. Clicks open detail panels directly — findings, tasks, skills, queue items, sessions, and project files. Inline hover actions cover the common edits (complete, delete, pin, update a task; remove a finding; promote a note).

### Activity

A live feed of phren's memory lookups as they happen, tailed from the store's lookup log. Each row shows the project/file that was recalled, the query that found it, and the snippet, so you can watch what the agent actually pulls into context.

### Status bar

A theme-aware Phren item shows health and sync state. Click it to run **Phren: Doctor**.

### Fragment graph

**Phren: Show Fragment Graph** opens the shared 3D memory viewer in a webview: animated nodes for projects, findings, tasks and topics, with filter, zoom and layout-reset controls and keyboard navigation. Arrow keys move between nodes, Enter selects, Escape clears focus.

### Editor integration

- Select text in any editor, right-click, and pick **Phren: Add Finding** or **Phren: Add Note**.
- Notes can be edited, removed, or promoted to findings from the sidebar.

## Commands

### Command Palette

Available via `Ctrl+Shift+P` / `Cmd+Shift+P`:

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `Phren: Search Knowledge` | `Ctrl+Shift+K` / `Cmd+Shift+K` | Full-text search across the store; results open in a side panel. |
| `Phren: Show Fragment Graph` | — | Open the 3D fragment graph in a webview. |
| `Phren: Refresh` | — | Reload all data from the MCP server. |
| `Phren: Add Finding` | — | Save a finding to the active project (also in the editor context menu with a selection). |
| `Phren: Add Note` | — | Add a lightweight note to the active project. |
| `Phren: Add Task` | — | Add a task to the active project. |
| `Phren: Add Project` | — | Track a folder as a Phren project (also in the Explorer context menu). |
| `Phren: Set Active Project` | — | Switch the active project context. |
| `Phren: Pin Memory` | — | Pin a canonical memory entry that never decays. |
| `Phren: Sync` | — | Commit and push store changes to the configured remote. |
| `Phren: Doctor` | — | Run health checks and report issues. |
| `Phren: Doctor Fix` | — | Apply fixes for the issues Doctor found. |
| `Phren: Hooks Status` | — | Show hook enable/disable status for all registered tools. |
| `Phren: Toggle Hooks` | — | Enable or disable all phren hooks globally. |
| `Phren: Set This Machine's Profile` | — | Switch the active profile for this machine. |
| `Phren: Set Machine Alias` | — | Set a friendly name for this machine in `machines.yaml`. |
| `Phren: Open machines.yaml` | — | Open the machines config file. |
| `Phren: Open Machines Config` | — | Open and edit machine configuration. |
| `Phren: Configure Machine` | — | Walk through machine configuration. |
| `Phren: Project Config (Quick Edit)` | — | View and edit project-level configuration. |
| `Phren: Open Settings Dashboard` | — | Open the Phren settings dashboard. |
| `Phren: Show Log` | — | Open the "Phren" output channel, where the extension logs what it does. |
| `Phren: Install Backend` | — | Install and initialize phren via `npx`. |
| `Phren: Initialize Store` | — | Create a new store. |
| `Phren: Advanced Setup` | — | Open the setup wizard. |
| `Phren: Getting Started` | — | Open the getting-started walkthrough. |
| `Phren: Start Session` | — | Start a phren session for the active project. |
| `Phren: End Session` | — | End the current phren session. |
| `Phren: Uninstall Phren and Delete Store` | — | Remove phren config and hooks from this machine and delete the store. |

### Sidebar and Context Menu

These fire from the Phren sidebar, a tree item, or the editor context menu:

| Command | Where it appears | Description |
|---------|-----------------|-------------|
| `Phren: Toggle Skill` | Skill context menu | Enable or disable a skill without deleting it. |
| `Phren: Toggle Hook` | Hook item context menu | Toggle a specific hook from the sidebar. |
| `Phren: Toggle Project Hook` | Project hook item inline action | Toggle a hook for one project. |
| `Phren: Open Session Overview` | Session item inline action | Open a panel of the findings and tasks captured in that session. |
| `Phren: Copy Session ID` | Session item context menu | Copy the session ID to the clipboard. |
| `Phren: Filter Findings by Date` | Findings category inline action | Filter the findings list to a date range. |
| `Phren: Complete Task` | Active task inline action | Mark a task done. |
| `Phren: Delete Task` | Task item inline action | Remove a task permanently. |
| `Phren: Pin / Unpin Task` | Active task inline action | Pin or unpin a task so it stays visible. |
| `Phren: Update Task` | Active task inline action | Edit a task's text or priority. |
| `Phren: Remove Finding` | Finding item inline action | Remove a finding by match. |
| `Phren: Supersede Finding` | Finding item context menu | Mark a finding superseded by a newer one. |
| `Phren: Retract Finding` | Finding item context menu | Retract a finding with a reason. |
| `Phren: Resolve Contradiction` | Finding item context menu | Resolve a contradiction between two findings. |
| `Phren: Open Note` | Note item click | Open a Markdown preview of the note. |
| `Phren: Edit Note` | Note item context menu | Edit the note text. |
| `Phren: Remove Note` | Note item context menu | Remove the note. |
| `Phren: Promote Note to Finding` | Note item inline action | Copy a note into durable findings while keeping its daily source. |
| `Phren: Link GitHub Issue` | Task item inline action | Link or unlink an existing GitHub issue on a task. |
| `Phren: Create GitHub Issue` | Task item inline action | Create a GitHub issue from a task and link it back. |
| `Phren: Toggle Project` | Project item context menu | Archive or restore a project. |

## WSL and Remote

The extension declares `extensionKind: workspace`, so it always runs on the **workspace side**, not on your local UI machine. In a WSL window (or an SSH / Dev Container / Remote window) that means the extension runs inside the remote environment, and the phren CLI and the store must both live there too:

- Install and initialize phren **inside WSL** (or on the remote host), in the same environment VS Code connects to. `phren` from your Windows or macOS shell is not visible to the extension.
- The store must be reachable at that environment's `~/.phren`, or point `phren.storePath` at a path inside the environment.
- `phren.nodePath` must be a `node` binary inside that environment.

This is deliberate: the extension spawns `node` and reads the store directly, so running on the workspace side avoids shipping your store over the wire and keeps file paths valid.

## Troubleshooting

- **Open the log first.** Run **Phren: Show Log** to open the **"Phren"** output channel. It records the resolved MCP server path, store path, spawn failures, tool errors and other detail the extension hits.
- **Health checks.** Run **Phren: Doctor** for a report on the install, store and hooks; **Phren: Doctor Fix** applies the safe fixes. The status bar item also links to Doctor.
- **Empty sidebar or graph.** Usually the extension cannot find phren or the store. Confirm `npx @phren/cli init` has run in the environment where the extension is active, then check `phren.mcpServerPath`, `phren.nodePath`, and `phren.storePath`.
- **Empty fragment graph.** When there is nothing to draw, the graph says so in place of the nodes — for example no projects tracked yet, or no findings captured. Add a project (**Phren: Add Project**) or select the right active project, then refresh.
- **In WSL or Remote**, remember everything above must be installed in the remote environment, not just locally.

## Development

```bash
npm install
npm run compile
npm run package
```
