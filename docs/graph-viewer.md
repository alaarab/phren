# Memory Viewer (3D Graph)

The memory viewer renders your store as a 3D graph, projects as containment fields, findings/tasks/fragments/references as nodes inside them. The same renderer (a shared browser bundle built from `packages/cli/browser/graph/`) powers three hosts:

- the **web UI** Graph tab (`phren web-ui`)
- the **VS Code extension** webview (Phren Fragment Graph panel)
- the **iPhone** Memory map, with its own phren controls and bottom dossier

The same graph is also drawn in the terminal by the interactive shell's Graph view (`phren shell --view graph`, or `g` inside the shell), see [shell.md](shell.md#graph-g). These hosts share one model layer, `packages/cli/src/graph-core/` (node kinds, health, filters, ranking, search), on top of the payload built by `buildGraph()`; only the renderers differ.

Beyond navigating the graph itself, the viewer is a maintenance surface: find memories, review aging ones, and edit, merge, or prune them without leaving the view.

## Labels

Project (group) labels always draw first: they claim slots from the
per-frame budget before any finding or task. Finding and task labels resolve
against screen-space rectangles every frame in `graph-core`'s collision
resolver: a leaf whose box intersects a group label or a higher-ranked leaf
is hidden. Leaves rank by focus/hover priority, then whether they were
visible last frame (so a shown label holds its slot under cap pressure), then
node degree including `refCount`, then recency. Hysteresis keeps a shown
label through a marginal overlap so labels do not flicker as the camera
moves. The draw cap counts groups and leaves together and scales with
viewport area, with a floor of 40 so a full project navigator still fits on
a phone-sized canvas. Zooming in brings more finding/task labels into the
pool and clears collisions, so detail appears as you approach it. Rects are
computed one frame behind the CSS2D draw (labelTick runs in the ambient RAF,
elements are positioned in force-graph's render pass); that lag is accepted
rather than coupling the resolver to the host loop.

## Layout

| Region | What it is |
|--------|------------|
| Top-left | **Project navigator dock**, one clickable orb per project, plus a `⚠ N` review pill when aging findings exist |
| Left | **Detail dossier**, docked reading pane for the selected node (view/edit/delete); drag its right edge to resize |
| Right | **Contents pane**, scrollable index for whatever is in context (project, fragment, or the review list); drag its left edge to resize, or collapse it to a slim tab |
| Top-right | Search, filters, node counter, zoom controls |

## Dossier header

The dossier's header row carries the node's kind and title on the left and
44px icon buttons on the right, beside **Close**: **Previous node** and
**Next node** chevrons (findings and tasks only), then **Edit** (pencil) and
**Delete** (trash in the danger tint) for nodes that can change. Previous and
Next step through the current ranked list, the order the list mode shows for
that project: its findings newest date first, then its tasks, wrapping at
both ends. The `←`/`→` keys do the same walk while a node dossier is open
(otherwise they still cycle projects in the navigator dock). The counter under
the body reads `n of m` for that same list.

## Project navigator

Click an orb to focus that project (camera flies to it, its network highlights, the contents pane fills). Click the active orb again, or press `Esc`, to clear. `←`/`→` cycle focus through projects when no node dossier is open.

## Contents pane

Opens automatically when a project is in context (focused directly, or any of its findings/tasks is selected):

- **Header**: item counts plus a healthy/decaying/stale bar; click a health segment to filter to it.
- **Filter row**: text filter, `All / Findings / Tasks` chips, an `⚠ Aging` chip, and a sort control (`Aging first` / `Recent` / `A–Z`).
- **Rows**: health-tinted dot, label, topic/section chip. Click to fly to the node and open its dossier. Hover actions: **◎ peek** (fly without opening the dossier), **✎ edit** (open the dossier in edit mode), **🗑 delete**.
- **Keyboard**: `↑`/`↓` move a cursor row, `Enter` opens it, `Delete` prunes it.

Selecting a **fragment** (entity) switches the pane to its network: connected projects and reference docs, each row navigable.

### Select mode and bulk actions

The `☑ Select` chip turns rows into checkboxes with a footer bar: **Select all** (respects the active filter), **Delete N**, and, when exactly two same-project findings are picked, **Merge**, which combines them into a single finding.

Bulk delete and merge both offer an **Undo** toast that restores the previous state.

### Review mode

The `⚠ N` pill in the navigator opens a cross-project pane listing every decaying/stale finding, grouped by project. It supports the same filter, select mode, and bulk delete, a single place to prune stale memory across the whole store.

## Persistence

The pane remembers its width, collapsed state, and sort mode across reloads (browser `localStorage`). Filters and the text query reset each session.

## iPhone Memory map

The phone embeds the browser graph in Memory, alongside its list mode, search,
kind and project filters. Mode and filters persist on the phone. Files and
Memory maintenance also open from Memory. The graph prepares its payload away
from the main actor and keeps one web view as selection changes.

On the phone, the dossier sits above the tab bar. Selecting a node centers it
in the uncovered space above the card, leaving 24 points between that space
and the dossier. Card height and viewport changes update the camera position.
Zoom preserves this placement. The layout depends on the nodes shown, so
Focus, a refresh, a filter or a delete moves nodes; the camera follows the
selected or revealed node to its new place until you move the camera. Taps
pick the node at the tap's own position. Closing the dossier restores the view saved
before the first selection; stepping between nodes keeps that saved view.

Camera movement takes 0.18 seconds or happens immediately with Reduce Motion.
Pan, orbit and pinch cancel it, and card resizing does not take control back
after a gesture. Selecting another node resumes centering. See the phone's
[graph design](../apps/ios/design/graph.md) for geometry and accessibility.

## Where edits land

All actions operate on the same files the CLI and MCP tools use, `<store>/<project>/FINDINGS.md` and `tasks.md` (default store: `~/.phren`). Nothing in the viewer introduces new storage, commands, or MCP tools; delete/edit/merge are compositions of the existing finding and task operations.
