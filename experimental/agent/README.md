# @phren/agent (experimental)

Experimental coding agent. **Not part of the shipped phren product** — source
kept here for local iteration only. Low activity (see git history); do not
assume this is maintained at the same bar as `packages/cli`.

## Running this package

`experimental/agent` is a pnpm workspace member, built by the root
`pnpm build` and tested in CI by its own `agent-test` job:

- `pnpm build` (root) includes this package.
- `pnpm test` (root) still runs only `packages/cli` and `packages/vscode`
  tests — this package's suite runs separately (its own `vitest.config.ts`,
  no workspace-root globalSetup) and is kept off the CI OS×node matrix.

To build, test, or lint this package on demand:

```bash
pnpm exec turbo run test --filter=@phren/agent   # builds @phren/cli dist first
pnpm --filter @phren/agent build
pnpm --filter @phren/agent lint
```

Note: the test suite imports `@phren/cli` subpath exports that resolve to
`packages/cli/dist/`, so a bare `pnpm --filter @phren/agent test` on a clean
checkout fails until the CLI is built — prefer the turbo invocation.

## Phren Hook / iPhone chat

When phren-agent runs inside a Herdr pane (`HERDR_ENV=1`), it reports
`SessionStart`, `UserPromptSubmit` and `Stop` to the installed Phren Hook
bundle (`~/.local/share/phren/bridge/current/bridge-hook.mjs hook phren`, see
`src/herdr-hooks.ts`) so the iPhone can bind the pane to this session's
`.runtime/sessions/session-<id>.events.jsonl`. Everything on Phren's side is in
place; the pane shows up as a chat once Herdr reports `phren` as an agent kind
(Herdr adds agents in its own releases — see the draft request in the project
notes). Without Herdr the hook calls are silent no-ops.

## Splash

Interactive sessions (`phren-agent -i`, `--multi`, `--team`) open with the
phren splash — mascot plus the wordmark text effect — using the CLI's
`@phren/cli/shell/intro` export, with the provider and model in the tagline.
Set `PHREN_INTRO=off` to skip it.
