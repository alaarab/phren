import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./mcp/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "coverage/playwright/report" }]],
  outputDir: "coverage/playwright/test-results",
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1440, height: 1100 },
  },
});
