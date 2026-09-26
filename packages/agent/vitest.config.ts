import { defineConfig } from "vitest/config";

// Scoped config for the @phren/agent package, excluded from the workspace
// root's default `pnpm test` (see ../../vitest.config.ts). Run this
// package's tests on demand with `pnpm --filter @phren/agent test`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
  },
});
