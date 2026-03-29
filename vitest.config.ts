import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./packages/cli/src/test-global-setup.ts"],
    pool: "forks",
    fileParallelism: true,
    testTimeout: 15000,
    include: [
      "packages/cli/src/**/*.test.ts",
      "packages/agent/src/**/*.test.ts",
    ],
  },
});
