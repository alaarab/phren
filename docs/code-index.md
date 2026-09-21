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
