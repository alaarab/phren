# Code screen

The Code destination is the project's one code browser: every file in the
checkout, opened in a code viewer that knows the index's functions, types and
variables. It never says "symbol": items are named by what they are. The project band,
session Changes tab and chat action use `curlybraces`. A local SF Symbol rendering
at 15pt and 17pt showed its two clean strokes remain legible; the slashed chevrons
look like a generic coding action and the stacked squares lose interior detail.
Phone screenshots are checked by the simulator runner.

## Home and scope

- One quiet line under the title gives indexed file, function and type counts
  and the last completed index time; Rebuild index lives in the ••• menu.
- What changed is the initial `PhrenTextSegment` selection; Files and Most used
  follow (`code-mode:changed|files|usage`). A `PhrenSearchField` (`code-search`,
  "Find a function, type or variable") searches from any destination and groups
  its results under Functions, Types and Variables headers; there is no
  umbrella word.
- What changed lists, by file, the functions, types and variables that today's
  agent sessions and the last 10 commits touched (`/v1/code/changed`), most
  recent work first. A file row (`code-changed-file:<path>`) opens the file; an
  item row (`code-changed:<file::Container.name>`) shows its name, a `new`
  chip when every line was added, "function · line N" and "Used in N places",
  and opens its details. Only top-level or exported variables appear.
- Files shows one checkout directory at a time from `/v1/projects/files`,
  folders first, including files the index never reads. A single 44-point row
  per entry: folder or file-type icon, name, and the index's declaration count
  when it has one. `code-tree:<path>` opens a folder, or a file in the code
  viewer. Pictures, video, audio, PDF and CSV open in the file viewer instead.
  Root and Up actions retain an explicit, visible directory scope. When the
  checkout cannot be listed, the indexed tree still is.
- Selecting a directory scopes search and Most used to its descendants, using a
  literal path prefix. Kind filtering uses a phren single-select card:
  Everything, Functions, Methods, Types, Variables. Types includes classes,
  structs, enums, interfaces and aliases. Clearing search returns to the
  selected mode.
- Most used is one descending ranking by places used, with stable ties by name,
  file, line and ID. Every declaration participates, including variables and
  zero uses; with a kind filter the header reads "Most used functions" (or
  types, methods, variables). Rows show global rank, file location, kind, count
  and a 36-point linear bar scaled to the maximum in the filtered distribution.
  Zero draws no filled bar. Previous/Next ranks fetch bounded pages of 50. Most
  used jumps to the first page and scrolls to its first row; Least used jumps
  directly to the final page and its last row. These are positions in the same
  list, with the same filters.
- Usage's file filter is a phren action sheet that browses indexed folders.
  Clear file filter restores the
  directory distribution; Root clears the directory scope.
- Opened from the project page, the browser starts on a computer that keeps
  the code index (else the first saved computer) and lets the Hook pick the
  checkout. One quiet 44-point line under the title (`code-place`) names the
  computer and chosen checkout and opens a phren single-select of every saved
  computer's located checkouts (`code-place:<host-id>:<folder>`); choosing one
  returns to the root. Session entries keep their own computer and show no line.
- Without the code module on that computer, the browser shows the project
  name as its title and Files only: no header, search or modes. The project
  page's Code cell stays while any computer is saved, reading Files instead of
  the index counts.

## Code viewer

`CodeFileView` shows one file: its folder path in one muted mono line, then
numbered source in `PhrenTypography.monoFootnote` with `CodeHighlighting`
colors. Rows are lazy, so a render colors only the lines on screen; a
zero-height copy of the longest line holds the horizontal width steady.
Everything else is the file's own content, with no captions.

- Reading: `/v1/files/range`, the first 256 KiB and then the rest in one more
  read. Over the files route's 2 MiB the viewer says "<size> is over the 2 MB
  the code viewer reads." with Open in file viewer (paged text). Content with a
  NUL byte or invalid UTF-8 says "Not a text file." with the same action.
- Outline: a `PhrenIconButton` (`code-file-outline`) in the navigation bar,
  only for indexed files with declarations. It opens a phren action sheet of
  the flattened outline (`code-outline:<line>:<name>`, kind and line as the
  caption, a filter field past eight rows). Choosing one scrolls the line to
  the upper fifth and tints it with the accent.
