# Phren for VS Code

Phren inside the editor, where it belongs.

This extension connects VS Code to your local Phren store and MCP server so you can inspect projects, search memory, review findings, work through tasks, and edit skills without leaving the editor.

## What It Does

- Adds a dedicated **Phren** view in the activity bar.
- Lists tracked Phren projects with drill-down sections for findings, tasks, sessions, review queue, and reference docs.
- Shows **priority, pinned, and GitHub issue badges** on task tree items. At a glance you can see task priority (`high`/`medium`/`low`), whether a task is pinned, and which tasks are linked to a GitHub issue.
- Shows **type and confidence badges** on finding tree items. Each finding displays its type tag (`[decision]`, `[pitfall]`, etc.) and a confidence indicator when confidence is below threshold.
- Theme-aware **status bar** that uses VS Code color tokens for seamless integration with any installed theme.
- Fragment graph webview with **animated characters and keyboard navigation**: arrow keys move between nodes, Enter selects a node, Escape clears focus.
- Updated **review queue viewer** with a contextual notice explaining what each queue section contains.
- Opens findings, skills, reference files, queue items, and sessions in read-only or editable panels directly in VS Code.
- Lets you add a finding from the editor context menu by selecting text and running **Phren: Add Finding**.
- **Finding lifecycle commands**: supersede, retract, and resolve contradictions between findings directly from the sidebar.
- **GitHub issue integration**: link tasks to existing issues or create new issues from tasks, all from the sidebar.
- Syncs your Phren store (`git push`) without leaving VS Code.

## Who This Is For

This extension is for people already using Phren locally. If you keep project memory, findings, tasks, and skills in Phren, this gives you a faster way to inspect and maintain that data while you work in VS Code.

## Requirements

- A working local Phren install (`npm install -g @phren/cli && phren init`).
- Node.js available on your machine.

## Setup

Open VS Code settings and configure:

| Setting | Description |
|---------|-------------|
| `phren.mcpServerPath` | Absolute path to the Phren MCP server entrypoint (`index.js`). Leave blank to auto-detect from a global install. |
| `phren.nodePath` | Path to the Node.js binary. Default: `node`. |
| `phren.storePath` | Path to your Phren store. Leave blank to use `~/.phren`. |

Example `phren.mcpServerPath`:

```
/home/you/.nvm/versions/node/v24.13.0/lib/node_modules/@phren/cli/mcp/dist/index.js
```

Once set, open the Phren activity bar item and the extension loads your projects, skills, hooks, and graph.

## Commands

### Command Palette (17)

These commands are available via `Ctrl+Shift+P` / `Cmd+Shift+P`:

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `Phren: Search Knowledge` | `Ctrl+Shift+K` / `Cmd+Shift+K` | Full-text search across your Phren store. Results open in a side panel. |
| `Phren: Show Fragment Graph` | — | Open the fragment graph in a webview with animated nodes and keyboard navigation. |
| `Phren: Refresh` | — | Reload all data from the Phren MCP server. |
| `Phren: Add Finding` | — | Save a finding to the active project (also available in the editor context menu when text is selected). |
| `Phren: Set Active Project` | — | Switch the active project context. |
| `Phren: Sync` | — | Commit and push all Phren changes to remote. |
| `Phren: Doctor` | — | Run health checks and report any issues. |
| `Phren: Add Task` | — | Add a new task to the active project. |
| `Phren: Pin Memory` | — | Pin a canonical memory entry that never decays. |
| `Phren: Hooks Status` | — | Show hook enable/disable status for all registered tools. |
| `Phren: Toggle Hooks` | — | Enable or disable all phren hooks globally. |
| `Phren: Add Project` | — | Track a folder as a Phren project. Also available in the Explorer context menu. |
| `Phren: Uninstall Phren` | — | Remove Phren config and hooks from this machine. |
| `Phren: Set This Machine's Profile` | — | Switch the active profile for this machine. |
| `Phren: Set Machine Alias` | — | Set a friendly name for this machine in `machines.yaml`. |
| `Phren: Open machines.yaml` | — | Open the machines config file directly. |
| `Phren: Project Config` | — | View and edit project-level configuration. |

### Sidebar and Context Menu (16)

These commands fire from the Phren sidebar or editor context menu. They are not shown in the command palette by default:

| Command | Where it appears | Description |
|---------|-----------------|-------------|
| `Phren: Toggle Skill` | Skill context menu | Enable or disable a skill without deleting it. |
| `Phren: Toggle Hook` | Hook item context menu | Toggle a specific hook from the sidebar. |
| `Phren: Open Session Overview` | Session item inline action | Open a session overview panel showing findings and tasks from that session. |
| `Phren: Copy Session ID` | Session item context menu | Copy the session ID to clipboard. |
| `Phren: Filter Findings by Date` | Findings category inline action | Filter the findings list to a specific date range. |
| `Phren: Complete Task` | Active task inline action | Mark a task as done. |
| `Phren: Delete Task` | Task item inline action | Remove a task permanently. |
| `Phren: Pin Task` | Active task inline action | Pin a task so it stays visible across sessions. |
| `Phren: Update Task` | Active task inline action | Edit a task's text or priority. |
| `Phren: Remove Finding` | Finding item inline action | Remove a finding by match. |
| `Phren: Supersede Finding` | Finding item context menu | Mark a finding as superseded by a newer one. |
| `Phren: Retract Finding` | Finding item context menu | Retract a finding with a reason. |
| `Phren: Resolve Contradiction` | Finding item context menu | Resolve a contradiction between two conflicting findings. |
| `Phren: Link GitHub Issue` | Task item inline action | Link or unlink an existing GitHub issue on a task. |
| `Phren: Create GitHub Issue` | Task item inline action | Create a GitHub issue from a task item and link it back. |
| `Phren: Toggle Project` | Project item context menu | Archive or restore a project. |

Tree item clicks (findings, tasks, skills, queue items, project files) open detail panels directly — no separate command needed.

## Core Workflows

### Browse Phren Data

The sidebar is structured around real Phren objects:

- **Projects**: expands into Findings (with date groups), Tasks (Queue/Active/Done), Sessions, Review Queue, and Reference.
- **Skills**: grouped by scope, project-local and global skills shown separately.
- **Hooks**: current hook state for each registered tool.
- **Fragment Graph**: one-click entry into the graph view.

### Add Findings Without Leaving the Editor

Select text in any editor → right-click → **Phren: Add Finding**. The finding is added to the active project and synced on the next Stop hook.

### Work With Tasks

Tasks in the sidebar show priority badges, a pin indicator for pinned tasks, and issue numbers for tasks linked to GitHub issues. Inline actions (complete, delete, pin, update) appear on hover. Click any task to open its detail panel.

### Edit Skills

Skills open in an editor-like webview with inline save and enable/disable controls, useful for iterating on prompt instructions without dropping into the Phren store manually.

## Notes

- This extension does not provision Phren for you. It connects to an existing local install.
- If the sidebar appears empty, check `phren.mcpServerPath`, `phren.nodePath`, and `phren.storePath` first.
- The extension talks to your local Phren MCP server over stdio; behavior depends on that server being installed and reachable.

## Development

```bash
npm install
npm run compile
npm run package
```
