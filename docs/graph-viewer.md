# Memory Viewer (3D Graph)

The memory viewer renders your store as a 3D graph — projects as containment fields, findings/tasks/fragments/references as nodes inside them. The same renderer (a shared browser bundle built from `packages/cli/browser/graph/`) powers two hosts:

- the **web UI** Graph tab (`phren web-ui`)
- the **VS Code extension** webview (Phren Fragment Graph panel)

Beyond navigating the graph itself, the viewer is a maintenance surface: find memories, review aging ones, and edit, merge, or prune them without leaving the view.

## Layout

| Region | What it is |
|--------|------------|
| Top-left | **Project navigator dock** — one clickable orb per project, plus a `⚠ N` review pill when aging findings exist |
| Left | **Detail dossier** — docked reading pane for the selected node (view/edit/delete); drag its right edge to resize |
| Right | **Contents pane** — scrollable index for whatever is in context (project, fragment, or the review list); drag its left edge to resize, or collapse it to a slim tab |
| Top-right | Search, filters, node counter, zoom controls |

## Project navigator

Click an orb to focus that project (camera flies to it, its network highlights, the contents pane fills). Click the active orb again — or press `Esc` — to clear. `←`/`→` cycle focus through projects.

## Contents pane

Opens automatically when a project is in context (focused directly, or any of its findings/tasks is selected):

- **Header** — item counts plus a healthy/decaying/stale bar; click a health segment to filter to it.
- **Filter row** — text filter, `All / Findings / Tasks` chips, an `⚠ Aging` chip, and a sort control (`Aging first` / `Recent` / `A–Z`).
- **Rows** — health-tinted dot, label, topic/section chip. Click to fly to the node and open its dossier. Hover actions: **◎ peek** (fly without opening the dossier), **✎ edit** (open the dossier in edit mode), **🗑 delete**.
- **Keyboard** — `↑`/`↓` move a cursor row, `Enter` opens it, `Delete` prunes it.

Selecting a **fragment** (entity) switches the pane to its network: connected projects and reference docs, each row navigable.

### Select mode and bulk actions

The `☑ Select` chip turns rows into checkboxes with a footer bar: **Select all** (respects the active filter), **Delete N**, and — when exactly two same-project findings are picked — **Merge**, which combines them into a single finding.

Bulk delete and merge both offer an **Undo** toast that restores the previous state.

### Review mode

The `⚠ N` pill in the navigator opens a cross-project pane listing every decaying/stale finding, grouped by project. It supports the same filter, select mode, and bulk delete — a single place to prune stale memory across the whole store.

## Persistence

The pane remembers its width, collapsed state, and sort mode across reloads (browser `localStorage`). Filters and the text query reset each session.

## Where edits land

All actions operate on the same files the CLI and MCP tools use — `<store>/<project>/FINDINGS.md` and `tasks.md` (default store: `~/.phren`). Nothing in the viewer introduces new storage, commands, or MCP tools; delete/edit/merge are compositions of the existing finding and task operations.
