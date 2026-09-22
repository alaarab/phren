# Code screen

The `code` module's phone surface: a project's symbol index as search and a
symbol dossier. Reached from the project page band's Code cell, which is hidden
unless a connected computer advertises the `code` capability. Each project needs
its own index on the computer (`phren code index <project>`); a project with no
index shows "No code index for <project>.".

## Layout

- One `PhrenSearchField` (id `code-search`) at the top, 44pt, phren's own.
- No query: the usage screen, `Hot` then `Cold` sections. Each row is a
  `sessionCard()` with the name in body weight, a `PhrenChip` for the kind, the
  file in monospaced caption, and the reference count trailing.
- With a query: a `Symbols` section of the same rows, ranked exact name, prefix,
  full-text, then usage.
- Rows carry `code-row:<id>`; tapping one opens the dossier (id `code-dossier`).

## Dossier

A large sheet with a header (name, kind chip, `file:line`, close), then:

- the definition snippet in the Changes screen's monospace (`phrenPanel(tool:)`),
- the last-change line (date and a truncated blame hash, never a name),
- references grouped by file, each reference a row with its line and kind,
- a `Findings` section containing the stored findings with matching symbol citations.

## States

- No host serves `code`: the Code cell is absent, so the screen is unreachable.
- Loading: "Loading index…" / "Searching…" in muted caption.
- No index: "No code index for <project>." (the route is a 404).
- No matches: `No symbols match "<query>"`.
- Failure: the computer's message in the warning tint (id `code-error`).

## UI tests

`PhrenUITests/CodeTests.swift` runs against `--code-fixture`, a fixed index of a
dozen symbols across three files, so no Hook is needed. Screenshots:
`Code search`, `Code dossier`.

## Line notes and agent delivery

Every snippet line is a 44-point target identified by `code-line:<n>`.
The selected line has an accent bar and line number. Selection reveals the
`code-note` composer and `code-send` button. Send opens a PhrenSingleSelectSheet
of fresh project sessions from the overview on the index computer, plus New
worker and Save note only. New workers use the visible PhrenSingleSelect harness
choice. Existing sessions are resolved to their live panes before selection.

`POST /v1/code/note` takes project, symbol, file, line, text and optional target
(session or harness). It validates the selected line against the indexed
symbol, saves a symbol-cited finding, then hands off or dispatches a brief with
the location, snippet and note. Sending requires conductor; saving alone does
not. Delivery failure is separate from save success so the phone preserves the
finding and reports uncertainty without automatically sending again.

Hot, cold and search rows show the usage count with a small logarithmic bar.
