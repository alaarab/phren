import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./packages/cli/e2e",
  // Underscore-prefixed specs are local visual/dev harnesses (e.g. _shots.spec.ts,
  // which captures screenshots against a sandbox browser). They are kept in the
  // tree for hands-on iteration but excluded from normal/CI runs — invoke them
  // explicitly with a config that doesn't set this ignore.
  testIgnore: ["**/_*.spec.ts"],
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
