# Memory: one page for the graph, findings and tasks

Status: v1 shipped in 1.0.1 build 127; superseded by v2 below (owner,
September 21). Sections 1 to 6 describe v1 and stay for the parts v2 keeps
(rows, results, dossier bridge, fixture). Section 7 is what to build now.

Original status: proposal, September 20. Owner's prompt: the Search tab is a wasted
bottom slot (an empty screen with a bar), the graph is the only place that
browses findings fully, and the graph, the tasks and the findings could become
one page.

## 0. What changes

- The Search tab becomes **Memory**. Its icon is the graph mark
  (`point.3.connected.trianglepath.dotted`), not a magnifying glass.
- Memory is the graph page, full screen, with search and browsing folded into
  it. Nothing on it is a native control: phren's own field, chips, rows and
  the existing node panel.
- Tasks keep their tab. The Tasks tab is a work queue people manage (move to
  Done, add to Backlog, hand to an agent) and its grouped backlog just landed.
  Memory shows tasks as nodes and rows and opens the same task details, so a
  task is reachable from both places, but the queue stays where it is.
- `SearchView.swift` goes away. `SearchIndex` stays: it is the on-phone index
  Memory searches when the query is not about the loaded graph.

Alternative (not recommended now): fold Tasks in too and run four tabs. It
saves a slot but buries the queue two taps deep, and the queue is the thing
the owner opens from the phone most. Revisit once Memory has been used.

## 1. Layout (`MemoryView`, replaces `SearchView` in `PhrenApp` tab `.search`)

Top to bottom, over the app background:

1. **Search field**, phren's own (`PhrenSearchField`: 44pt, rounded, magnifier
   glyph, clear button). Placeholder "Search memory". It is always visible;
   the empty-state text and the "live · updated 0s ago" line are gone. The
   live status moves into the panel header as a small dot when stale, like the
   session cards.
2. **Scope chips** in one horizontal row, 32pt, phren chips: `All`, then one
   chip per project of the selected store (store chip first when the phone has
   several stores). A chip both filters the graph and scopes search. The
   selected project chip uses `PhrenTheme.sessionProject`. Long lists scroll
   horizontally; the selected chip is scrolled into view.
3. **Graph** fills the rest. The existing renderer, gestures and camera stay.
   The content filter (All / Findings / Tasks / Topics) stops being a `Picker`
   and becomes a second chip row that lives inside the panel (see 3).
4. **Panel**, the existing bottom node panel (`GraphNodePanel`, keeps the graph
   visible). It has three uses, one at a time:
   - nothing selected: **contents of the scope**: counts on one line
     ("42 findings · 9 tasks · 6 topics"), the content-filter chips, and a
     list of rows for the scope, findings first, newest first. This is the
     "browse findings fully" the owner asked for.
   - a query typed: **results** in the same rows, ranked, with each row's kind
     chip colored by kind when the content filter is `All`, grouped by project
     only when the scope is `All`.
     Completed results dismiss the keyboard and open the panel to full height;
     Return does the same immediately.
     Tapping a result selects its node (graph pans to it) and opens the
     dossier. Results outside the loaded graph (SearchIndex hits) open their
     project's contents the way SearchView did.
   - a node selected: the **dossier** as it is today (Edit, Delete, Previous
     and Next, Focus), plus a "Show in list" row that returns to the contents
     list, opened full and scrolled to that row. The collapsed native row has no drag handle
     while the dossier is open.

The panel has three heights: collapsed (one header line, 56pt), half, full.
Drag or tap the header to change; the graph stays interactive above it.

## 2. Rows

One row shape for findings, notes, tasks and topics: text (2 lines, body),
then a 28pt meta line of chips. The kind or task-section chip appears only
under the `All` content filter. The type tag remains when present, the project
appears only when the scope is `All`, and the date is right-aligned in
`caption2`. The whole flat rectangle selects the node. Its trailing action is
a plain 44pt ellipsis glyph with no separate circle background. Rows have a
44pt minimum, no dividers, and use `sessionCard()` at list density with a 4pt
gap.

Swipe on a task row: Done / Backlog, same as the Tasks tab. Swipe on a finding:
Edit / Delete, same as the dossier. Nothing new to learn.

## 3. Controls (all phren's own, from the control kit when it lands)

- `PhrenSearchField` (new, shared): the chat composer's field styling, one
  line, keyboard type `.webSearch`, clear button, `memory-search` id on a
  zero-size marker.
- Scope chips and content-filter chips: `PhrenChipRow` (single-select).
- Panel header: title, count, drag handle; `memory-panel` id; `memory-panel-
  height` value "collapsed | half | full".
