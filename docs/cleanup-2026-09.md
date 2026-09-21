# Cleanup audit, September 21

Measured on main at 85f92f73 and after. Numbers are from the tree, not
estimates.

| What | Size |
|---|---|
| CLI source (`packages/cli/src`, no tests) | 80,548 lines |
| CLI tests | 52,257 lines |
| iOS app and packages (no tests) | 53,112 lines |
| Phone Hook bundle (`bridge-hook.mjs`) | 1.5 MB shipped, 2.7 MB of inputs |
| vitest, whole CLI | 223 files, 169 s of test time |

## Ranked findings

1. **The phone Hook bundles the whole CLI.** One import chain,
   `bridge/enroll.ts -> core/project.ts -> init/setup.ts`, pulls `phren init`
   (67 KB), the agent hooks installer, project topics, governance policy,
   `link/doctor` and the FTS indexer into a process that only serves the
   phone. A second chain, `bridge/server.ts -> shared.ts -> proactivity.ts ->
   governance/policy.ts`, does the same for governance. About 40 percent of
   the bundle is CLI code the Hook never runs, and it is why the Hook once
   needed `sql.js-fts5` at startup. Fix: `enroll.ts` should call the small
   pieces it needs (`addProjectFromPath`'s registry write, `runBestEffortGit`)
   through a narrow module that does not import `init`, and `shared.ts`'s
   proactivity import should be lazy. Target: bundle under 1 MB, no
   `sql.js` or `glob` in the graph. Verify with the esbuild metafile.
2. **`ui/scripts.ts` is 3,137 lines of browser JavaScript inside template
   strings.** It is untestable, unlinted and un-typed. Move it to real `.js`
   files under `packages/cli/browser/ui/` bundled by `scripts/build.mjs` the
   way the graph viewer already is.
3. **Duplicated helpers.** `runGit` is defined three times (`status.ts`,
   `utils-helpers.ts`, `cli/extract.ts`), `sessionsDir` and `homeDir` three
   times each, `atomic` three times in `bridge/`, `stripBid` and
   `stripBulletPrefix` twice (`finding/context.ts`, `data/tasks.ts`),
   `tokenize` three times, `resolveProjectStorePath`, `resolveEntryScript`
   and `writeLastSummary` twice. The credential-prompt bug this morning was
   possible only because `runGit` had copies that did not get the fix.
   One definition each, in `utils-helpers.ts`, `phren-paths.ts`,
   `bridge/protocol.ts` and `data/tasks.ts`.
4. **89 `legacy`, `TODO` or `deprecated` markers in the CLI**, concentrated in
   `init/init.ts` (14), `project-topics.ts` (12), `content/metadata.ts` (8),
   `auth/profiles.ts` (8), `modules/runtime.ts` (7). Each is a migration
   path for a store layout older than 0.2.10. Decide a floor version, drop
   the paths below it, and say so in the changelog.
5. **Two test files are 45 percent of the suite's time.** `bridge/bridge.test.ts`
   (42.7 s) and `cli.test.ts` (32.8 s) both start real processes per test.
   Share one Hook process per file for the read-only cases and one
   initialized store for the CLI cases.
6. **The four biggest SwiftUI views hold their whole screen's state.**
   `AgentChatView` (1,572 lines, 53 `@State`), `LiveSessionsView` (1,227,
   30), `ProjectsView` (838, 17), `TasksView` (792, 20). Each should split
   into a model object plus subviews the way `AgentChatModel` already began;
   the compiler-timeout incidents today all came from these files.
7. **`shared/index.ts` (2,088 lines)** mixes the FTS indexer, file
   classification, `@import` resolution and project detection. Split by
   concern; `detectProject` in particular is imported by the Hook for one
   call.

## Not worth touching

- `zod`, `js-yaml` and `glob` in the bundle are real dependencies of code
  the Hook uses; they only leave with finding 1.
- The starter templates and skills are content, not code.

## Order

Findings 3 and 5 are safe and mechanical: first. Finding 1 is the biggest
win and needs the esbuild metafile as its gate. Findings 2, 6 and 7 are
larger refactors; one worker each, one file family each, tests as the gate.
Finding 4 needs the floor-version decision from the owner first.
