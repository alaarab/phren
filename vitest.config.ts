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
      "experimental/agent/src/**/*.test.ts",
      "packages/vscode/test/**/*.test.ts",
    ],
  },
});
