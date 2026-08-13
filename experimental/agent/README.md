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