- Rows: `memory-row:<kind>:<id>`. The collapsed dossier bridge exposes
  `memory-selected-row`, and the plain row action uses the row id plus
  `:actions`. Dossier ids stay as they are so the graph tests keep passing.

## 4. States

- Loading a store: the graph's spinner, panel collapsed with "Loading…".
- Empty scope (a project with nothing yet): panel half, one line "Nothing
  saved for <project> yet", no illustration.
- No results: "No matches" line in the panel, chips stay so the scope can be
  widened.
- Stale (the store hasn't synced): small amber dot in the panel header with
  "updated 12m ago"; tapping it pulls.
- Accessibility sizes: the panel goes full on select; chips wrap to two rows;
  the graph keeps its 44pt back button.

## 5. Fixture and tests

Launch flag `--memory-fixture`: two stores, three projects, 40 findings
(mixed types), 9 tasks across sections, 6 topics, links between them, one
stale store. UI tests (`MemoryTests`): search selects a node and pans; a
project chip narrows counts; content filter hides tasks; a task row's explicit
action moves it to Done and the Tasks tab agrees; the dossier's Show in list
scrolls the panel; the Search tab id no longer
exists and the Memory tab does. Existing `GraphTests` keep passing unchanged.

## 6. Order of work

1. `PhrenSearchField` and `PhrenChipRow` (or take them from the control kit).
2. `MemoryView` with the panel's contents mode; retire `SearchView`.
3. Results mode over `SearchIndex` plus the graph's own search.
4. Task and finding actions on rows.
5. Fixture, tests, screenshots at the standard size, changelog.

## 7. v2: map or list (owner, September 21)

Owner's words: "there should just be a search icon and then two drop-down
multiple select things, one findings/tasks etc. and the other projects, one
line, no blank space; a list view icon brings up the list separate from the
map rather than forcing them together; the list looks right and follows the
filters; map or list."

### 7.1 Layout

1. **Top bar** (44pt): title "Memory" centred; trailing search icon
   (`magnifyingglass`, 44pt target, id `memory-search-toggle`). Tapping it
   slides the existing `PhrenSearchField` in under the bar (id
   `memory-search`); the field's clear button or an empty submit slides it
   away. Search applies to both modes.
2. **Filter line** (one row, 44pt, 16pt gutters): two phren drop-downs and
   the mode toggle.
   - **Kinds** drop-down (id `memory-kinds`): button label reads "All kinds"
     or the chosen ones joined ("Findings, Tasks"); tap opens a
     `PhrenDialog`-styled sheet with one `PhrenOptionRow` per kind
     (Findings, Notes, Tasks, Topics), multi-select with check marks, ids
     `memory-kind:<kind>`, a "Done" row at the bottom. At least one kind
     stays selected.
   - **Projects** drop-down (id `memory-projects`): label "All projects" or
     the chosen names ("phren, ledger", middle-truncated past two); same
     sheet shape, one row per project of the selected store, store chooser
     as the first row when the phone has several stores, ids
     `memory-project:<name>`. Empty selection means all.
   - **Mode toggle** at the trailing edge: `PhrenIconSegment` with two
     values, map (`point.3.connected.trianglepath.dotted`) and list
     (`list.bullet`), id `memory-mode`, value "map" or "list". Remembered
     per phone.
3. **Map mode**: the graph fills everything from the filter line to the tab
   bar. No bottom panel. Selecting a node opens the web dossier as today;
   its "Show in list" row switches to list mode scrolled to that row.
4. **List mode**: the v1 panel rows (section 2) fill the same area,
   grouped by project when more than one project is selected, counts line
   at the top ("413 findings · 583 tasks · 9 topics" for the current
   filters). Tapping a row in list mode switches to map mode with that node
   selected; the row's action glyph opens the same action sheet as v1.

### 7.2 Removed from v1

The scope chip row, the content-filter chip row, the bottom panel and its
three heights, and the drag handle. `MemoryPanel` becomes the list-mode
body. The panel identifiers `memory-panel`, `memory-panel-height`,
`memory-filter:*`, `memory-scope:*` go; `MemoryTests` is rewritten for the
new ids (owner: keep the tests few; one test per mode plus one for the
filters is enough, no accessibility-size tests).

### 7.3 Bug to fix alongside

On the device the graph web view stops about two thirds down the screen
and leaves a dead band above the panel (screenshot, September 21, 21:02).
The web view's height must follow the SwiftUI frame it is given; check
`GraphWebView` sizing against `GeometryReader` in `MemoryView` and the
renderer's resize handler in `index.html`. In v2 the graph gets the whole
area, which must hold on rotation and when the search field slides in.
