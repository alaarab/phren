# Tasks: grouped backlog

Status: built September 21, 2026. The Tasks tab draws one collapsible
section per project; `TasksModel` holds the browsing state the view used to
keep in `@State`, the way `AgentChatModel` began.

Shared control measurements: [controls.md](controls.md).

## Sections

Cross-project lists (the Tasks tab, no project filter chosen) draw one
section per project, ordered by the selected status's task count, highest first,
ties by name. Open counts Active plus Queue. A project appears only when the current
status section and filters leave it rows. Project-scoped lists and a chosen
project filter keep the flat `Backlog` / `Active` / `Done` label.

Rows use `sessionCard()` with swipe, selection, a Phren action sheet and
task details. The existing filters (search, priority,
age, project, store, sort) run before grouping, so a section lists only its
matching rows and disappears when none match.

## Header

Each header is one 44-point button in the plain list:

- The name uses `plainListSectionTypography()` (the type of
  `plainListSectionLabel()` without its list padding) in the project's own
  color (`PhrenTheme.projectColor(storeId:project:)`, from
  `ProjectNameColor`), so it sits on the same baseline as the chips. The
  color's store comes from the store list, never from filtered rows, so a
  search cannot re-color the header.
- Passive `PhrenChip`s show the selected status's counts: active and queue
  under Open, the one status under Active, Backlog or Done, and all three
  under All. Zero counts are omitted. Counts follow the selected status and current scope; folding does not change
  them.
- A trailing chevron that rotates with the fold. At accessibility sizes the
  header stacks: name and chevron on the first line, the chips wrapping
  below in `PhrenFlowLayout`.

Identifiers: the fold button is `tasks-section-toggle:<project>`; the
`tasks-section:<project>` count marker is a separate accessibility element.
The top control is `tasks-section-all`. Section headings carry `isHeader`
and fold controls retain their button trait. `All` is a control with the
Expand/Collapse label. Fold animations run only when Reduce Motion is off
(0.18s ease, nil otherwise).

## Status filter

The filter line leads with a `PhrenSingleSelect` pill, `tasks-status`, whose
sheet lists Open (Active plus Queue, the default), Active, Backlog, Done and
All as `tasks-status:<value>` rows; the choice is remembered in AppStorage
(`tasks.status`) and both `Select all` and the bulk moves take only the
filtered, writable rows from unfolded sections. The status decides everything
downstream: which sections' rows draw, which count chips each header shows
(active and queue under Open, the one section under Active, Backlog or Done,
all three under All), the section order (that status's per-project total,
highest first, ties by name), and the flat label on project-scoped lists.
Done rows draw muted with an outline `checkmark.circle` glyph and a Done-date
caption read from the task's last activity, falling back to its created date.

## Folding

Tapping a header folds or unfolds that project only. The top `All` control
folds every visible section, or unfolds them when all visible ones are
folded; projects filtered off screen keep whatever fold they already had.
Folded project names live in AppStorage (`tasks.collapsed.v1`,
newline-separated), so folds survive leaving the tab and relaunching. UI-test
launches clear the key unless they pass `--tasks-keep-collapsed`.

## TasksModel

`TasksModel` owns browsing state and prepares filtered rows, project groups
and counts when their inputs change. Status, sort and folds remain persisted
preferences; sheet and navigation routes stay in the view. Unchanged task rows
do not redraw for unrelated updates. Select all gathers only writable rows
from expanded sections in the current filter.

## Task actions

- **Start** opens `LaunchSessionView` for that exact store and project, with
  `TaskAgentRequest` supplying the full task text and context as the agent's
  first prompt. It is available from the leading swipe, the row's Phren
  action sheet and a single selected unfinished task. Task details offers
  the same flow as **Start an agent on this task**. The launch sheet lets the
  person choose a computer and harness before starting. A backlog task moves
  to Active only after the session starts and accepts its prompt. Cancel,
  a failed launch or failed prompt delivery leaves its section unchanged.
- **Move to Active** changes the task's section without launching an agent.
  It lives beside **Backlog** and **Done** in the row's Phren action sheet
  and the selection controls. **Backlog** returns work to the queue; **Done**
  completes it. The row's completion circle also marks work Done, or reopens
  completed work in Active. A completed row offers moves, with no Start.
- Selecting more than one task removes Start. Bulk moves still use only the
  selected writable rows and keep failed rows selected for retry. Rows already
  in the destination section are left as they are.

## Following a move

A successful move out of the current status filter leaves that filter in
place and draws a brief inline line below the controls: **Moved to Active**,
**Moved to Backlog** or **Moved to Done**. Several moved tasks read, for example,
**2 tasks moved to Active**. The adjoining **View Active**, **View Backlog** or
**View Done** button switches the filter and unfolds the moved tasks' projects.
The notice also works when the move empties the list, after editing a task's
section, and when returning from a task's launched chat. A move whose destination
is already visible under Open or All needs no notice.

This is inline Phren text and a plain styled button, with no native alert or
toast. It uses the surface, textSecondary and accent colors, a 44-point minimum
button target, and a vertical layout at accessibility text sizes. The line
expires after ten visible seconds; its timer waits while task details, the
editor or the launch sheet is open. Following it or choosing a filter that
includes the destination clears it. Failed moves do not claim success.

Identifiers: `task-actions-sheet:start`, `task-actions-sheet:move-active`,
`task-swipe-start:<row-id>`, `task-bulk-Start` (one task only),
`task-bulk-Move to Active`, `task-move-notice` and `task-move-follow`.
The launch sheet's Cancel button is `launch-cancel`.

## Fixture and tests

The workflow fixture writes two projects per store: `demo` with 0 Active and
3 Queue tasks, `api` with 3 Active and 1 Queue. Merged across both stores
that is open 8 vs 6, so `api` sits above `demo` under Open. Backlog puts `demo`
first with 6 queued tasks before api's 2. Open chips show api's 6 active and
2 queued tasks, and demo's 6 queued tasks; the zero active count is omitted.
`PhrenUITests/TasksTests.swift` checks that order, the chip counts, folding
one section and all sections, in-section filtering, and that a fold survives
a relaunch (`--tasks-keep-collapsed`); screenshots are `Tasks grouped` and
`Tasks collapsed`. `PhrenTests/TasksModelTests.swift` covers the collapse
encoding and the pure grouping. `WorkflowTests` covers the rest of the tab.
Task action tests cover row and swipe Start with cancellation, delivery before
activation, Move to Active and Done with their follow controls, and selection
switching from one task to several. Workflow bulk moves explicitly choose
Move to Active and follow the destination notices.
