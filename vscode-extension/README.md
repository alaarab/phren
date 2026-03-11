# Cortex VS Code Extension

VS Code extension for browsing, searching, and managing Cortex knowledge directly from the editor using the local Cortex MCP server.

## Features

- Sidebar tree view of Cortex projects with category nodes for findings, backlog, and reference.
- Search command palette flow (`Cortex: Search Knowledge`) with rich preview webview for result content.
- Entity graph webview (`Cortex: Show Entity Graph`) with project/finding relationships and clickable project summary panel.
- Status bar active-project picker and indicator.
- Editor context-menu action to add a finding to the active Cortex project.

## Prerequisites

- Cortex MCP server installed and available on disk.
- `cortex.mcpServerPath` configured to the MCP server entrypoint file (for example: `/home/alaarab/.nvm/versions/node/v24.13.0/lib/node_modulescortex/mcp/dist/index.js`).

## Configuration

The extension contributes the following settings:

- `cortex.mcpServerPath` (`string`): absolute path to the Cortex MCP server JavaScript entrypoint.
- `cortex.storePath` (`string`, default: `/home/alaarab/.cortex`): path to cortex store directory.

## Commands

- `Cortex: Search Knowledge` (`cortex.search`)
- `Cortex: Add Finding` (`cortex.addFinding`)
- `Cortex: Set Active Project` (`cortex.setActiveProject`)
- `Cortex: Show Entity Graph` (`cortex.showGraph`)
- `Cortex: Refresh` (`cortex.refresh`)

## Development

```bash
npm install
npm run compile
```
