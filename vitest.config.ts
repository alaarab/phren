import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@phren/cli/code-host/content/summarize": path.resolve(dirname, "packages/cli/src/content/summarize.ts"),
      "@phren/cli/code-host/data/access": path.resolve(dirname, "packages/cli/src/data/access.ts"),
      "@phren/cli/code-host/shared/sqljs": path.resolve(dirname, "packages/cli/src/shared/sqljs.ts"),
      "@phren/cli/code-host/utils-paths": path.resolve(dirname, "packages/cli/src/utils-paths.ts"),
      "@phren/cli/code-host/index-query": path.resolve(dirname, "packages/cli/src/index-query.ts"),
      "@phren/cli/code-host/logger": path.resolve(dirname, "packages/cli/src/logger.ts"),
      "@phren/cli/code-host/governance/locks": path.resolve(dirname, "packages/cli/src/governance/locks.ts"),
      "@phren/cli/code-host/utils": path.resolve(dirname, "packages/cli/src/utils.ts"),
      "@phren/cli/code-host/phren-paths": path.resolve(dirname, "packages/cli/src/phren-paths.ts"),
      "@phren/cli/code-host/project-config": path.resolve(dirname, "packages/cli/src/project-config.ts"),
      "@phren/code": path.resolve(dirname, "packages/code/src/index.ts"),
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
    // A developer or CI machine with tmux installed must not turn every
    // "no Herdr running" test into a tmux one; tmux tests opt back in.
    env: { PHREN_TMUX: "off" },
    include: [
      "packages/cli/src/**/*.test.ts",
      "packages/code/src/**/*.test.ts",
      "packages/push-relay/src/**/*.test.ts",
      "packages/vscode/test/**/*.test.ts",
      // experimental/agent is a private, unshipped R&D package (21.4K LOC,
      // 3 commits in 3.5 months) — its 331 tests are intentionally excluded
      // from the default `pnpm test` run. Its own vitest.config.ts still
      // covers it: run `pnpm --filter @phren/agent test` on demand, or see
      // experimental/agent/README.md.
    ],
  },
});
