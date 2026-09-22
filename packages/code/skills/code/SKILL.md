---
name: code
description: Answer symbol questions from a project's code index instead of grepping, using code_definition, code_references, code_outline, code_search and code_usage, and cite symbols as path:line.
---
# /code

The `code` module keeps a symbol index per project: definitions, references, outlines, ranked search and usage counts. Reach for it when a question is about a symbol (where a function is defined, who calls it, what a file contains) rather than about raw text. It is faster and more precise than grep, and it never needs the whole file in context.

## Before you query

1. Check the index: `phren code status <project>`. If it says `Index not built`, run `phren code index <project>` first. Add `--repo <path>` when the project points at a different checkout.
2. Enable the module if the tools are missing: `phren modules enable code`, then restart the agent. The tools are `code_search`, `code_definition`, `code_references`, `code_outline` and `code_usage` (full profile).

## Which tool

- `code_definition(project, symbol)` for "where is this defined". It accepts `Foo`, `Foo.bar` and `bar()` and returns the file, lines, signature, doc, a source snippet and the last change. Prefer this over grep.
- `code_references(project, symbol)` for "who uses this". It returns resolved references grouped by file and a candidate count when the name is ambiguous. Prefer this over grep.
- `code_outline(project, path)` for a file's structure. Use it before reading a large file; it lists symbols in source order nested under their class.
- `code_search(project, query, kind?)` when you know part of a name or some words from its doc, not its exact spelling.
- `code_usage(project, top?)` for hot and cold symbols, both ends.

The same operations exist on the CLI: `phren code def`, `phren code refs`, `phren code outline`, `phren code search`, `phren code usage`. Each takes the project first, then the symbol, path or query.

## How to report

- Cite a symbol as `path:line`, for example `packages/cli/src/code/query.ts:120`.
- Include the kind and signature when it helps, but do not paste whole files; use the snippet the tool returns.
- When the index reports a candidate count above one, say which candidate you chose and why (exported and non-variable wins).
- If a symbol is genuinely absent, say the index has no match rather than guessing; grep for a string that is not a symbol.
