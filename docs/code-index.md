# Code index

Status: design, September 21. Owner: "implement my own version of VS Code's
indexing in phren; all the enhanced features we get from indexing our codebase."
This supersedes the September 20 decision to front Lexon; the index is
in-house, as the `code` module.

## What "the enhanced features" are

What an IDE index gives a person, phren gives agents and the phone:

| Feature | Agent tool | Phone |
|---|---|---|
| Go to definition | `code_definition(symbol, project)` | tap a symbol in a code view |
| Find references / callers | `code_references(symbol, project)` | list under the symbol |
| Outline of a file | `code_outline(path, project)` | Code screen file view |
| Symbol search across a project | `code_search(query, project, kind?)` | Code screen search |
| Hover: signature and doc comment | in every result | row caption |
| Usage counts (hot and cold symbols) | `code_usage(project, top?)` | the Memory graph draws a symbol layer |
| Who changed it last | in every result, from git blame | row trailing |
| Notes on a symbol | findings cite `symbol:` and show inline | dossier |

Hot and cold both matter (owner, September 20: "show everything, not only
hot").

## Shape

- **Module `code`**, default off, requires `memory`. Manifest declares the
  tools above, CLI `phren code <index|status|search|outline|refs> [project]`,
  Hook routes `GET /v1/code/{search,outline,references,definition,usage}`,
  local files under `<store>/.runtime/code/<project>.sqlite`, phone screen
  `CodeView` behind capability `code`, and a `code` skill that tells agents
  when to use the tools instead of grep.
- **Parser**: `web-tree-sitter` (WASM, no native build, works inside the
  Hook bundle) with grammars for TypeScript, JavaScript, Swift, Python,
  Rust, Go, Ruby, Bash, JSON and Markdown headings shipped as `.wasm`
  files under `packages/cli/grammars/`. Unknown languages get a
  line-based fallback (top-level `function`, `class`, `def` regexes) so
  every file has an outline.
- **Storage**: one SQLite per project under `.runtime/code/`, never in the
  synced store. Tables: `files(path, hash, language, mtime, indexed_at)`,
  `symbols(id, file, name, kind, line, end_line, signature, doc, parent,
  exported)`, `references(symbol_id, file, line, kind)`, `blame(file, line,
  author_hash, at)` and an FTS5 table over `name`, `signature`, `doc` using
  the `sql.js-fts5` build phren already ships. Author is a hash of the git
  author, never the name, so nothing personal lands in the index.
- **Indexing**: `phren code index <project>` walks the project's tracked
  files (respecting `.gitignore`), parses changed files by hash, and
  resolves references by name within the project plus imports it can
  follow. Incremental: the Hook's git watcher (the Changes module's file
  events) re-indexes changed files within a second of a save; a full
  re-index happens on branch switch. A 100k-line TypeScript project must
  index in under 20 s cold and under 200 ms per changed file.
- **Ranking**: `code_search` ranks by exact name, prefix, FTS score, then
  usage count; `code_usage` returns the top and bottom N so cold code is
  visible.
- **Memory link**: a finding whose text names a symbol (`Foo.bar`, `bar()`)
  gets `symbol:` citations on write, and `code_definition` returns the
  findings that cite it. The Memory graph gains a symbol layer (kind
  `symbol`) drawn only when the `code` module is on and only for the
  selected project, so the graph does not drown.

## Phone

