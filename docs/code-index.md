# Code index

The optional `code` module indexes a local checkout and exposes symbols through
CLI commands, MCP tools and Phren Hook. Its database is rebuildable local state
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

The indexer walks `git ls-files`, reads tracked regular files up to 1.5 MB and
skips binary files, symlinks, common generated directories and asset extensions.
Untracked files do not enter the index. Content hashes skip unchanged files.
Changing the checkout root forces a rebuild even if file contents match.

Bundled tree-sitter grammars cover TypeScript, TSX, JavaScript, Swift, Python,
Rust, Go, Ruby and Bash. Other files use a line-based declaration fallback;
that fallback does not provide semantic reference resolution.

The SQLite database contains file hashes, symbol declarations, FTS5 text over
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

Recent uses a separate observation time: a persisted fingerprint of each
declaration's metadata and body records when the index last saw it change.
Unchanged scans preserve that time, including full scans. Older indexes use
file parse time until their next scan records symbol fingerprints.

## Query surfaces

| CLI | MCP tool | Result |
| --- | --- | --- |
| `phren code search demo <query>` | `code_search` | Exact names, prefixes, then FTS relevance and usage |
| `phren code def demo <symbol>` | `code_definition` | Chosen declaration, candidate count, snippet and last change |
| `phren code refs demo <symbol>` | `code_references` | Resolved references grouped by file |
| `phren code outline demo <path>` | `code_outline` | Source order with members nested under parents |
| `phren code usage demo` | `code_usage` | Hot and cold non-variable symbols |

Symbols accept `Name`, `Type.member`, `name()` and `file::Type.member`. A file
qualifier keeps the lookup in that file. A container-qualified lookup must match
its container. Unqualified ambiguous lookups prefer exported declarations and
non-variables and report the candidate count. Search accepts `--kind` and
`--limit`; usage accepts `--top`.

MCP results are compact text. The full profile exposes the five tools directly;
the core profile reaches enabled tools through `phren_admin`. Hook adds JSON
routes for indexed files, scoped search, paged usage, recent changes, batched
outline counts, reindexing and notes. See the complete
[route table](api-reference.md#hook-routes).

## Refresh and phone

Hook observes recorded tool/git changes and debounces affected projects for
500 ms. A change arriving during a refresh queues one trailing refresh.
Recorded changes also check HEAD; a change to it requests a full refresh of
that indexed checkout. This is not a general filesystem watcher; edits outside
recorded changes may require `phren code index`.

The phone's Code screen opens on indexed files. Its header shows file and symbol
counts, languages, index time and Reindex. Folders show descendant file and
symbol totals; files open their source-ordered outlines. Search accepts a
directory scope and a kind filter, including Type for classes, structs, enums,
interfaces and aliases.

Usage is the full paged ranking, including variables and symbols with no
resolved references. Kind, directory and file filters apply to the same list;
Hot and Cold jump to its first and last pages. Bars share the filtered list's
maximum. Recent lists the 30 symbols the index last saw change. A symbol opens
its definition, source snippet, last Git change, references and cited findings.

Code also opens from a session's Changes band and chat header actions when its
computer has an index. These entries retain that computer, store, project and
session as the note recipient. The Working tree keeps expanded folders and
loaded children across refreshes and tab switches. Batched outline summaries
add symbol counts and leading kinds; a file's symbol chip opens its first
declaration's file-qualified dossier. A missing index leaves the ordinary tree
usable.

## Findings linked to code

For a single finding, `add_finding` can store an explicit `citation.symbol`.
When an index exists it checks that citation, preserving unresolved names with
`symbol_unresolved: true`. Without an explicit name it considers identifiers
of at least four characters and attaches the first uniquely resolving eligible
symbol. Local unexported variables are excluded from automatic attachment.

`code_definition` and `phren code def` append citing findings from FINDINGS.md
and archived topic files. `get_findings` and `search_knowledge` expose stored
symbol citations. The Hook definition route includes them in
`definition.findings` too.

Select a snippet line in the phone's dossier to write a note. The project entry
offers a live project session, a new worker or Save note only. A session entry
sends directly to the originating session. `POST /v1/code/note` validates the
line against the indexed snippet and saves a finding with its file, line and
symbol citation before attempting delivery. Sending requires `conductor`;
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
