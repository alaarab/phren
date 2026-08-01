# @phren/agent (experimental)

Experimental coding agent. **Not part of the shipped phren product** — source
kept here for local iteration only. Low activity (see git history); do not
assume this is maintained at the same bar as `packages/cli`.

## Running this package

`experimental/agent` is a real pnpm workspace member (so `--filter` works),
but it is intentionally excluded from the repo's default `build` and `test`
scripts:

- `pnpm build` (root) builds `packages/*` only, not this package.
- `pnpm test` (root) runs `packages/cli` and `packages/vscode` tests only —
  this package's 300+ tests are not part of that run.

To build or test this package on demand:

```bash
pnpm --filter @phren/agent build
pnpm --filter @phren/agent test
```

Tests use their own `vitest.config.ts` in this directory, scoped to
`src/**/*.test.ts` — it does not depend on `packages/cli`'s build output or
the workspace-root globalSetup.
