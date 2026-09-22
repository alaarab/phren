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


## Session entry points

The session's Changes band includes Code when `/v1/code/status` confirms an
index on that session's computer. Chat header actions offer the same destination.
`SessionCodeContext` carries the store ID, project, computer and exact session
target through CodeView and the dossier. The computer never falls back to a
different host. Requests include the registered store selector, so projects
with the same name in separate stores stay separate.

A note opened from either session entry sends directly to that session through
`/v1/code/note`. The project-page entry still offers its recipient chooser.
Delivery failure preserves the saved finding and reports the failure without
retrying or silently selecting another agent.

## Working tree

The Hook returns one directory at a time, with descendant file counts and a
snapshot version. Its bounded cache checks HEAD on every request, hashes the
file listing and porcelain status, and expires after two seconds. Explicit
status refresh and file mutations invalidate it. Directory opens do not collect
diff line counts or upstream history.

The Changes model owns expanded paths and loaded children across tab switches.
Refresh replaces visible children in place and prunes confirmed removed paths.
Closed branches retain their cache and revalidate against the new version when
opened. A single batched outline-summary request per group of up to 200 paths
adds symbol counts and up to three leading kinds; directory counts include all
descendants. Optional index failures leave the ordinary tree usable.

A file's symbol chip opens its first declaration's dossier, using a
`file::Container.name` query to avoid a namesake in another file. The originating
session remains the note recipient. IDs are `changes-tab-code`,
`chat-options-code`, and `changes-tree-symbols:<path>`.

UI coverage in ChangesTabTests captures the session Code tab, enriched tree and
direct note delivery. AgentChatTests captures the header action entry.