- Tappable names: the outline's declarations and every resolved use from
  `/v1/code/file-references`, matched as whole identifiers on their own line,
  are links in the accent tint with a dotted underline. A link opens that
  function's or type's details as a medium sheet: header with name, kind, location, usage
  bar and Go to definition (`code-dossier-definition`), then snippet,
  "Used in N places" and findings. Go to definition and every reference row
  (`code-reference:<file>:<line>`) open that line, in place for this file or by
  pushing the other file's viewer. An older Hook without the route still gets
  tappable declarations from the outline.
- Unindexed and non-index sources (the working tree without an index) open
  read-only with colors and no links.

Entry points into the browser: the project page's Code cell, the session's
Changes Code tab and chat options Code (all `CodeView`), and the Changes working
tree, whose unchanged or ignored text files open in `CodeFileView` from the
pane's repository. A computer's Files page keeps its uploads and Memory's Files
keeps the store's own files; neither lists projects.

## Routes and wire data

`GET /v1/code/tree?project=&directory=` returns immediate indexed children with
`path`, `directory`, `files`, a declaration count (`symbols`), and `languages`.
The browser merges those counts into the checkout listing from
`/v1/projects/files`.

`GET /v1/code/file-references?project=&path=` returns one file's resolved uses in
line order, each with the declaration as a file-qualified `symbol`, its `file`
and `targetLine` (at most 5000).

`GET /v1/code/usage-page?project=&kind=&file=&directory=&offset=&limit=&end=`
returns full declaration rows in `entries`, plus `total`, `offset`, `limit`, and
`maxUses`. The limit is 1 to 100. `end=1` addresses the last page directly.
Filtering and pagination happen in SQLite. The older compact ranking route
remains available to older clients.

`GET /v1/code/changed?project=` returns `{project, files}`: each file's changed
functions, types and variables with `family`, `isNew` and `uses`. It maps the
lines added by today's recorded agent edits in this checkout and by the last 10
commits (not the first, which imports everything) to the innermost declaration.
`GET /v1/code/change-counts?project=&paths=` returns per-file `functions` and
`types` tallies (`changed`, `added`) from the working-tree diff, and `first`.
`GET /v1/code/search` also accepts `directory` and `kind=types`.
`POST /v1/code/reindex` takes `project` and optional registered `store`, performs
an incremental scan and returns status. A read-only registered store rejects
this action. Every phone request includes its actual store selector.

## Details

A function's or type's details (`CodeItemDossier`): a large sheet with a header
(name, kind chip, `file:line`, Close), then:

- the definition snippet in the Changes screen's monospace (`phrenPanel(tool:)`),
- the last-change line (date and a truncated blame hash, never a name),
- "Used in N places", grouped by file, each use a row with its line and kind,
- a `Findings` section: what Phren remembers about it (findings linked to it).

## States

- No host serves `code`: the project Code cell is absent; an open screen asks for a connection.
- Loading: "Loading index…" / "Searching…" in muted caption.
- No index: the route error stays visible with Reindex and Retry available.
- No matches: `Nothing named "<query>"`.
- Nothing changed: "Nothing changed today or in the last 10 commits."
- Failure: the computer's message in the warning tint (id `code-error`).

## UI tests

`PhrenUITests/CodeTests.swift` runs against `--code-fixture`, a fixed index of a
dozen functions and types across three files plus a README, what changed in
two of them, a nested unindexed text file
and a picture, so no Hook is needed. Five-row fixture usage pages exercise
middle ranks and both jumps. Tests cover the checkout tree, a nested unindexed
file, an outline jump, a tapped name to its dossier and Go to definition in
another file, What changed leading the page and opening a changed function's
details and its file, a picture keeping the file
viewer, choosing another computer's checkout, search to dossier, and
kind filtering. Screenshots include `Code what changed`, `Code home tree`, `Code file`,
`Code outline`, `Code details panel`, `Code definition in another file`,
`Code computer and checkout`, `Code file on a chosen checkout`,
`Code middle usage`, `Code search`, and
`Code dossier`. Route tests cover complete pagination, path boundaries, tree
counts, empty files, what changed and change counts; PhrenKit validates the
new envelopes and the chip wording.

## Line notes and agent delivery

