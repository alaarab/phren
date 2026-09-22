# Code screen

The Code destination opens on the project's indexed codebase. The project band,
session Changes tab and chat action use `curlybraces`. A local SF Symbol rendering
at 15pt and 17pt showed its two clean strokes remain legible; the slashed chevrons
look like a generic coding action and the stacked squares lose interior detail.
Phone screenshots are checked by the simulator runner.

## Home and scope

- The header gives indexed file and symbol totals, languages with file counts,
  last completed index time, and a 44-point Reindex action (`code-reindex`).
- Files is the initial `PhrenTextSegment` selection. Usage and Recent are its
  other destinations (`code-mode:files|usage|recent`). A `PhrenSearchField`
  (`code-search`) searches symbols from any destination.
- Files shows one indexed directory at a time. Folders aggregate descendant
  file and symbol counts; files show their symbol counts, including zero.
  `code-tree:<path>` opens a folder or a source-ordered file outline. Root and
  Up actions retain an explicit, visible directory scope. File declarations
  (`code-file-symbol:<line>:<name>`) open the exact file-qualified dossier.
- Selecting a directory scopes search and Recent to its descendants, using a
  literal path prefix. Kind filtering uses a phren single-select card:
  All kinds, Function, Method, Type, Variable. Type includes classes, structs,
  enums, interfaces and aliases. Clearing search returns to the selected mode.
- Usage is one descending reference ranking, with stable ties by name, file,
  line and ID. Every symbol participates, including variables and zero uses.
  Rows show global rank, file location, kind, count and a 36-point linear bar
  scaled to the maximum in the filtered distribution. Zero draws no filled bar.
  Previous/Next ranks fetch bounded pages of 50. Hot jumps to the first page
  and scrolls to its first row; Cold jumps directly to the final page and its
  last row. These are positions in the same list, with the same filters.
- Usage's file filter is a phren action sheet that browses indexed folders.
  File outlines also offer Usage in this file. Clear file filter restores the
  directory distribution; Root clears the directory scope.
- Recent shows the 30 symbols the index most recently saw change. A persisted
  fingerprint covers declaration metadata and body text; unchanged full scans
  preserve observation time. Old indexes fall back to file parse time until
  the next scan records fingerprints. This is index observation time, not Git
  author time. Each row opens the same dossier.

## Routes and wire data

`GET /v1/code/tree?project=&directory=` returns immediate indexed children with
`path`, `directory`, `files`, `symbols`, and `languages`. It reads the index, so
unindexed files never appear as empty source files.

`GET /v1/code/usage-page?project=&kind=&file=&directory=&offset=&limit=&end=`
returns full symbol rows in `entries`, plus `total`, `offset`, `limit`, and
`maxUses`. The limit is 1 to 100. `end=1` addresses the last page directly.
Filtering and pagination happen in SQLite. The older hot/cold route remains
available to older clients.

`GET /v1/code/recent` returns symbol rows with millisecond `indexedAt` change
observations. `GET /v1/code/search` also accepts `directory` and `kind=types`.
`POST /v1/code/reindex` takes `project` and optional registered `store`, performs
an incremental scan and returns status. A read-only registered store rejects
this action. Every phone request includes its actual store selector.

## Dossier

A large sheet with a header (name, kind chip, `file:line`, close), then:

- the definition snippet in the Changes screen's monospace (`phrenPanel(tool:)`),
- the last-change line (date and a truncated blame hash, never a name),
- references grouped by file, each reference a row with its line and kind,
- a `Findings` section containing the stored findings with matching symbol citations.

## States

- No host serves `code`: the project Code cell is absent; an open screen asks for a connection.
- Loading: "Loading index…" / "Searching…" in muted caption.
- No index: the route error stays visible with Reindex and Retry available.
- No matches: `No symbols match "<query>"`.
- Failure: the computer's message in the warning tint (id `code-error`).

## UI tests

`PhrenUITests/CodeTests.swift` runs against `--code-fixture`, a fixed index of a
dozen symbols across three files, so no Hook is needed. Five-row fixture usage
pages exercise middle ranks and both jumps. Tests cover the initial tree, file
outline to dossier, search to dossier, and kind filtering. Screenshots include
`Code home tree`, `Code tree dossier`, `Code middle usage`, `Code search`, and
`Code dossier`. Route tests cover complete pagination, path boundaries, tree
counts, empty files and recency; PhrenKit validates the new envelopes.

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

Search and dossier usage indicators use compact logarithmic bars; the Usage
ranking uses a shared linear scale across pages.


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
