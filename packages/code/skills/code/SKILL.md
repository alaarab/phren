---
name: code
description: Answer questions about a project's functions, types and variables from its code index instead of grepping, using code_definition, code_references, code_outline, code_search and code_usage, and cite them as path:line.
---
# /code

The `code` module keeps an index per project of its functions, methods, types (classes, structs, enums, interfaces) and variables: where each is defined, where it is used, each file's outline, ranked search and how often each is used. Reach for it when a question is about a function or type (where it is defined, who calls it, what a file contains) rather than about raw text. It is faster and more precise than grep, and it never needs the whole file in context.

## Before you query

1. Check the index: `phren code status <project>`. If it says `Index not built`, run `phren code index <project>` first. Add `--repo <path>` when the project points at a different checkout.
2. Enable the module if the tools are missing: `phren modules enable code`, then restart the agent. The tools are `code_search`, `code_definition`, `code_references`, `code_outline` and `code_usage` (full profile).

## Which tool

- `code_definition(project, name)` for "where is this defined". It accepts `Foo`, `Foo.bar` and `bar()` and returns the file, lines, signature, doc, a source snippet, the last change and the Phren findings linked to it. Prefer this over grep.
- `code_references(project, name)` for "who uses this". It returns every resolved use grouped by file and a candidate count when the name is ambiguous. Prefer this over grep.
- `code_outline(project, path)` for a file's structure. Use it before reading a large file; it lists functions, types and variables in source order, methods nested under their class.
- `code_search(project, query, kind?)` when you know part of a name or some words from its doc, not its exact spelling.
- `code_usage(project, top?)` for the most used and least used functions and types, both ends.

The same operations exist on the CLI: `phren code def`, `phren code refs`, `phren code outline`, `phren code search`, `phren code usage`. Each takes the project first, then the name, path or query.

To remember something about a function or type, save a finding with `add_finding` and `citation: { name: "Foo.bar" }`; `code_definition` shows it to the next agent that looks the function up.

## How to report

- Cite a function or type as `path:line`, for example `packages/cli/src/code/query.ts:120`.
- Include the kind and signature when it helps, but do not paste whole files; use the snippet the tool returns.
- When the index reports a candidate count above one, say which candidate you chose and why (exported and non-variable wins).
- If a name is genuinely absent, say the index has no match rather than guessing; grep for a string that is not a declared name.
