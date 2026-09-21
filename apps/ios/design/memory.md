# Memory: one page for the graph, findings and tasks

Status: proposal, September 20. Owner's prompt: the Search tab is a wasted
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
