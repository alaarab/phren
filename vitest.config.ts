import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // The `vscode` module is only available inside the Extension Host at
      // runtime; alias it to a lightweight stub so extension units can be
      // unit-tested under vitest.
      vscode: path.resolve(dirname, "packages/vscode/test/vscode-stub.ts"),
    },
  },
  test: {
    globalSetup: ["./packages/cli/src/test-global-setup.ts"],
    pool: "forks",
    fileParallelism: true,
    testTimeout: 15000,
    include: [
      "packages/cli/src/**/*.test.ts",
      "packages/vscode/test/**/*.test.ts",
      // experimental/agent is a private, unshipped R&D package (21.4K LOC,
      // 3 commits in 3.5 months) — its 331 tests are intentionally excluded
      // from the default `pnpm test` run. Its own vitest.config.ts still
      // covers it: run `pnpm --filter @phren/agent test` on demand, or see
      // experimental/agent/README.md.
    ],
  },
});
