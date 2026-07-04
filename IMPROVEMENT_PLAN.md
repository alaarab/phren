# Phren — Improvement Plan

Audit date: 2026-07-04. Scope: full-repo review of code health, CI, tests, docs, and security.

## Where the repo stands

Excellent shape overall: strict TypeScript, 147 test files against 315 source files (including adversarial FTS5, chaos-fault, concurrency, and RBAC suites), a 3-OS × 2-Node CI matrix, a SECURITY.md whose threat list maps to real tests, and best-in-class docs (whitepaper, llms.txt, 123 KB maintained CHANGELOG). The 54 MCP tools are already cleanly modularized under `packages/cli/src/tools/` — `index.ts` is only ~308 lines and needs no splitting. The real gaps are the VS Code extension's test coverage, two very large UI files, and an unresolved decision about `experimental/agent`.

## P0 — Coverage & structure

1. **Close the VS Code test gap.** `packages/vscode` has 30 source files and exactly **1 test** (`test/PhrenActivityProvider.test.ts`), leaving `graphWebview.ts` (2033 lines) and `providers/tree-data.ts` (1279) essentially untested — the biggest coverage hole in an otherwise well-tested repo. Start with tree-data (pure-ish logic, easy to unit test), then extract testable state/graph-layout logic out of the webview.
2. **Split the two oversized UI files:**
   - `packages/cli/src/ui/scripts.ts` (2570 lines) — client-side script served by the web UI; split by feature (graph, search, review queue) and let the build concatenate.
   - `packages/vscode/src/graphWebview.ts` (2033 lines) — separate webview HTML/CSS scaffolding, message protocol, and graph logic. Do this together with item 1 so the extraction gets tests.

## P1 — Decisions & hardening

3. **Decide the fate of `experimental/agent`.** ~14k LOC / 99 files of private, unpublished agent code carried in the pnpm workspace and CI (18 test files run on every 6-way matrix build). Pick one: (a) spin out to its own repo, (b) publish/graduate it with a roadmap note, or (c) keep but exclude from the CI matrix (test on one OS only) to cut CI cost. Doing nothing means paying 6× CI for code that ships to no one.
4. **Add a dependency-audit gate to CI.** Vulnerability patching is currently reactive (Dependabot + manual commits). Add `pnpm audit --audit-level=high` (or osv-scanner) as a hard CI job — atlas and the intranet repo both already gate on audit; match them.
5. **Promote `noExplicitAny` from warn to error** in Biome and burn down remaining casts.

## P2 — Consistency & polish

6. **Reconcile the stale root version.** Root `package.json` says `0.1.18` while `@phren/cli` is `0.1.34`. Either sync it or mark the root package `"private": true` with a comment that versioning lives in `packages/cli`.
7. **Secondary decomposition targets** (opportunistic, when touched): `packages/cli/browser/memory-ui-graph-app.ts` (2168), `src/init/setup.ts` (1587), `src/shared/index.ts` (1572 — the FTS5 indexer), `src/ui/server.ts` (1394), `src/project-topics.ts` (1186), `src/hooks.ts` (1097).
8. **Enable the Biome formatter or fold Prettier into CI** — today Prettier exists via `.prettierrc` but formatting isn't enforced in the lint job.

## Quick wins (one sitting)

- Root version/private-flag fix.
- CI audit job.
- First tree-data unit tests (the provider logic is mockable with fixture findings).

## Verification

- `pnpm build && pnpm test && pnpm lint` green across the matrix.
- Coverage for `packages/vscode` visibly rises (add a coverage report to the vitest run if not present).
- If agent is excluded from the matrix: full suite still runs on ubuntu+node22; matrix time drops measurably.
