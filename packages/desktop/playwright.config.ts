import { defineConfig } from "@playwright/test";

// The desktop daemon's own smoke test: a fake Hook and the real daemon, in
// process, driven through a headless browser.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: [["list"]],
  outputDir: "../../coverage/desktop-playwright",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
