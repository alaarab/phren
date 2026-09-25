# Code index

The optional `code` module indexes a local checkout and exposes its functions,
types and variables, and where they are used, through CLI commands, MCP tools
and Phren Hook. Its database is rebuildable local state
at `<store>/.runtime/code/<project>.sqlite`; it is not synced with the store.

## Enable and index

```sh
phren modules enable code
phren code index demo --repo /home/sam/Projects/demo
phren code status demo
```

Restart MCP and Hook after changing enabled modules. The module requires
`memory`. The Hook must also be installed to serve the phone.

Without `--repo`, checkout discovery tries the registered source path and this
computer's usual project roots, including `PROJECTS_DIR`. The index remembers
the chosen checkout for source snippets. `--full` forces every file to be parsed.

## What is indexed

The indexer walks `git ls-files --cached --others --exclude-standard`: tracked
files plus new files git does not ignore, so an agent's new file is indexed
before it is committed. It reads regular files up to 1.5 MB and skips binary
files, symlinks, common generated directories and asset extensions. Content
hashes skip unchanged files.
Changing the checkout root forces a rebuild even if file contents match.

Bundled tree-sitter grammars cover TypeScript, TSX, JavaScript, Swift, Python,
Rust, Go, Ruby and Bash. Other files use a line-based declaration fallback;
that fallback does not provide semantic reference resolution.

The SQLite database contains file hashes, declarations (functions, types and
variables), FTS5 text over
names/signatures/docs, raw reference names, resolved references and last-change
metadata. Writes use one transaction per indexing pass and prepared inserts.
A per-project file lock excludes concurrent writers; persistence replaces the
database atomically. Existing indexes acquire raw reference names on their
first refresh after upgrading.

Reference matching is lexical: a unique same-file declaration wins; otherwise
a unique project-wide declaration wins. Ambiguous names remain unresolved.
Imports, aliases, overloads and receiver types are not semantically resolved.
Changing or deleting definitions recomputes references from unchanged callers
too. Usage counts are therefore a navigation aid, not proof that code is dead.

Last-change metadata is the last non-merge commit touching the file, applied
to its declarations. It contains an author hash and date, not a person's name;
it is not line-level blame.

What changed does not come from the index's own history. It takes the lines
that today's agent sessions added in this checkout (the Hook's recorded edits)
and that the last 10 commits added, and names the innermost function, type or
variable each line falls in. A declaration whose every line was added is new.
Only top-level or exported variables count, never locals. The repository's
first commit is left out, since it adds every file. A recorded session edit
carries the line numbers it had when it was made, so a later edit to the same
file can shift where it lands.

## Query surfaces

| CLI | MCP tool | Result |
| --- | --- | --- |
| `phren code search demo <query>` | `code_search` | Exact names, prefixes, then FTS relevance and usage |
| `phren code def demo <name>` | `code_definition` | Where it is defined: candidate count, snippet and last change |
| `phren code refs demo <name>` | `code_references` | Every resolved use, grouped by file |
| `phren code outline demo <path>` | `code_outline` | Source order with members nested under parents |
| `phren code usage demo` | `code_usage` | Most and least used functions and types |

Names accept `Name`, `Type.member`, `name()` and `file::Type.member`. A file
qualifier keeps the lookup in that file. A container-qualified lookup must match
its container. Unqualified ambiguous lookups prefer exported declarations and
non-variables and report the candidate count. Search accepts `--kind` and
`--limit`; usage accepts `--top`.

