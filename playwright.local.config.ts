import * as fs from "node:fs";
import { defineConfig } from "@playwright/test";

// Local/sandbox Playwright config — NOT used by CI (CI uses playwright.config.ts).
//
// Differences from the CI config:
// - No `testIgnore`, so the underscore-prefixed local harnesses run too
//   (`_shots.spec.ts` captures web-ui screenshots; `_vscode_shots.spec.ts`
//   drives the real VS Code webview HTML rendered by
//   packages/vscode/scratch/render-webview.mjs).
// - A 90s timeout: software-GL environments render slowly and the heaviest
//   interaction test needs ~55s there.
// - Uses a pre-installed Chromium when the pinned Playwright browser build
//   isn't downloaded: set PW_CHROMIUM=/path/to/chrome, or let it auto-detect
//   the sandbox install under /opt/pw-browsers.
//
// Usage:
//   npx playwright test --config playwright.local.config.ts graph.spec.ts
//   SHOT_DIR=/tmp/shots npx playwright test --config playwright.local.config.ts _shots.spec.ts

function detectChromium(): string | undefined {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  try {
    for (const dir of fs.readdirSync("/opt/pw-browsers")) {
      if (!dir.startsWith("chromium-")) continue;
      const candidate = `/opt/pw-browsers/${dir}/chrome-linux/chrome`;
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No sandbox install — fall through to Playwright's own browser.
  }
  return undefined;
}

const executablePath = detectChromium();

export default defineConfig({
  testDir: "./packages/cli/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
  outputDir: "coverage/playwright/test-results",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1100 },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
