import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./mcp/src/test-global-setup.ts"],
    pool: "forks",
    fileParallelism: true,
    testTimeout: 15000,
    include: ["mcp/src/**/*.test.ts", "agent/src/**/*.test.ts"],
  },
});