MCP results are compact text. The full profile exposes the five tools directly;
the core profile reaches enabled tools through `phren_admin`. Hook adds JSON
routes for indexed files, scoped search, paged usage, what changed, per-file
change counts, one file's resolved references, reindexing and notes. The MCP
tools and Hook routes take `name`; the older `symbol` spelling is accepted until
0.2.18. See the complete
[route table](api-reference.md#hook-routes).

## Refresh and phone

Hook observes recorded tool/git changes and debounces affected projects for
500 ms. A change arriving during a refresh queues one trailing refresh.
Recorded changes also check HEAD; a change to it requests a full refresh of
that indexed checkout. This is not a general filesystem watcher; edits outside
recorded changes may require `phren code index`.

The phone's Code screen is the project's one code browser. It opens on What
changed: the functions, types and variables your agents touched today and in
the last 10 commits, grouped by file, new ones marked, each with "Used in N
places". A quiet line under the title shows file, function and type counts and
the index time; Rebuild lives in the ••• menu. Files lists every entry of the
checkout through `/v1/projects/files`, including files the index never reads,
with declaration counts beside indexed ones. A text
file opens in the code viewer with syntax colors, up to the files route's
2 MiB; a larger file says so and offers the paged file viewer. Pictures,
video, audio, PDF and CSV open in the file viewer. For an indexed file the
viewer has its outline, and the names `/v1/code/file-references` and the
outline resolve are tappable: each opens that function's or type's details, whose Go to
definition and reference rows open the file at that line, in this file or
another. Search groups its results into Functions, Types and Variables, and
accepts a directory scope and a kind filter, including Types for classes,
structs, enums, interfaces and aliases.

Most used is the full paged ranking, including variables and declarations
nothing uses yet; with a kind filter it reads "Most used functions" or "Most
used types". Kind, directory and file filters apply to the same list; Most used
and Least used jump to its first and last pages. Bars share the filtered list's
maximum. A What changed, search or ranking row opens its details: where it is
defined, a source snippet, the last Git change, where it is used and the
findings linked to it.

Code also opens from a session's Changes band and chat header actions when its
computer has an index. These entries retain that computer, store, project and
session as the note recipient. The Working tree keeps expanded folders and
loaded children across refreshes and tab switches. Each changed file gets a
chip like "2 functions changed · 1 new type", from `/v1/code/change-counts`
(the working-tree diff; an untracked file is new throughout; variables stay
out to keep it short). The chip opens the first of them. A missing index leaves the ordinary tree
usable. An unchanged or ignored text file opens in the same code viewer, read
from the pane's repository.

The project page's Code cell is the one way into a project's files. It starts
on a computer with the code index and a line under the title chooses any saved
computer's located checkout instead. Without the code module the browser still
lists and opens every file, without search, What changed or Most used.

## Findings linked to code

For a single finding, `add_finding` can link it to a function, type or variable
with `citation.name`. When an index exists it checks that name and keeps an
unresolved one marked as such. Without an explicit name it considers
identifiers of at least four characters and links the first one that resolves
uniquely. Local unexported variables are excluded from automatic attachment.

`code_definition` and `phren code def` append the findings linked to it from
FINDINGS.md and archived topic files. `get_findings` and `search_knowledge`
expose each finding's code link. The Hook definition route includes them in
`definition.findings` too.

Select a snippet line in a function's or type's details and write "Remember
this about parseConfig": Remember saves it as a Phren finding linked to that
function, so agents recall it later. From the project it then asks "Also tell
an agent?" and offers a live project session, a new worker or Just remember it;
from a session it goes straight back to that session. `POST /v1/code/note`
validates the line against the indexed snippet and saves the finding with its
file, line and code link before attempting delivery. Sending requires `conductor`;
saving alone requires only `code`. Delivery errors leave the saved finding in
place and are reported separately. The phone does not automatically resend.

All Code routes accept an optional registered store selector. The phone sends
its store ID so projects with the same name in different stores stay separate.
The Hook resolves the selector through its store registry; it does not accept
an arbitrary store path. Note and reindex requests reject a selected read-only
store.

## Optional installation

Code indexing ships in the separate `@phren/code` workspace and npm package.
Fresh stores enable memory only. Run `phren modules enable code` to make the
package loadable, enable its tools and routes, and copy its bundled code skill
into the store. A workspace checkout at `packages/code` is linked; otherwise the
package is installed under `<store>/.runtime/packages` so the Hook can find it
without a global npm. Resolution checks `PHREN_CODE_PACKAGE`, the bridge's
node_modules, that store directory, a plain import and finally `npm root -g`
(shielded from a service PATH without npm). If installation fails, run
`npm install --prefix <store>/.runtime/packages @phren/code` and retry. Restart
MCP and Hook after changing modules; `/v1/health` reports where the package
loaded from.