Every snippet line is a 44-point target identified by `code-line:<n>`.
The selected line has an accent bar and line number. Selection reveals the
`code-note` composer ("Remember this about <name>") and its Remember button
(`code-send`). Remember saves the note as a finding linked to the function, so
agents recall it later. From the project it then opens "Also tell an agent?",
a PhrenSingleSelectSheet of fresh project sessions from the overview on the
index computer, plus New worker and Just remember it. New workers use the visible PhrenSingleSelect harness
choice. Existing sessions are resolved to their live panes before selection.

`POST /v1/code/note` takes project, name (older phones send `symbol`), file,
line, text and optional target (session or harness). It validates the selected
line against the indexed declaration, saves a finding linked to it, then hands off or dispatches a brief with
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
opened. A single change-counts request per group of up to 200 paths adds a
chip per changed file, like "2 functions changed · 1 new type", from the
working-tree diff; variables stay out to keep it short, and an untracked file
is new throughout. Optional index failures leave the ordinary tree usable.

A file's chip opens the details of its first changed function or type, using a
`file::Container.name` query to avoid a namesake in another file. The originating
session remains the note recipient. IDs are `changes-tab-code`,
`chat-options-code`, and `changes-tree-chip:<path>`.

UI coverage in ChangesTabTests captures the session Code tab, enriched tree and
direct note delivery. AgentChatNavigationTests captures the chat options entry.

Show ignored is a PhrenSwitch in the working tree's header, off by default and
remembered (`changes.tree.showIgnored`). On, each level adds the git-ignored
folders and files Git reports there, drawn at half opacity with the spoken value
"Ignored". An ignored folder expands from the disk; an ignored file opens in the
code viewer when it is text and in the file viewer otherwise, never as a diff. IDs: `changes-tree-switch:ignored`, and the
existing `changes-tree-entry:<path>` rows.

## Workers

phren is organized around live sessions and the agent tree; a worktree is a
detail of the worker that owns it. Workers (sub-agents, fan-out jobs) edit in
their own worktree, so the pane's diff never shows their work. The pane's own
Changes screen has a Workers section listing the repository's other worktrees:
the worker's task when the Hook can name it (fan-out manifest, or a Claude
sub-agent whose checkout it is), otherwise the branch, then branch and path,
with uncommitted files and commits ahead trailing. Named workers come first,
under Workers; the rest under Other worktrees. A row opens the same Changes
screen bound to that worktree (list, diff, history, branches, PRs, working tree
and files), titled with the worker's task and without a Workers section of its
own. In the agent tree, a local worker whose worktree is known has a Changes
button on its row that opens its changes directly.

IDs: `changes-tab-workers`, `changes-workers-section:workers`,
`changes-workers-section:other`, `changes-worktree:<id>`, `changes-workers-empty`,
`child-agent-changes:<child id>`. ChangesWorkersTests covers the section, a
worker's bound view, the agent-tree entry and Show ignored with screenshots.

## Commit, push and pull request

The Changes list opens with a publish panel while the pane is on a branch: a
PhrenTextField (`changes-commit-message`, up to four lines) and a Commit button
(`changes-commit`), enabled only with staged files and a message, then Push
(`changes-push`) and Open pull request (`changes-open-pr`). Push reads "Push new
branch" without an upstream and "Push <n>" with commits ahead. Once the pulls
data has the branch's own pull request, Open pull request becomes
`changes-view-pr`, which opens it. A commit or push that lands leaves one quiet
line under the actions (`changes-publish-landed`); the draft is cleared only on
success and survives section switches.

Push and the pull request confirm first in phren dialogs (`changes-push-dialog`,
`changes-pr-dialog`). Pushing the default branch names it in the title, and its
action is destructive; only that confirmation sends `confirmDefault`. The pull
request dialog offers Open pull request and Open as draft, and says to push first
when GitHub has not seen every commit. Refusals open a dialog with the output
exactly as printed (`changes-commit-refused`, `changes-push-refused`,
`changes-pr-refused`); a new pull request opens `changes-pr-opened` with View on
GitHub.

The session card shows the branch's pull request after the branch: number,
state word (open, draft, merged, closed) in its color, and a checks mark (check,
cross or clock). It reads `SessionPullRequestCache`, which is filled only when
Changes loads or refreshes and when the overview first appears or is refreshed.
IDs: `live-pr:<session>`, `overview-pr:<session>`.

ChangesPublishTests covers commit, push and the pull request with the card chip
(`--changes-feature-branch`), a hook refusal and the default branch
(`--changes-commit-hook-fails`), and the overview's refresh
(`--changes-pull-open`), with screenshots.