`CodeView` under the project page's band (a fourth cell, "Code", with the
symbol count): a search field (phren's own), a file outline list
(`sessionCard()` rows: name, kind chip, signature caption, usage count
trailing), tap a symbol for its dossier (definition snippet in the diff
view's monospace, references list, findings that cite it, last change).
No editor. Ids `code-search`, `code-row:<id>`, `code-dossier`.

## Stages

1. **Indexer and store** (`packages/cli/src/code/`): grammars, parser,
   SQLite schema, incremental index, `phren code index|status`, unit tests
   on fixture projects in each language. Measured targets above.
2. **Tools and CLI**: the five MCP tools and CLI subcommands, the `code`
   module manifest and skill, docs/api-reference.md rows, tool-count test.
3. **Hook routes and phone**: the routes, the git-watcher re-index,
   `CodeView`, the project page cell, the Memory graph symbol layer.
4. **Memory link**: symbol citations on findings, and `code_definition`
   returning them.

Each stage is one worker; stage 1 must land before 2, stages 3 and 4 can
run in parallel after 2.

## Implementation notes

Stage 1 shipped `packages/cli/src/code/` as `languages.ts` (extension map and
per-language symbol queries), `parser.ts` (one `web-tree-sitter` init, grammar
loader, query, references, line fallback), `store.ts` (sql.js-fts5 schema and
upsert), `indexer.ts` (`git ls-files` walk, hash, parse, reference resolution,
blame) and `status.ts`. Deviations from this document, and the reasons:

- **Grammars.** Nine grammars ship as `.wasm` under `packages/cli/grammars/`
  (TypeScript, TSX, JavaScript, Swift, Python, Rust, Go, Ruby, Bash). Sources,
  versions and sha256 sums are recorded in `packages/cli/grammars/README.md`.
  The document also names JSON and Markdown-heading grammars; stage 1 leaves
  them on the line fallback. No outline gap, since the fallback still runs.
- **Blame granularity.** `blame(file, line, author_hash, at)` stores the last
  commit that touched the file at each symbol's start line, not a per-line
  `git blame`. One file-level lookup per changed file (or one `git log` walk
  for a cold index) replaces a `git blame` subprocess per file, which is what
  lets a cold index of a real repository finish. The author is `sha256("Name
  <email>")`; the name and address never reach the database.
- **Reference resolution.** A reference resolves only when exactly one symbol
  owns the name: one same-file definition, or one project-wide definition when
  the file has none. A name that several definitions share (a local variable, a
  common helper) is ambiguous and is skipped rather than attributed to every
  match. `references(symbol_id, file, line, kind)` holds resolved edges only,
  which is what usage counts read.
- **File rows.** `files.mtime` is recorded but the content hash decides
  re-parsing, so a same-mtime edit cannot hide a change. `--full` re-parses
  every tracked file.
- **Repository selection.** `phren code index <project>` uses the project's
  registered source path. A `--repo <path>` (`--path` alias) flag overrides
  it, which is how the index is run against a worktree whose project points at
  a different checkout. `phren code status` accepts `--top <n>`.
- **Storage.** The database lives in `.runtime/code/`, never in the synced
  store. `openCodeDatabase` caches the sql.js module per process so the
  incremental path stays inside its budget. The FTS5 table is `symbols_fts`,
  over `name`, `signature` and `doc`, with rowids matching `symbols.id`.

Measured: a synthetic 100k-line TypeScript project indexes cold in about two
seconds (well under the 20 s target), and re-indexing one changed file stays
under the 200 ms target. The gated test is
`packages/cli/src/code/indexer.perf.test.ts`, run with `PHREN_PERF=1`.

Stage 2 shipped the read side on top of that store. Where this document
specified less than the implementation needed, the choices were:

- **Queries.** `packages/cli/src/code/query.ts` opens the project database per
  call (read-only, `create = false`) and every function takes `store, project`
  first, matching `codeIndexStatus`. Search runs one SQL pass that unions an
  exact/prefix name match with an FTS5 `MATCH`, then ranks in JavaScript by
  exact, prefix, bm25 and usage. FTS terms are rewritten to prefix queries
  (`name*`), and name matching is case-insensitive; a query with no usable
  tokens still matches by name.
- **Name resolution.** `parseSymbolQuery` strips a trailing `()` and splits a
  dotted `Foo.bar` into container and name. `pickSymbol` then prefers an
  exported symbol, then a non-variable kind, then the most-used, then file
  order, and reports how many candidates shared the name. `Foo.bar` narrows to
  symbols whose stored `parent` is `Foo`.
- **Definition snippets.** Definition needs a source checkout, but an index
  built with `--repo` against an unregistered worktree would otherwise have
  none. A `meta(key, value)` side table records `repo_root` at index time, and
  the query reads the snippet (at most 40 lines) from there, falling back to the
  project's registered source path.
- **Results.** The five MCP tools return compact text, one `path:line kind name
  signature` line per hit with the doc appended, not a JSON envelope. Local
  variables (`kind = 'variable'`) and names under three characters are excluded
  from the hot usage list, so a one-letter loop counter or a busy one-function
  local cannot dominate it; the cold list keeps every symbol.
- **CLI and skill.** `phren code search|outline|refs|def|usage` live on the same
  module gate as `index|status`, and `starter/global/skills/code/SKILL.md`
  points agents at the tools before grep and at `path:line` citations.
  `code_outline` takes the project-relative path the index stores.

Stage 4 shipped the memory link in `packages/cli/src/code/citations.ts`. Where
this document specified less than the implementation needed:

- **Auto-attach is a write-path step, not a content step.** The code index opens
  through sql.js, which is asynchronous, while `addFindingToFile` holds a
  synchronous file lock. The scan therefore runs in the async `add_finding`
  handler before the write: `symbolCitationForFinding` opens the project index
  read-only, walks the finding's identifier-shaped tokens in order, and returns
  the first that `pickSymbol` resolves to exactly one declaration. It requires a
  name of four or more characters and a non-variable kind unless the symbol is
  exported. `addFindingToFile` then stores the citation; it never touches the
  finding text.
- **Explicit symbols are stored, not rejected.** An explicit `symbol:` citation
  is resolved against the index. A hit is stored as given; a miss is stored with
  `symbol_unresolved: true`, mirroring how an invalid file citation is kept and
  later flagged. `validateFindingCitation` returns false for an unresolved
  symbol, so the trust filter queues it as `invalid_citation`. With no index at
  all there is nothing to validate against, so an explicit symbol is stored
  unchanged and nothing is auto-attached.
- **Reading the citing findings.** `code_definition` and `phren code def` append
  a `Findings` block after the snippet: one line per finding, its `L<n>|fid` and
  the first 160 characters of its text. The scan goes through the existing
  finding parser: `readFindings` for FINDINGS.md, and `parseFindingsContent`
  (extracted from `readFindings`) over `reference/topics/*.md` via
  `listTopicFiles`, so archived findings are found without a second markdown
  parser. A citation matches a query when the parsed names are equal and, if
  both sides carry a container, the containers are equal, so `Point.length`
  matches `length()` and vice versa.
- **Read surfaces.** `get_findings` adds a top-level `symbol` per finding and a
  `symbol=` tag in its text output; `search_knowledge` adds `symbol`/`symbols`
  by scanning a findings doc's citation comments, since its snippet may not
  include the citation line.
