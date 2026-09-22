# Tasks: grouped backlog

Status: built September 21, 2026. The Tasks tab draws one collapsible
section per project; `TasksModel` holds the browsing state the view used to
keep in `@State`, the way `AgentChatModel` began.

Shared control measurements: [controls.md](controls.md).

## Sections

Cross-project lists (the Tasks tab, no project filter chosen) draw one
section per project, ordered by open count: that project's Active plus Queue
tasks, highest first, ties by name. A project appears only when the current
status section and filters leave it rows. Project-scoped lists and a chosen
project filter keep the flat `Backlog` / `Active` / `Done` label.

Rows are unchanged: `sessionCard()` rows with the same swipe, selection,
context-menu and detail behaviour. The existing filters (search, priority,
age, project, store, sort) run before grouping, so a section lists only its
matching rows and disappears when none match.

## Header

Each header is one 44-point button in the plain list:

- The name uses `plainListSectionTypography()` (the type of
  `plainListSectionLabel()` without its list padding) in the project's own
  colour (`PhrenTheme.projectColor(storeId:project:)`, from
  `ProjectNameColor`), so it sits on the same baseline as the chips. The
  colour's store comes from the store list, never from filtered rows, so a
  search cannot re-colour the header.
- Two passive `PhrenChip`s: `<n> active` in success green and `<n> queue` in
  text secondary, each omitted when its count is zero (a Done-only project
  shows neither). Counts come from the project's unfiltered Active and Queue
  rows in the current scope, so they still read right under a search or
  inside a folded section.
- A trailing chevron that rotates with the fold. At accessibility sizes the
  header stacks: name and chevron on the first line, the chips wrapping
  below in `PhrenFlowLayout`.

Identifiers: the button is `tasks-section-toggle:<project>`; a zero-size
`phrenContainerMarker` on it is `tasks-section:<project>` with the counts as
its value. The top control is `tasks-section-all`. Section headers (only)
carry the `isHeader` accessibility trait; `All` is a control with the
Expand/Collapse label. Fold animations run only when Reduce Motion is off
(0.18s ease, nil otherwise).

## Folding

Tapping a header folds or unfolds that project only. The top `All` control
folds every visible section, or unfolds them when all visible ones are
folded; projects filtered off screen keep whatever fold they already had.
Folded project names live in AppStorage (`tasks.collapsed.v1`,
newline-separated), so folds survive leaving the tab and relaunching. UI-test
launches clear the key unless they pass `--tasks-keep-collapsed`.

## TasksModel

`TasksModel` (`@Observable @MainActor`) owns selectedProject, query, search
visibility, selection state, the moving flag and the priority/age filters,
plus `rawRows` / `rows`, per-project open counts built straight from
`doc.items(in:)` (no throwaway rows), and a pure static
`groups(visible:activeCounts:queueCounts:storeIdByProject:)` that orders
sections by open count (unit-tested in `PhrenTests/TasksModelTests.swift`). `section`, `sort` and the fold key stay
`@AppStorage` in the view; sheet and navigation routes stay `@State` there.
`Select all` only gathers rows from expanded sections.

## Fixture and tests

The workflow fixture writes two projects per store: `demo` with 0 Active and
3 Queue tasks, `api` with 3 Active and 1 Queue. Merged across both stores
that is open 8 vs 6, so `api` sits above `demo` under Backlog even though
`demo` shows more rows there (6 vs 2); alphabetical order would agree with
the count order, so the visible-row order is the one being ruled out. Chips
read `6 active` / `2 queue` on api and `0 active` / `6 queue` on demo.
`PhrenUITests/TasksTests.swift` checks that order, the chip counts, folding
one section and all sections, in-section filtering, and that a fold survives
a relaunch (`--tasks-keep-collapsed`); screenshots are `Tasks grouped` and
`Tasks collapsed`. `PhrenTests/TasksModelTests.swift` covers the collapse
encoding and the pure grouping. `WorkflowTests` covers the rest of the tab.
