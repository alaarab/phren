import { defineConfig } from "@playwright/test";

// Not part of the e2e run: captures the screenshots and GIFs on docs/desktop.html
// into docs/apps/desktop (`pnpm --filter @phren/desktop docs:capture`; needs ffmpeg).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "docs-capture.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [["list"]],
  outputDir: "../../coverage/desktop-docs/test-results",
  use: { browserName: "chromium", headless: true },
});
